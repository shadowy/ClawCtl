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
import { readRemoteConfig, writeRemoteConfig, readAuthProfiles, writeAuthProfiles, deleteAuthProfile, getConfigDir, profileFromInstanceId } from "../lifecycle/config.js";
import { verifyProviderKey, maskKey } from "../lifecycle/verify.js";
import { SnapshotStore } from "../lifecycle/snapshot.js";
import { extractModels, mergeAgentConfig, removeAgent } from "../lifecycle/agent-config.js";
import { mergeChannelAccountConfig, deleteChannelConfig } from "../lifecycle/channel-config.js";
import { getOAuthStatus, clearOAuthFlow } from "../llm/openai-oauth.js";
import { fetchPricing, estimateCost } from "../pricing/litellm.js";
import { fetchCodexQuota, getApiKeyFetcher } from "../pricing/codex-quota.js";

const VERSION_CACHE_TTL = 60_000; // 60s
const versionCache = new Map<string, { data: any; time: number }>();

export function lifecycleRoutes(hostStore: HostStore, manager: InstanceManager, db: Database.Database) {
  const app = new Hono();
  const snapshots = new SnapshotStore(db);
  snapshots.init();

  // All lifecycle writes require "lifecycle" permission (admin + operator, not auditor)
  app.use("*", requireWrite("lifecycle"));

  // --- Pricing data (for frontend display) --- must be before /:id routes
  app.get("/pricing/models", async (c) => {
    try {
      const pricing = await fetchPricing();
      const models: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {};
      for (const [key, val] of Object.entries(pricing)) {
        if (val.input_cost_per_token && val.output_cost_per_token) {
          const m: typeof models[string] = {
            input: val.input_cost_per_token * 1_000_000,
            output: val.output_cost_per_token * 1_000_000,
          };
          if (val.cache_read_input_token_cost) m.cacheRead = val.cache_read_input_token_cost * 1_000_000;
          if (val.cache_creation_input_token_cost) m.cacheWrite = val.cache_creation_input_token_cost * 1_000_000;
          models[key] = m;
        }
      }
      return c.json({ models, count: Object.keys(models).length });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

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

  // SSE-based process action with phased progress
  app.post("/:id/process-action", async (c) => {
    const id = c.req.param("id");
    const inst = manager.get(id);
    if (!inst) return c.json({ error: "instance not found" }, 404);

    let body: { action?: string } = {};
    try { body = await c.req.json(); } catch {}
    const action = body.action;
    if (!action || !["start", "stop", "restart"].includes(action)) {
      return c.json({ error: "Invalid action" }, 400);
    }

    const port = parsePortFromInstance(inst);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);

    return stream(c, async (s) => {
      const send = (phase: string, detail?: Record<string, unknown>) =>
        s.write(`data: ${JSON.stringify({ phase, ...detail })}\n\n`);

      try {
        if (action === "restart" || action === "stop") {
          await send("checking");
          const cur = await getProcessStatus(exec, port);

          if (cur.running && cur.pid) {
            await send("stopping", { pid: cur.pid });
            await stopProcess(exec, cur.pid);
            for (let i = 0; i < 20; i++) {
              await new Promise((r) => setTimeout(r, 500));
              const s2 = await getProcessStatus(exec, port);
              if (!s2.running) break;
            }
            await send("stopped");
          } else if (action === "stop") {
            await send("stopped");
          }
        }

        if (action === "restart" || action === "start") {
          await send("starting");
          await startProcess(exec, configDir, port, profile);

          let finalPid: number | undefined;
          let started = false;
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const s2 = await getProcessStatus(exec, port);
            if (s2.running) { finalPid = s2.pid; started = true; break; }
          }

          if (started) {
            await send("running", { pid: finalPid });
          } else {
            await send("failed", { error: "Process did not start within timeout" });
          }
        }

        await send("done");
        auditLog(db, c, `lifecycle.${action}`, `${action} completed via stream (port ${port})`, id);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await send("error", { error: msg });
        auditLog(db, c, `lifecycle.${action}`, `FAILED: ${msg}`, id);
      }
    });
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
      let keyWritten = false;

      for (const [providerName, p] of Object.entries(providers) as [string, any][]) {
        if (p && typeof p === "object") {
          delete p._oauthRefreshToken;
          delete p._oauthExpiresAt;
          if (!p.models) p.models = [];
          // Write API key to auth-profiles.json for all agents
          if (p.apiKey && p.auth !== "oauth") {
            const newKey = p.apiKey;
            // Verify key before writing
            const baseUrl = p.baseUrl || "";
            let vResult;
            try {
              vResult = await verifyProviderKey(exec, providerName, newKey, baseUrl);
            } catch {
              vResult = { status: "unknown" as const, error: "Verification failed" };
            }

            // Determine profile ID using first agent's profiles as reference
            let newProfileKey = `${providerName}:default`;
            const firstProfiles = await readAuthProfiles(exec, configDir, agentIds[0]);
            if (!firstProfiles.profiles) firstProfiles.profiles = {};

            // Check for duplicate key
            for (const [pid, cred] of Object.entries(firstProfiles.profiles) as [string, any][]) {
              if (cred.provider === providerName && (cred.key === newKey || cred.token === newKey)) {
                return c.json({ error: `Duplicate key: already exists as ${pid}` }, 409);
              }
            }

            if (firstProfiles.profiles[newProfileKey]) {
              let n = 2;
              while (firstProfiles.profiles[`${providerName}:key${n}`]) n++;
              newProfileKey = `${providerName}:key${n}`;
            }

            for (const agentId of agentIds) {
              const profiles = agentId === agentIds[0]
                ? firstProfiles
                : await readAuthProfiles(exec, configDir, agentId);
              if (!profiles.version) profiles.version = 1;
              if (!profiles.profiles) profiles.profiles = {};

              profiles.profiles[newProfileKey] = {
                type: "api_key",
                provider: providerName,
                key: newKey,
              };

              // Update order array
              if (!profiles.order) profiles.order = {};
              if (!profiles.order[providerName]) {
                profiles.order[providerName] = Object.keys(profiles.profiles)
                  .filter((k) => k.startsWith(`${providerName}:`));
              } else if (!profiles.order[providerName].includes(newProfileKey)) {
                profiles.order[providerName].push(newProfileKey);
              }

              await writeAuthProfiles(exec, configDir, agentId, profiles);
            }

            // Cache verification result
            db.prepare(`
              INSERT INTO provider_keys (instance_id, profile_id, provider, key_masked, status, checked_at, error_message, email, account_info)
              VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
              ON CONFLICT (instance_id, profile_id) DO UPDATE SET
                status = excluded.status, checked_at = excluded.checked_at,
                error_message = excluded.error_message, email = excluded.email,
                account_info = excluded.account_info
            `).run(
              id, newProfileKey, providerName, maskKey(newKey),
              vResult.status, vResult.error || null,
              vResult.email || null,
              vResult.accountInfo ? JSON.stringify(vResult.accountInfo) : null,
            );
            keyWritten = true;
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
      return c.json({ ok: true, restartRequired: keyWritten });
    } catch (err: any) {
      auditLog(db, c, "lifecycle.providers", `FAILED: ${err.message}`, id);
      return c.json({ error: err.message }, 500);
    }
  });

  // --- Key management endpoints ---
  app.get("/:id/keys", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      const config = await readRemoteConfig(exec, configDir);
      const agentList: any[] = config?.agents?.list || [];
      const agentId = agentList[0]?.id || "main";
      const authData = await readAuthProfiles(exec, configDir, agentId);
      const profiles = authData?.profiles || {};

      const storedOrder: Record<string, string[]> = authData?.order || {};
      // Build effective order: use stored order if present, otherwise derive from profile keys
      const effectiveOrder: Record<string, string[]> = {};
      for (const [pid, cred] of Object.entries(profiles) as [string, any][]) {
        const prov = cred.provider || pid.split(":")[0];
        if (!effectiveOrder[prov]) effectiveOrder[prov] = storedOrder[prov] || [];
        if (!effectiveOrder[prov].includes(pid)) effectiveOrder[prov].push(pid);
      }

      const keys: any[] = [];
      for (const [profileId, cred] of Object.entries(profiles) as [string, any][]) {
        const provider = cred.provider || profileId.split(":")[0];
        const rawKey = cred.key || cred.token || cred.access || "";
        const masked = maskKey(rawKey);
        const cached = db.prepare(
          "SELECT status, checked_at, error_message, email, account_info FROM provider_keys WHERE instance_id = ? AND profile_id = ?"
        ).get(id, profileId) as any;

        const providerOrder = effectiveOrder[provider] || [];
        const rank = providerOrder.indexOf(profileId);

        keys.push({
          profileId, provider,
          type: cred.type || "api_key",
          keyMasked: masked,
          rank: rank >= 0 ? rank : 999,
          status: cred.type === "oauth"
            ? (cred.expires && cred.expires < Date.now() ? "expired" : "valid")
            : (cached?.status || "unknown"),
          checkedAt: cached?.checked_at || null,
          errorMessage: cached?.error_message || null,
          email: cached?.email || cred.email || null,
          accountInfo: cached?.account_info ? JSON.parse(cached.account_info) : null,
          expiresAt: cred.expires || null,
        });
      }
      // Sort by rank so primary key appears first
      keys.sort((a, b) => a.rank - b.rank);
      return c.json({ keys, order: effectiveOrder });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/:id/keys/refresh", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      const config = await readRemoteConfig(exec, configDir);
      const agentList: any[] = config?.agents?.list || [];
      const agentId = agentList[0]?.id || "main";
      const authData = await readAuthProfiles(exec, configDir, agentId);
      const profiles = authData?.profiles || {};
      const providerConfigs = config?.models?.providers || {};
      const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();

      const staleKeys: { profileId: string; cred: any }[] = [];
      for (const [profileId, cred] of Object.entries(profiles) as [string, any][]) {
        if (cred.type === "oauth") continue;
        const cached = db.prepare(
          "SELECT checked_at FROM provider_keys WHERE instance_id = ? AND profile_id = ?"
        ).get(id, profileId) as any;
        if (!cached || !cached.checked_at || cached.checked_at < oneHourAgo) {
          staleKeys.push({ profileId, cred });
        }
      }

      const staleCount = staleKeys.length;
      if (staleCount > 0) {
        (async () => {
          for (const { profileId, cred } of staleKeys) {
            const provider = cred.provider || profileId.split(":")[0];
            const rawKey = cred.key || cred.token || "";
            const baseUrl = providerConfigs[provider]?.baseUrl || "";
            try {
              const result = await verifyProviderKey(exec, provider, rawKey, baseUrl);
              db.prepare(`
                INSERT INTO provider_keys (instance_id, profile_id, provider, key_masked, status, checked_at, error_message, email, account_info)
                VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
                ON CONFLICT (instance_id, profile_id) DO UPDATE SET
                  status = excluded.status, checked_at = excluded.checked_at,
                  error_message = excluded.error_message, email = excluded.email,
                  account_info = excluded.account_info
              `).run(
                id, profileId, provider, maskKey(rawKey),
                result.status, result.error || null,
                result.email || null,
                result.accountInfo ? JSON.stringify(result.accountInfo) : null,
              );
            } catch { /* ignore individual failures */ }
          }
        })();
      }
      return c.json({ refreshing: staleCount });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/:id/keys/:profileId/verify", async (c) => {
    const id = c.req.param("id");
    const profileId = c.req.param("profileId");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      const config = await readRemoteConfig(exec, configDir);
      const agentList: any[] = config?.agents?.list || [];
      const agentId = agentList[0]?.id || "main";
      const authData = await readAuthProfiles(exec, configDir, agentId);
      const cred = authData?.profiles?.[profileId];
      if (!cred) return c.json({ error: "Profile not found" }, 404);

      const provider = cred.provider || profileId.split(":")[0];
      const rawKey = cred.key || cred.token || "";
      const providerConfigs = config?.models?.providers || {};
      const baseUrl = providerConfigs[provider]?.baseUrl || "";

      const result = await verifyProviderKey(exec, provider, rawKey, baseUrl);

      db.prepare(`
        INSERT INTO provider_keys (instance_id, profile_id, provider, key_masked, status, checked_at, error_message, email, account_info)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
        ON CONFLICT (instance_id, profile_id) DO UPDATE SET
          status = excluded.status, checked_at = excluded.checked_at,
          error_message = excluded.error_message, email = excluded.email,
          account_info = excluded.account_info
      `).run(
        id, profileId, provider, maskKey(rawKey),
        result.status, result.error || null,
        result.email || null,
        result.accountInfo ? JSON.stringify(result.accountInfo) : null,
      );

      return c.json({ profileId, status: result.status, email: result.email, error: result.error });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Set key priority order for a provider (first = preferred)
  app.put("/:id/keys/order", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const { provider, order: newOrder } = await c.req.json<{ provider: string; order: string[] }>();
    if (!provider || !Array.isArray(newOrder)) return c.json({ error: "provider and order[] required" }, 400);

    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      const config = await readRemoteConfig(exec, configDir);
      const agentList: any[] = config?.agents?.list || [];
      const agentIds = agentList.map((a: any) => a.id);
      if (agentIds.length === 0) agentIds.push("main");

      for (const agentId of agentIds) {
        const data = await readAuthProfiles(exec, configDir, agentId);
        if (!data.order) data.order = {};
        data.order[provider] = newOrder;
        await writeAuthProfiles(exec, configDir, agentId, data);
      }

      auditLog(db, c, "lifecycle.key.order", `Key order for ${provider}: ${newOrder.join(", ")}`, id);
      return c.json({ ok: true, restartRequired: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.delete("/:id/keys/:profileId", async (c) => {
    const id = c.req.param("id");
    const profileId = c.req.param("profileId");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);
    try {
      const config = await readRemoteConfig(exec, configDir);
      const agentList: any[] = config?.agents?.list || [];
      const agentIds = agentList.map((a: any) => a.id);
      if (agentIds.length === 0) agentIds.push("main");

      for (const agentId of agentIds) {
        await deleteAuthProfile(exec, configDir, agentId, profileId);
      }

      db.prepare("DELETE FROM provider_keys WHERE instance_id = ? AND profile_id = ?").run(id, profileId);

      auditLog(db, c, "lifecycle.key.delete", `Deleted key profile: ${profileId}`, id);
      return c.json({ ok: true, restartRequired: true });
    } catch (err: any) {
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
      return c.json({ ok: true, restartRequired: true, expiresAt: status.credentials.expiresAt, agents: agentIds });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Sync keys from one instance to other instances
  // Supports all key types (OAuth, API key). Adds new keys without overwriting existing different ones.
  app.post("/:id/providers/oauth/sync", requireWrite("lifecycle"), async (c) => {
    const sourceId = c.req.param("id")!;
    const sourceInst = manager.get(sourceId);
    if (!sourceInst) return c.json({ error: "Source instance not found" }, 404);

    let body: { targets?: string[]; profileIds?: string[] } = {};
    try { body = await c.req.json(); } catch {}

    const sourceProfile = profileFromInstanceId(sourceId);
    const sourceConfigDir = getConfigDir(sourceProfile);
    const sourceExec = getExecutor(sourceId, hostStore);

    // 1. Read all keys from source instance
    let sourceKeys: Record<string, any> = {};
    try {
      const srcConfig = await readRemoteConfig(sourceExec, sourceConfigDir);
      const srcAgents: any[] = srcConfig?.agents?.list || [];
      const srcAgentId = srcAgents[0]?.id || "main";
      const srcAuth = await readAuthProfiles(sourceExec, sourceConfigDir, srcAgentId);
      sourceKeys = srcAuth?.profiles || {};
    } catch (err: any) {
      return c.json({ error: `Failed to read source keys: ${err.message}` }, 500);
    }

    // Filter to specific profileIds if requested
    const profileIdsToSync = body.profileIds || Object.keys(sourceKeys);
    const keysToSync: Record<string, any> = {};
    for (const pid of profileIdsToSync) {
      if (sourceKeys[pid]) keysToSync[pid] = sourceKeys[pid];
    }

    if (Object.keys(keysToSync).length === 0) {
      return c.json({ error: "No keys found to sync" }, 400);
    }

    // 2. Resolve target instances
    let targetIds: string[] = body.targets || [];
    if (targetIds.length === 0) {
      const sourceHostKey = sourceId.startsWith("local-") ? "local" : sourceId.replace(/-[^-]+$/, "");
      const all = manager.getAll();
      targetIds = all
        .filter((inst) => {
          const hk = inst.id.startsWith("local-") ? "local" : inst.id.replace(/-[^-]+$/, "");
          return hk === sourceHostKey && inst.id !== sourceId;
        })
        .map((inst) => inst.id);
    }

    if (targetIds.length === 0) {
      return c.json({ error: "No target instances found" }, 400);
    }

    // 3. Write keys to each target — add without overwriting different keys
    const synced: string[] = [];
    const errors: { id: string; error: string }[] = [];

    for (const targetId of targetIds) {
      if (!manager.get(targetId)) {
        errors.push({ id: targetId, error: "Instance not found" });
        continue;
      }
      try {
        const tgtProfile = profileFromInstanceId(targetId);
        const tgtConfigDir = getConfigDir(tgtProfile);
        const tgtExec = getExecutor(targetId, hostStore);

        const tgtConfig = await readRemoteConfig(tgtExec, tgtConfigDir);
        const tgtAgents: any[] = tgtConfig?.agents?.list || [];
        const tgtAgentIds = tgtAgents.map((a: any) => a.id);
        if (tgtAgentIds.length === 0) tgtAgentIds.push("main");

        for (const agentId of tgtAgentIds) {
          const tgtAuth = await readAuthProfiles(tgtExec, tgtConfigDir, agentId);
          if (!tgtAuth.version) tgtAuth.version = 1;
          if (!tgtAuth.profiles) tgtAuth.profiles = {};
          if (!tgtAuth.order) tgtAuth.order = {};

          for (const [pid, cred] of Object.entries(keysToSync)) {
            const provider = cred.provider || pid.split(":")[0];
            const srcSecret = cred.key || cred.token || cred.access || "";

            // Check if this exact key already exists on target (skip duplicate)
            const existing = tgtAuth.profiles[pid];
            if (existing) {
              const existingSecret = existing.key || existing.token || existing.access || "";
              if (existingSecret === srcSecret) continue; // same key, skip
              // Different key with same profileId → generate new profileId
              let n = 2;
              let newPid = `${provider}:key${n}`;
              while (tgtAuth.profiles[newPid]) { n++; newPid = `${provider}:key${n}`; }
              tgtAuth.profiles[newPid] = cred;
              if (!tgtAuth.order[provider]) tgtAuth.order[provider] = Object.keys(tgtAuth.profiles).filter(k => k.startsWith(`${provider}:`));
              if (!tgtAuth.order[provider].includes(newPid)) tgtAuth.order[provider].push(newPid);
            } else {
              tgtAuth.profiles[pid] = cred;
              if (!tgtAuth.order[provider]) tgtAuth.order[provider] = [];
              if (!tgtAuth.order[provider].includes(pid)) tgtAuth.order[provider].push(pid);
            }
          }

          await writeAuthProfiles(tgtExec, tgtConfigDir, agentId, tgtAuth);
        }

        // Restart the target gateway so it picks up new keys
        const tgtPort: number = tgtConfig?.gateway?.port || 18789;
        await restartProcess(tgtExec, tgtConfigDir, tgtPort, tgtProfile === "default" ? undefined : tgtProfile);

        synced.push(targetId);
      } catch (err: any) {
        errors.push({ id: targetId, error: err.message });
      }
    }

    const syncedProfileIds = Object.keys(keysToSync);
    auditLog(db, c, "lifecycle.keys.sync",
      `Synced ${syncedProfileIds.length} key(s) from ${sourceId} to ${synced.length} instance(s)${errors.length ? ` (${errors.length} failed)` : ""}`,
      sourceId);

    return c.json({ ok: errors.length === 0, synced, syncedKeys: syncedProfileIds, errors: errors.length ? errors : undefined });
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

  // --- Quota (Codex OAuth) ---

  app.get("/:id/quota", async (c) => {
    const id = c.req.param("id");
    if (!manager.get(id)) return c.json({ error: "instance not found" }, 404);
    const profile = profileFromInstanceId(id);
    const configDir = getConfigDir(profile);
    const exec = getExecutor(id, hostStore);

    try {
      const config = await readRemoteConfig(exec, configDir);
      const agentList: any[] = config?.agents?.list || [];
      const agentId = agentList[0]?.id || "main";
      const profiles = await readAuthProfiles(exec, configDir, agentId);

      const results: any[] = [];
      // Build effective order: stored order + any profiles not yet in order
      const effOrder: Record<string, string[]> = {};
      for (const [pid, cr] of Object.entries(profiles.profiles || {}) as [string, any][]) {
        const prov = cr.provider || pid.split(":")[0];
        if (!effOrder[prov]) effOrder[prov] = [...(profiles.order?.[prov] || [])];
        if (!effOrder[prov].includes(pid)) effOrder[prov].push(pid);
      }

      // 1) OAuth providers (Codex) — query ALL, not just first per provider
      for (const [key, cred] of Object.entries(profiles.profiles || {}) as [string, any][]) {
        if (cred.type === "oauth" && cred.access) {
          const provider = cred.provider || key.split(":")[0];
          const providerOrder = effOrder[provider] || [];
          const rank = providerOrder.indexOf(key);
          try {
            const quota = await fetchCodexQuota(exec, cred.access, cred.accountId);
            results.push({ profileKey: key, keyMasked: maskKey(cred.access), rank: rank >= 0 ? rank : 999, ...quota });
          } catch (err: any) {
            results.push({ profileKey: key, keyMasked: maskKey(cred.access), rank: rank >= 0 ? rank : 999, provider, displayName: provider, windows: [], error: err.message });
          }
        }
      }

      // 2) API-key providers with balance APIs — query ALL
      for (const [key, cred] of Object.entries(profiles.profiles || {}) as [string, any][]) {
        if (cred.type === "api_key" && cred.key) {
          const provider = cred.provider || key.split(":")[0];
          const fetcher = getApiKeyFetcher(provider);
          if (!fetcher) continue;
          const providerOrder = effOrder[provider] || [];
          const rank = providerOrder.indexOf(key);
          try {
            const quota = await fetcher(exec, cred.key);
            results.push({ profileKey: key, keyMasked: maskKey(cred.key), rank: rank >= 0 ? rank : 999, ...quota });
          } catch (err: any) {
            results.push({ profileKey: key, keyMasked: maskKey(cred.key), rank: rank >= 0 ? rank : 999, provider, displayName: provider, windows: [], error: err.message });
          }
        }
      }

      return c.json({ quotas: results });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // --- Cost Estimate (LiteLLM pricing) ---

  app.get("/:id/cost-estimate", async (c) => {
    const id = c.req.param("id");
    const inst = manager.get(id);
    if (!inst) return c.json({ error: "instance not found" }, 404);

    try {
      const pricing = await fetchPricing();
      const sessions = inst.sessions || [];

      let totalCost = 0;
      let matched = 0;
      let unmatched = 0;
      const byModel: Record<string, { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; sessions: number; cost: number | null }> = {};

      for (const s of sessions) {
        const model = s.model || "";
        const input = s.inputTokens || 0;
        const output = s.outputTokens || 0;
        const cr = s.cacheRead || 0;
        const cw = s.cacheWrite || 0;

        if (!byModel[model]) byModel[model] = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, sessions: 0, cost: null };
        byModel[model].inputTokens += input;
        byModel[model].outputTokens += output;
        byModel[model].cacheRead += cr;
        byModel[model].cacheWrite += cw;
        byModel[model].sessions++;
      }

      // Calculate cost per model
      for (const [model, stats] of Object.entries(byModel)) {
        const cost = estimateCost(pricing, model, stats.inputTokens, stats.outputTokens, stats.cacheRead, stats.cacheWrite);
        stats.cost = cost;
        if (cost !== null) {
          totalCost += cost;
          matched++;
        } else {
          unmatched++;
        }
      }

      // Compute session time range for display
      let oldest = Infinity;
      let newest = 0;
      for (const s of sessions) {
        const ts = s.updatedAt || 0;
        if (ts && ts < oldest) oldest = ts;
        if (ts > newest) newest = ts;
      }

      return c.json({
        totalCost, byModel, matched, unmatched,
        sessionCount: sessions.length,
        oldestSession: oldest === Infinity ? null : oldest,
        newestSession: newest || null,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
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

