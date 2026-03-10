import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { InstanceManager } from "./instances/manager.js";
import { LlmClient } from "./llm/client.js";
import { initDb } from "./instances/store.js";
import { UserStore } from "./auth/store.js";
import { getSessionSecret } from "./auth/session.js";
import { authMiddleware } from "./auth/middleware.js";
import { authRoutes } from "./api/auth.js";
import { instanceRoutes } from "./api/instances.js";
import { sessionRoutes } from "./api/sessions.js";
import { configRoutes } from "./api/config.js";
import { securityRoutes } from "./api/security.js";
import { toolRoutes } from "./api/tools.js";
import { operationRoutes } from "./api/operations.js";
import { settingsRoutes } from "./api/settings.js";
import { digestRoutes } from "./api/digest.js";
import { monitoringRoutes } from "./api/monitoring.js";
import { hostRoutes } from "./api/hosts.js";
import { lifecycleRoutes } from "./api/lifecycle.js";
import { assistantRoutes } from "./api/assistant.js";
import { HostStore } from "./hosts/store.js";
import { discoverRemoteInstances } from "./hosts/discovery.js";
import { ensureTunnel, closeAllTunnels } from "./hosts/tunnel.js";
import type { LlmConfig } from "./llm/types.js";
import { fetchPricing } from "./pricing/litellm.js";
import { seedTemplates } from "./skills/templates-seed.js";

const db = initDb();
seedTemplates(db);
const manager = new InstanceManager(db);
const llm = new LlmClient();
const userStore = new UserStore(db);
userStore.init();

const hostStore = new HostStore(db, getSessionSecret(db));
hostStore.init();

const sessionSecret = getSessionSecret(db);

// Restore LLM config from settings
const llmRow = db.prepare("SELECT value FROM settings WHERE key = 'llm'").get() as { value: string } | undefined;
if (llmRow) {
  try { llm.configure(JSON.parse(llmRow.value) as LlmConfig); } catch { /* ignore */ }
}

const app = new Hono();
app.use("/api/*", cors({ origin: (origin) => origin || "*", credentials: true }));

// Auth middleware — all /api/* routes except auth endpoints
app.use("/api/*", authMiddleware(sessionSecret));

// Health (no auth needed — handled by middleware exclusion)
app.get("/api/health", (c) => c.json({ status: "ok", instances: manager.getAll().length }));

// Auth routes (login/setup/logout/users)
app.route("/api/auth", authRoutes(userStore, sessionSecret, db));

// Instance routes — reads for all, writes need "instances" permission
app.route("/api/instances", instanceRoutes(manager, db));
app.route("/api/instances", sessionRoutes(manager, llm, db));
app.route("/api/instances", configRoutes(manager));
app.route("/api/instances", securityRoutes(manager, db, llm));

// Tools — reads for all, diagnose needs "tools" write
app.route("/api/tools", toolRoutes(manager, llm));

// Operations — reads for all
app.route("/api/operations", operationRoutes(db));

// Settings — admin only for writes
app.route("/api/settings", settingsRoutes(db, llm));

// Digest — needs "digest" write permission
app.route("/api/digest", digestRoutes(manager, llm, db));

// Monitoring — remote host metrics via SSH
app.route("/api/monitoring", monitoringRoutes(hostStore, manager));

// Remote hosts — admin only
app.route("/api/hosts", hostRoutes(hostStore, manager, db));

// Lifecycle — instance control, install, config, logs
app.route("/api/lifecycle", lifecycleRoutes(hostStore, manager, db));

// AI Assistant — chat with tool calling for config management
app.route("/api/assistant", assistantRoutes(hostStore, manager, llm, db));

// Serve frontend in production
app.use("/*", serveStatic({ root: "../web/dist" }));

const port = parseInt(process.env.CLAWCTL_PORT || "7100");

async function start() {
  // Clear SSH-discovered instances — they'll be re-discovered with fresh tunnels
  db.prepare("DELETE FROM instances WHERE id LIKE 'ssh-%'").run();

  await manager.init().catch((err) => {
    console.warn("Instance auto-discovery warning:", err.message);
  });

  // Auto-scan remote hosts and create SSH tunnels
  const hosts = hostStore.list();
  for (const host of hosts) {
    const cred = hostStore.getDecryptedCredential(host.id);
    if (!cred) continue;
    const credential = host.authMethod === "password"
      ? { password: cred }
      : { privateKey: cred };
    try {
      const connections = await discoverRemoteInstances(host, credential);
      for (const conn of connections) {
        try {
          const remotePort = parseInt(new URL(conn.url.replace("ws://", "http://")).port) || 18789;
          const localPort = await ensureTunnel(host, remotePort, credential);
          conn.url = `ws://127.0.0.1:${localPort}`;
          manager.addInstance(conn);
        } catch (tunnelErr: any) {
          console.warn(`[tunnel] failed for ${conn.label}: ${tunnelErr.message}`);
        }
      }
    } catch (err: any) {
      console.warn(`Remote host ${host.label} scan failed:`, err.message);
    }
  }

  // Register tunnel rebuild handler for SSH instances
  manager.onTunnelRebuild = async (instanceId: string) => {
    const match = instanceId.match(/^ssh-(\d+)-(.+)$/);
    if (!match) return null;
    const hostId = parseInt(match[1]);
    const host = hostStore.list().find((h) => h.id === hostId);
    if (!host) return null;
    const cred = hostStore.getDecryptedCredential(host.id);
    if (!cred) return null;
    const credential = host.authMethod === "password" ? { password: cred } : { privateKey: cred };
    const connections = await discoverRemoteInstances(host, credential);
    const conn = connections.find((c) => c.id === instanceId);
    if (!conn) return null;
    const remotePort = parseInt(new URL(conn.url.replace("ws://", "http://")).port) || 18789;
    const localPort = await ensureTunnel(host, remotePort, credential);
    return `ws://127.0.0.1:${localPort}`;
  };

  manager.startAutoRefresh();

  // Pre-fetch LiteLLM pricing data in background (1h cache)
  fetchPricing().then((p) => console.log(`Loaded pricing for ${Object.keys(p).length} models`)).catch(() => {});

  const needsSetup = !userStore.hasAnyUser();
  console.log(`ClawCtl starting on http://localhost:${port}`);
  console.log(`Discovered ${manager.getAll().length} instance(s)`);
  if (needsSetup) {
    console.log("First run — open browser to create admin account");
  }
  const server = serve({ fetch: app.fetch, port });

  // Graceful shutdown — close tunnels and WebSocket connections so process can exit
  function shutdown() {
    console.log("Shutting down...");
    // Force exit after 3s if cleanup hangs
    setTimeout(() => process.exit(1), 3_000).unref();
    manager.shutdown();
    closeAllTunnels();
    server.close();
    process.exit(0);
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start();
