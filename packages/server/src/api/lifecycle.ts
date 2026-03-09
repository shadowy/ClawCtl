import { Hono } from "hono";
import { stream } from "hono/streaming";
import type Database from "better-sqlite3";
import type { HostStore } from "../hosts/store.js";
import type { InstanceManager } from "../instances/manager.js";
import { requireWrite } from "../auth/middleware.js";
import { auditLog } from "../audit.js";
import { getExecutor, getHostExecutor } from "../executor/factory.js";
import { getProcessStatus, stopProcess, startProcess, restartProcess } from "../lifecycle/service.js";
import { checkNodeVersion, getVersions, streamInstall, streamUninstall, streamChannelCreate } from "../lifecycle/install.js";
import { readRemoteConfig, writeRemoteConfig, readAuthProfiles, writeAuthProfiles, getConfigDir, profileFromInstanceId } from "../lifecycle/config.js";
import { SnapshotStore } from "../lifecycle/snapshot.js";
import { extractModels, mergeAgentConfig, removeAgent } from "../lifecycle/agent-config.js";
import { mergeChannelAccountConfig, deleteChannelConfig } from "../lifecycle/channel-config.js";
import { getOAuthStatus, clearOAuthFlow } from "../llm/openai-oauth.js";

const VERSION_CACHE_TTL = 60_000; // 60s
const versionCache = new Map<string, { data: any; time: number }>();

export function lifecycleRoutes(hostStore: HostStore, manager: InstanceManager, db: Database.Database) {
  const app = new Hono();
  const snapshots = new SnapshotStore(db);
  snapshots.init();

  // All lifecycle writes require "lifecycle" permission (admin + operator, not auditor)
  app.use("*", requireWrite("lifecycle"));

  // --- Service control ---

  app.get("/:id/status", async (c) => {
    const id = c.req.param("id");
    const inst = manager.get(id);
    if (!inst) return c.json({ error: "instance not found" }, 404);

    // WebSocket connection is the most reliable signal
    if (inst.connection.status === "connected") {
      return c.json({ running: true, source: "websocket" });
    }

    // Fallback: try SSH lsof (only useful for local instances or when WS is down)
    try {
      const port = parsePortFromInstance(inst);
      const exec = getExecutor(id, hostStore);
      const status = await getProcessStatus(exec, port);
      return c.json(status);
    } catch {
      return c.json({ running: false });
    }
  });

  app.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    const inst = manager.get(id);
    if (!inst) return c.json({ error: "instance not found" }, 404);
    const port = parsePortFromInstance(inst);
    const exec = getExecutor(id, hostStore);
    const status = await getProcessStatus(exec, port);
    if (!status.running || !status.pid) return c.json({ error: "not running" }, 400);
    try {
      await stopProcess(exec, status.pid);
      auditLog(db, c, "lifecycle.stop", `Stopped PID ${status.pid}`, id);
      return c.json({ ok: true });
    } catch (err: any) {
      auditLog(db, c, "lifecycle.stop", `FAILED to stop PID ${status.pid}: ${err.message}`, id);
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/:id/start", async (c) => {
    const id = c.req.param("id");
    console.log(`[lifecycle] start request for ${id}`);
    const inst = manager.get(id);
    if (!inst) { console.log(`[lifecycle] instance ${id} not found`); return c.json({ error: "instance not found" }, 404); }
    const port = parsePortFromInstance(inst);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    console.log(`[lifecycle] starting ${id}: port=${port}, profile=${profile}, configDir=${configDir}`);
    try {
      await startProcess(exec, configDir, port, profile);
      console.log(`[lifecycle] started ${id} OK`);
      auditLog(db, c, "lifecycle.start", `Started on port ${port}`, id);
      return c.json({ ok: true });
    } catch (err: any) {
      console.error(`[lifecycle] start ${id} FAILED:`, err.message);
      auditLog(db, c, "lifecycle.start", `FAILED to start on port ${port}: ${err.message}`, id);
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/:id/restart", async (c) => {
    const id = c.req.param("id");
    const inst = manager.get(id);
    if (!inst) return c.json({ error: "instance not found" }, 404);
    const port = parsePortFromInstance(inst);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      await restartProcess(exec, configDir, port, profile);
      auditLog(db, c, "lifecycle.restart", `Restarted on port ${port}`, id);
      return c.json({ ok: true });
    } catch (err: any) {
      auditLog(db, c, "lifecycle.restart", `FAILED to restart on port ${port}: ${err.message}`, id);
      return c.json({ error: err.message }, 500);
    }
  });

  // --- Config ---

  app.get("/:id/config-file", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      const config = await readRemoteConfig(exec, configDir);
      return c.json(config);
    } catch (err: any) {
      return c.json({ error: `Failed to read config: ${err.message}` }, 500);
    }
  });

  app.put("/:id/config-file", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    const body = await c.req.json();
    try {
      await writeRemoteConfig(exec, configDir, body);
      auditLog(db, c, "lifecycle.config-write", "Config updated", id);
      return c.json({ ok: true });
    } catch (err: any) {
      auditLog(db, c, "lifecycle.config-write", `FAILED: ${err.message}`, id);
      return c.json({ error: err.message }, 500);
    }
  });

  // --- Agent config (structured) ---

  app.get("/:id/models", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    const config = await readRemoteConfig(exec, configDir);
    return c.json(extractModels(config));
  });

  app.put("/:id/agents", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    const payload = await c.req.json();
    try {
      const config = await readRemoteConfig(exec, configDir);
      const merged = mergeAgentConfig(config, payload);
      await writeRemoteConfig(exec, configDir, merged);
      try { snapshots.create(id, JSON.stringify(merged), "agent config update"); } catch { /* snapshot is best-effort */ }
      auditLog(db, c, "lifecycle.agent-config", "Agent config updated", id);
      return c.json({ ok: true });
    } catch (err: any) {
      auditLog(db, c, "lifecycle.agent-config", `FAILED: ${err.message}`, id);
      return c.json({ error: err.message }, 500);
    }
  });

  app.delete("/:id/agents/:agentId", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    const config = await readRemoteConfig(exec, configDir);
    const agentId = c.req.param("agentId");
    try {
      const updated = removeAgent(config, agentId);
      await writeRemoteConfig(exec, configDir, updated);
      snapshots.create(id, JSON.stringify(updated), "agent config update");
      auditLog(db, c, "lifecycle.agent-delete", `Deleted agent ${agentId}`, id);
      return c.json({ ok: true });
    } catch (err: any) {
      if (err.message.includes("not found")) {
        return c.json({ error: err.message }, 404);
      }
      return c.json({ error: err.message }, 500);
    }
  });

  // --- Channel management ---

  app.get("/:id/channels", async (c) => {
    const id = c.req.param("id");
    const inst = manager.get(id);
    if (!inst) return c.json({ error: "instance not found" }, 404);
    const client = manager.getClient(id);
    if (!client) return c.json({ error: "not connected" }, 502);
    try {
      const details = await client.fetchChannelDetails(false);
      return c.json(details);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/:id/channels/probe", async (c) => {
    const id = c.req.param("id");
    const inst = manager.get(id);
    if (!inst) return c.json({ error: "instance not found" }, 404);
    const client = manager.getClient(id);
    if (!client) return c.json({ error: "not connected" }, 502);
    try {
      const details = await client.fetchChannelDetails(true);
      return c.json(details);
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/:id/channels/logout", async (c) => {
    const id = c.req.param("id");
    const inst = manager.get(id);
    if (!inst) return c.json({ error: "instance not found" }, 404);
    const client = manager.getClient(id);
    if (!client) return c.json({ error: "not connected" }, 502);
    const { channel, accountId } = await c.req.json();
    if (!channel) return c.json({ error: "channel required" }, 400);
    try {
      const result = await client.channelLogout(channel, accountId);
      auditLog(db, c, "lifecycle.channel-logout", `Logout ${channel}/${accountId || "default"}`, id);
      return c.json({ ok: true, ...result });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.put("/:id/channels/config", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    const { channel, accountId, config: update } = await c.req.json();
    if (!channel) return c.json({ error: "channel required" }, 400);
    try {
      const config = await readRemoteConfig(exec, configDir);
      const merged = mergeChannelAccountConfig(config, channel, accountId || "default", update);
      await writeRemoteConfig(exec, configDir, merged);
      try { snapshots.create(id, JSON.stringify(merged), "channel config update"); } catch { /* best-effort */ }
      auditLog(db, c, "lifecycle.channel-config", `Updated ${channel}/${accountId || "default"}`, id);
      return c.json({ ok: true });
    } catch (err: any) {
      if (err.message.includes("not found")) return c.json({ error: err.message }, 404);
      auditLog(db, c, "lifecycle.channel-config", `FAILED: ${err.message}`, id);
      return c.json({ error: err.message }, 500);
    }
  });

  app.delete("/:id/channels/:channel", async (c) => {
    const id = c.req.param("id");
    const channel = c.req.param("channel");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      const config = await readRemoteConfig(exec, configDir);
      const updated = deleteChannelConfig(config, channel);
      await writeRemoteConfig(exec, configDir, updated);
      try { snapshots.create(id, JSON.stringify(updated), `delete channel ${channel}`); } catch { /* best-effort */ }
      // Restart gateway so runtime state reflects the removed channel
      const portR = await exec.exec(
        `grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "${configDir}/openclaw.json" | head -1 | grep -o '[0-9]*$'; true`,
      );
      const port = portR.stdout.trim() || "3010";
      await exec.exec(`pkill -USR1 -f "openclaw.*gateway.*--port[= ]${port}" 2>/dev/null; true`);
      auditLog(db, c, "lifecycle.channel-delete", `Deleted ${channel}`, id);
      return c.json({ ok: true });
    } catch (err: any) {
      if (err.message.includes("not found")) return c.json({ error: err.message }, 404);
      auditLog(db, c, "lifecycle.channel-delete", `FAILED: ${err.message}`, id);
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/:id/channels/create", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    const { channel, account, bindAgentIds } = await c.req.json();

    if (!channel || !account) return c.json({ error: "channel and account required" }, 400);

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");

    return stream(c, async (s) => {
      const emit = async (step: { step: string; status: string; detail?: string }) => {
        await s.write(`data: ${JSON.stringify(step)}\n\n`);
      };

      let success = false;
      try {
        success = await streamChannelCreate(exec, configDir, channel, account, bindAgentIds || [], emit);
      } catch (err: any) {
        await emit({ step: "Error", status: "error", detail: err.message?.slice(0, 300) || "Unknown error" });
      }
      auditLog(db, c, "lifecycle.channel-create", `${success ? "Created" : "Failed"} ${channel}`, id);
      await s.write(`data: ${JSON.stringify({ done: true, success })}\n\n`);
    });
  });

  // --- LLM Provider config (models.providers) ---

  // Well-known provider env vars (subset of OpenClaw's PROVIDER_ENV_VARS)
  const PROVIDER_ENV_CHECK: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GEMINI_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    xai: "XAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    together: "TOGETHER_API_KEY",
  };

  app.get("/:id/providers", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      const config = await readRemoteConfig(exec, configDir);
      const providers = config?.models?.providers || {};
      // Detect auth-profile-based providers (from `openclaw login` / OAuth)
      // + env-var-based providers from the running gateway process
      const envVarList = Object.values(PROVIDER_ENV_CHECK).join(" ");
      const detectCmd = [
        // 1) Auth profiles: scan agent dirs for auth-profiles.json
        `for f in ${configDir}/agents/*/agent/auth-profiles.json; do`,
        `  [ -f "$f" ] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); [print("auth:"+k) for k in d.get("profiles",{}).keys()]' "$f" 2>/dev/null`,
        `done`,
        // 2) Env vars: check gateway process env, fallback to login shell
        `pid=$(pgrep -f 'openclaw.*gateway' 2>/dev/null | head -1)`,
        `if [ -n "$pid" ] && [ -r /proc/$pid/environ ]; then`,
        `  env_data=$(tr '\\0' '\\n' < /proc/$pid/environ)`,
        `  for v in ${envVarList}; do echo "$env_data" | grep -q "^$v=" && echo "env:$v"; done`,
        `else`,
        `  bash -lc 'for v in ${envVarList}; do [ -n "$(printenv $v 2>/dev/null)" ] && echo "env:$v"; done'`,
        `fi`,
      ].join("\n");
      const detectedProviders: { name: string; source: string }[] = [];
      try {
        const r = await exec.exec(detectCmd + "\ntrue"); // ensure exit 0
        if (r.stdout.trim()) {
          const lines = r.stdout.trim().split("\n").map((s: string) => s.trim()).filter(Boolean);
          const seen = new Set<string>();
          for (const line of lines) {
            if (line.startsWith("auth:")) {
              // e.g. "auth:openai-codex:default" → provider "openai"
              const profileKey = line.slice(5); // "openai-codex:default"
              const providerPart = profileKey.split(":")[0]; // "openai-codex"
              const name = providerPart.replace(/-codex$/, "").replace(/-responses$/, "");
              if (!seen.has(name) && !providers[name]) {
                seen.add(name);
                detectedProviders.push({ name, source: `auth profile (${profileKey})` });
              }
            } else if (line.startsWith("env:")) {
              const envVar = line.slice(4);
              for (const [name, ev] of Object.entries(PROVIDER_ENV_CHECK)) {
                if (ev === envVar && !seen.has(name) && !providers[name]) {
                  seen.add(name);
                  detectedProviders.push({ name, source: `env (${envVar})` });
                }
              }
            }
          }
        }
      } catch { /* SSH check failed — skip detection */ }
      return c.json({ providers, detectedProviders });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.put("/:id/providers", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    const { providers } = await c.req.json<{ providers: Record<string, any> }>();
    try {
      const config = await readRemoteConfig(exec, configDir);
      if (!config.models) config.models = {};
      // Extract API keys and write to auth-profiles.json (where OpenClaw reads them)
      const agentList: any[] = config?.agents?.list || [];
      const agentIds = agentList.map((a: any) => a.id);
      if (agentIds.length === 0) agentIds.push("main");

      for (const [providerName, p] of Object.entries(providers) as [string, any][]) {
        if (p && typeof p === "object") {
          delete p._oauthRefreshToken;
          delete p._oauthExpiresAt;
          if (!p.models) p.models = [];
          // Write API key to auth-profiles.json for all agents
          if (p.apiKey && p.auth !== "oauth") {
            for (const agentId of agentIds) {
              const profiles = await readAuthProfiles(exec, configDir, agentId);
              if (!profiles.version) profiles.version = 1;
              if (!profiles.profiles) profiles.profiles = {};
              profiles.profiles[`${providerName}:default`] = {
                type: "api_key",
                provider: providerName,
                key: p.apiKey,
              };
              await writeAuthProfiles(exec, configDir, agentId, profiles);
            }
          }
        }
      }
      // Write provider definitions (baseUrl, models) to openclaw.json — but strip apiKey
      // OpenClaw schema requires both `id` and `name` for each model definition
      const cleanProviders: Record<string, any> = {};
      for (const [name, p] of Object.entries(providers) as [string, any][]) {
        if (p && typeof p === "object") {
          const { apiKey: _, ...rest } = p;
          if (Array.isArray(rest.models)) {
            rest.models = rest.models.map((m: any) => {
              if (m && typeof m === "object" && m.id && !m.name) {
                return { ...m, name: m.id };
              }
              return m;
            });
          }
          cleanProviders[name] = rest;
        }
      }
      config.models.providers = cleanProviders;
      await writeRemoteConfig(exec, configDir, config);
      auditLog(db, c, "lifecycle.providers", "LLM providers updated", id);
      return c.json({ ok: true });
    } catch (err: any) {
      auditLog(db, c, "lifecycle.providers", `FAILED: ${err.message}`, id);
      return c.json({ error: err.message }, 500);
    }
  });

  // Save OAuth tokens to instance's provider config
  // (Reuses global OAuth flow from /settings/oauth/openai/*)
  app.post("/:id/providers/oauth/save", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const status = getOAuthStatus();
    if (status.status !== "complete" || !status.credentials) {
      return c.json({ error: "No completed OAuth credentials" }, 400);
    }
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      // OpenClaw reads API keys from auth-profiles.json, NOT from openclaw.json.
      // Write OAuth token to auth-profiles.json for all agents in this instance.
      const config = await readRemoteConfig(exec, configDir);
      const agentList: any[] = config?.agents?.list || [];
      const agentIds = agentList.map((a: any) => a.id);
      if (agentIds.length === 0) agentIds.push("main"); // fallback

      const oauthProfile = {
        type: "oauth",
        provider: "openai-codex",
        access: status.credentials.accessToken,
        refresh: status.credentials.refreshToken || "",
        expires: status.credentials.expiresAt || 0,
      };

      for (const agentId of agentIds) {
        const profiles = await readAuthProfiles(exec, configDir, agentId);
        if (!profiles.version) profiles.version = 1;
        if (!profiles.profiles) profiles.profiles = {};
        profiles.profiles["openai-codex:default"] = oauthProfile;
        await writeAuthProfiles(exec, configDir, agentId, profiles);
      }

      clearOAuthFlow();
      auditLog(db, c, "lifecycle.providers.oauth", `OpenAI OAuth configured for agents: ${agentIds.join(", ")}`, id);
      return c.json({ ok: true, expiresAt: status.credentials.expiresAt, agents: agentIds });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // --- Available versions (fetched locally, not from remote host) ---

  const availableVersionsCache: { data: any; time: number } = { data: null, time: 0 };

  app.get("/available-versions", async (c) => {
    if (availableVersionsCache.data && Date.now() - availableVersionsCache.time < VERSION_CACHE_TTL) {
      return c.json(availableVersionsCache.data);
    }
    try {
      const res = await fetch("https://registry.npmjs.org/openclaw");
      if (res.ok) {
        const pkg = await res.json() as any;
        const distTags = pkg["dist-tags"] || {};
        // Get all versions, filter to recent stable releases (no pre-release tags)
        const allVersions: string[] = Object.keys(pkg.versions || {});
        const stableVersions = allVersions
          .filter((v) => !v.includes("-"))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          .slice(0, 10);
        const data = { distTags, versions: stableVersions };
        availableVersionsCache.data = data;
        availableVersionsCache.time = Date.now();
        return c.json(data);
      }
    } catch { /* fallback */ }
    // Fallback: use local npm
    const { LocalExec } = await import("../executor/local.js");
    const local = new LocalExec();
    const [tagsR, versR] = await Promise.all([
      local.exec("npm view openclaw dist-tags --json 2>/dev/null"),
      local.exec("npm view openclaw versions --json 2>/dev/null"),
    ]);
    const distTags = tagsR.exitCode === 0 ? JSON.parse(tagsR.stdout.trim()) : {};
    let versions: string[] = [];
    if (versR.exitCode === 0) {
      try {
        const all: string[] = JSON.parse(versR.stdout.trim());
        versions = all.filter((v) => !v.includes("-")).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 10);
      } catch { /* ignore */ }
    }
    const data = { distTags, versions };
    availableVersionsCache.data = data;
    availableVersionsCache.time = Date.now();
    return c.json(data);
  });

  // --- Install/Upgrade (host-level) ---

  app.get("/host/:hostId/versions", async (c) => {
    const hostId = c.req.param("hostId") === "local" ? "local" as const : parseInt(c.req.param("hostId"));
    const cacheKey = String(hostId);
    const cached = versionCache.get(cacheKey);
    if (cached && Date.now() - cached.time < VERSION_CACHE_TTL) {
      return c.json(cached.data);
    }
    const exec = getHostExecutor(hostId, hostStore);
    const [node, versions] = await Promise.all([checkNodeVersion(exec), getVersions(exec)]);
    const data = { node, openclaw: versions };
    versionCache.set(cacheKey, { data, time: Date.now() });
    return c.json(data);
  });

  app.post("/host/:hostId/install", async (c) => {
    const hostId = c.req.param("hostId") === "local" ? "local" as const : parseInt(c.req.param("hostId"));
    const { version } = await c.req.json().catch(() => ({ version: undefined }));
    const exec = getHostExecutor(hostId, hostStore);

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");

    return stream(c, async (s) => {
      const emit = async (step: { step: string; status: string; detail?: string }) => {
        await s.write(`data: ${JSON.stringify(step)}\n\n`);
      };

      let success = false;
      try {
        success = await streamInstall(exec, emit, version);
      } catch (err: any) {
        const detail = err.message?.slice(0, 300) || "Unknown error";
        await emit({ step: "Connection error", status: "error", detail });
      }
      auditLog(db, c, "lifecycle.install", `${success ? "Installed" : "Install failed"} openclaw${version ? `@${version}` : ""}`, String(hostId));
      await s.write(`data: ${JSON.stringify({ done: true, success })}\n\n`);
    });
  });

  // --- Uninstall OpenClaw from a host ---

  app.post("/host/:hostId/uninstall", async (c) => {
    const hostId = c.req.param("hostId") === "local" ? "local" as const : parseInt(c.req.param("hostId"));
    const exec = getHostExecutor(hostId, hostStore);

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");

    return stream(c, async (s) => {
      const emit = async (step: { step: string; status: string; detail?: string }) => {
        await s.write(`data: ${JSON.stringify(step)}\n\n`);
      };

      let success = false;
      try {
        success = await streamUninstall(exec, emit);
      } catch (err: any) {
        const detail = err.message?.slice(0, 300) || "Unknown error";
        await emit({ step: "Connection error", status: "error", detail });
      }
      auditLog(db, c, "lifecycle.uninstall", `${success ? "Uninstalled" : "Uninstall failed"} openclaw`, String(hostId));
      await s.write(`data: ${JSON.stringify({ done: true, success })}\n\n`);
    });
  });

  // --- Initialize gateway on a host where OpenClaw is installed but no gateway running ---

  app.post("/host/:hostId/init-gateway", async (c) => {
    const hostId = c.req.param("hostId") === "local" ? "local" as const : parseInt(c.req.param("hostId"));
    const { port, token, profile } = await c.req.json().catch(() => ({} as any));
    const exec = getHostExecutor(hostId, hostStore);

    // Verify openclaw is installed
    const ver = await exec.exec("openclaw --version 2>/dev/null");
    if (ver.exitCode !== 0 || !ver.stdout.trim()) {
      return c.json({ error: "OpenClaw is not installed on this host" }, 400);
    }

    const gwPort = parseInt(port) || 18789;
    const profileName = profile && profile !== "default" ? profile : undefined;
    const configDir = profileName ? `~/.openclaw-${profileName}` : "~/.openclaw";
    const xdgPrefix = `export XDG_RUNTIME_DIR=/run/user/$(id -u) 2>/dev/null; `;

    // Create minimal config file so discovery can find this instance
    const minimalConfig = JSON.stringify({
      gateway: {
        port: gwPort,
        mode: "local",
        controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
        ...(token ? { auth: { token } } : {}),
      },
    }, null, 2);
    await exec.exec(`mkdir -p ${configDir} && cat > ${configDir}/openclaw.json << 'CLAWCTL_CFG'\n${minimalConfig}\nCLAWCTL_CFG`);

    // Find openclaw binary path
    const whichR = await exec.exec("which openclaw");
    const binPath = whichR.stdout.trim() || "/usr/bin/openclaw";

    // Build the ExecStart command for the service
    const execParts = [binPath];
    if (profile) execParts.push(`--profile ${profile}`);
    execParts.push(`gateway run --port ${gwPort} --bind lan --allow-unconfigured`);
    if (token) execParts.push(`--token '${token.replace(/'/g, "'\\''")}'`);
    const execStart = execParts.join(" ");

    // Determine service name
    const svcSuffix = profile && profile !== "default" ? `-${profile}` : "";
    const svcName = `openclaw-gateway${svcSuffix}.service`;

    // Ensure linger is enabled for systemctl --user to survive logout
    const hasSudo = (await exec.exec("command -v sudo >/dev/null 2>&1 && echo yes")).stdout.trim() === "yes";
    if (hasSudo) {
      const whoami = (await exec.exec("whoami")).stdout.trim();
      await exec.exec(`sudo loginctl enable-linger ${whoami} 2>/dev/null; true`);
    }

    // Create systemd user unit file
    const unitContent = `[Unit]
Description=OpenClaw Gateway${svcSuffix ? ` (${profile})` : ""}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target`;

    // Write unit file first, then run systemd commands separately
    // (heredoc + && in one command causes the delimiter to merge with the next command)
    const writeUnit = `mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/${svcName} << 'CLAWCTL_UNIT'\n${unitContent}\nCLAWCTL_UNIT`;
    await exec.exec(writeUnit);

    const setupCmd = [
      `${xdgPrefix} systemctl --user daemon-reload`,
      `${xdgPrefix} systemctl --user enable ${svcName}`,
      `${xdgPrefix} systemctl --user start ${svcName}`,
    ].join(" && ");

    const installR = await exec.exec(setupCmd, { timeout: 30_000 });
    if (installR.exitCode !== 0) {
      return c.json({ error: `Gateway setup failed: ${(installR.stderr || installR.stdout).slice(0, 300)}` }, 500);
    }

    // Wait for Gateway to fully start (it may rewrite config with auto-generated token)
    await new Promise((r) => setTimeout(r, 3000));
    const check = await exec.exec(`${xdgPrefix} systemctl --user is-active ${svcName} 2>/dev/null`);
    if (check.stdout.trim() !== "active") {
      const log = await exec.exec(`${xdgPrefix} journalctl --user -u ${svcName} -n 10 --no-pager 2>/dev/null`);
      return c.json({ error: `Gateway not active: ${log.stdout.slice(0, 300)}` }, 500);
    }

    // Re-read config to pick up any token the Gateway auto-generated on first boot
    const freshConfig = await exec.exec(`cat ${configDir}/openclaw.json 2>/dev/null`);
    let freshToken: string | undefined;
    try {
      const parsed = JSON.parse(freshConfig.stdout);
      freshToken = parsed?.gateway?.auth?.token;
    } catch { /* keep original token */ }

    // Remove stale instance (registered without token) so rescan picks up the fresh one
    const instanceId = `ssh-${hostId}-${profileName || "default"}`;
    manager.removeInstance(instanceId);

    auditLog(db, c, "lifecycle.init-gateway", `Initialized gateway on host ${hostId} port=${gwPort}`, String(hostId));
    return c.json({ ok: true, version: ver.stdout.trim(), token: freshToken });
  });

  // --- Install status check (for recovery after stream disconnect) ---

  app.get("/host/:hostId/install-status", async (c) => {
    const hostId = c.req.param("hostId") === "local" ? "local" as const : parseInt(c.req.param("hostId"));
    const exec = getHostExecutor(hostId, hostStore);
    try {
      const [verR, procR] = await Promise.all([
        exec.exec("openclaw --version 2>/dev/null"),
        exec.exec("ps aux | grep 'npm.*[i]nstall.*openclaw\\|npm.*[i] .*openclaw' | grep -v grep 2>/dev/null"),
      ]);
      if (verR.exitCode === 0 && verR.stdout.trim()) {
        return c.json({ status: "installed", version: verR.stdout.trim() });
      }
      if (procR.exitCode === 0 && procR.stdout.trim()) {
        return c.json({ status: "installing", detail: procR.stdout.trim().slice(0, 200) });
      }
      return c.json({ status: "not_installed" });
    } catch (err: any) {
      return c.json({ status: "error", detail: err.message }, 500);
    }
  });

  // --- Logs (SSE stream) ---

  app.get("/:id/logs", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    const lines = c.req.query("lines") || "100";

    // Detect the best log source: file first, then journalctl
    const probe = await exec.exec(
      `test -f "${configDir}/gateway.log" && echo "file" || (command -v journalctl >/dev/null 2>&1 && echo "journal" || echo "none")`
    );
    const source = probe.stdout.trim();

    let cmd: string;
    if (source === "file") {
      cmd = `tail -n ${lines} -f "${configDir}/gateway.log"`;
    } else if (source === "journal") {
      // Discover the actual systemd unit name — try both system and user level
      const profileSuffix = profile === "default" ? "" : `-${profile}`;
      const svcName = `openclaw-gateway${profileSuffix}`;
      // Check user-level first (more common for openclaw), then system-level
      const probeJ = await exec.exec(
        `journalctl --user -u ${svcName}.service -n 1 -q --no-pager 2>/dev/null | grep -c .`
      );
      const isUserUnit = parseInt(probeJ.stdout.trim()) > 0;
      if (isUserUnit) {
        cmd = `journalctl --user -u ${svcName}.service -n ${lines} -f -q --no-pager`;
      } else {
        // Try system-level
        const probeS = await exec.exec(
          `journalctl -u ${svcName}.service -n 1 -q --no-pager 2>/dev/null | grep -c .`
        );
        if (parseInt(probeS.stdout.trim()) > 0) {
          cmd = `journalctl -u ${svcName}.service -n ${lines} -f -q --no-pager`;
        } else {
          return c.json({ error: `No journal entries for ${svcName}.service. Try: systemctl --user list-units 'openclaw*'` }, 404);
        }
      }
    } else {
      return c.json({ error: "No log source found (no gateway.log and no journalctl)" }, 404);
    }

    return stream(c, async (s) => {
      await s.write(`data: ${JSON.stringify(`[source: ${source}]`)}\n\n`);
      for await (const chunk of exec.execStream(cmd)) {
        await s.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    });
  });

  // --- Snapshots ---

  app.get("/:id/snapshots", (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    return c.json(snapshots.list(id));
  });

  app.post("/:id/snapshots", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const body = await c.req.json<{ configJson: string; reason?: string }>().catch(() => null);
    if (!body?.configJson) return c.json({ error: "configJson is required" }, 400);
    const snapId = snapshots.create(id, body.configJson, body.reason);
    auditLog(db, c, "lifecycle.snapshot-create", `Created config snapshot #${snapId}${body.reason ? `: ${body.reason}` : ""}`, id);
    return c.json({ id: snapId }, 201);
  });

  app.get("/snapshots/:snapId", (c) => {
    const snap = snapshots.get(parseInt(c.req.param("snapId")));
    if (!snap) return c.json({ error: "snapshot not found" }, 404);
    return c.json(snap);
  });

  app.post("/snapshots/diff", async (c) => {
    const { id1, id2 } = await c.req.json<{ id1: number; id2: number }>();
    if (!id1 || !id2) return c.json({ error: "id1 and id2 are required" }, 400);
    try {
      return c.json(snapshots.diff(id1, id2));
    } catch (err: any) {
      return c.json({ error: err.message }, 404);
    }
  });

  app.post("/:id/snapshots/:snapId/restore", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const snap = snapshots.get(parseInt(c.req.param("snapId")));
    if (!snap) return c.json({ error: "snapshot not found" }, 404);
    if (snap.instance_id !== id) return c.json({ error: "snapshot does not belong to this instance" }, 403);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      const config = JSON.parse(snap.config_json);
      await writeRemoteConfig(exec, configDir, config);
      // Create a new snapshot recording the restore action
      snapshots.create(id, snap.config_json, `restored from snapshot #${snap.id}`);
      auditLog(db, c, "lifecycle.snapshot-restore", `Restored config from snapshot #${snap.id}`, id);
      return c.json({ ok: true });
    } catch (err: any) {
      auditLog(db, c, "lifecycle.snapshot-restore", `FAILED: ${err.message}`, id);
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/:id/snapshots/cleanup", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const body = await c.req.json<{ keepCount?: number }>().catch(() => ({}));
    const deleted = snapshots.cleanup(id, body.keepCount);
    auditLog(db, c, "lifecycle.snapshot-cleanup", `Cleaned up ${deleted} old snapshots`, id);
    return c.json({ deleted });
  });

  // --- Doctor / Repair ---

  app.post("/:id/doctor", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const exec = getExecutor(id, hostStore);

    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");

    return stream(c, async (s) => {
      const emit = async (step: { step: string; status: string; detail?: string }) => {
        await s.write(`data: ${JSON.stringify(step)}\n\n`);
      };

      let success = false;
      try {
        await emit({ step: "Starting doctor", status: "running", detail: "Running openclaw doctor --repair --non-interactive..." });

        // Run openclaw doctor --repair --non-interactive, streaming output line by line
        const profile = profileFromInstanceId(id);
        const profileFlag = profile && profile !== "default" ? ` --profile ${profile}` : "";
        const cmd = `openclaw${profileFlag} doctor --repair --non-interactive 2>&1`;

        let output = "";
        for await (const chunk of exec.execStream(cmd)) {
          output += chunk;
          await emit({ step: "Doctor output", status: "running", detail: chunk.trim() });
        }

        // Check if the output suggests success (no "FAIL" or "error" in final lines)
        const lower = output.toLowerCase();
        success = !lower.includes("fatal") && !lower.includes("error:");
        if (success) {
          await emit({ step: "Doctor complete", status: "ok", detail: "Repair completed successfully" });
        } else {
          await emit({ step: "Doctor complete", status: "error", detail: "Doctor found issues that may need manual attention" });
        }
      } catch (err: any) {
        await emit({ step: "Doctor error", status: "error", detail: err.message?.slice(0, 300) || "Unknown error" });
      }
      auditLog(db, c, "lifecycle.doctor", `${success ? "Doctor repair completed" : "Doctor repair failed"}`, id);
      await s.write(`data: ${JSON.stringify({ done: true, success })}\n\n`);
    });
  });

  // --- Diagnose ---

  app.post("/host/:hostId/diagnose", async (c) => {
    const hostId = c.req.param("hostId") === "local" ? "local" as const : parseInt(c.req.param("hostId"));
    const exec = getHostExecutor(hostId, hostStore);
    const [node, versions, disk] = await Promise.all([
      checkNodeVersion(exec),
      getVersions(exec),
      exec.exec("df -h / 2>/dev/null | tail -1"),
    ]);
    return c.json({ node, openclaw: versions, disk: disk.stdout.trim() });
  });

  return app;
}

function parsePortFromInstance(inst: any): number {
  // Prefer remotePort (original port before SSH tunnel rewrite)
  if (inst.connection.remotePort) return inst.connection.remotePort;
  try {
    const url = new URL(inst.connection.url.replace("ws://", "http://"));
    return parseInt(url.port) || 18789;
  } catch { return 18789; }
}

