import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";

// --- Mock executor factory ---
vi.mock("../../executor/factory.js", () => ({
  getExecutor: vi.fn(),
  getHostExecutor: vi.fn(),
}));

// --- Mock lifecycle modules ---
vi.mock("../../lifecycle/service.js", () => ({
  getProcessStatus: vi.fn(),
  stopProcess: vi.fn(),
  startProcess: vi.fn(),
  restartProcess: vi.fn(),
}));

vi.mock("../../lifecycle/install.js", () => ({
  checkNodeVersion: vi.fn(),
  getVersions: vi.fn(),
  streamInstall: vi.fn(),
  streamUninstall: vi.fn(),
}));

vi.mock("../../lifecycle/agent-config.js", () => ({
  extractModels: vi.fn(),
  mergeAgentConfig: vi.fn(),
  removeAgent: vi.fn(),
}));

vi.mock("../../lifecycle/channel-config.js", () => ({
  mergeChannelAccountConfig: vi.fn(),
}));

vi.mock("../../lifecycle/config.js", () => ({
  readRemoteConfig: vi.fn(),
  writeRemoteConfig: vi.fn(),
  getConfigDir: vi.fn((profile: string) =>
    profile === "default" ? "$HOME/.openclaw" : `$HOME/.openclaw-${profile}`
  ),
  profileFromInstanceId: vi.fn((id: string) => {
    const parts = id.split("-");
    return parts[parts.length - 1];
  }),
}));

import { lifecycleRoutes } from "../lifecycle.js";
import { MockInstanceManager } from "../../__tests__/helpers/mock-instance-manager.js";
import { makeInstanceInfo } from "../../__tests__/helpers/fixtures.js";
import { mockAuthMiddleware } from "../../__tests__/helpers/mock-auth.js";
import { getExecutor, getHostExecutor } from "../../executor/factory.js";
import { getProcessStatus, stopProcess, startProcess, restartProcess } from "../../lifecycle/service.js";
import { checkNodeVersion, getVersions, streamInstall } from "../../lifecycle/install.js";
import { readRemoteConfig, writeRemoteConfig } from "../../lifecycle/config.js";
import { extractModels, mergeAgentConfig, removeAgent } from "../../lifecycle/agent-config.js";
import { mergeChannelAccountConfig } from "../../lifecycle/channel-config.js";

describe("Lifecycle API routes", () => {
  let app: Hono;
  let manager: MockInstanceManager;
  let db: Database.Database;
  let mockExecutor: { exec: ReturnType<typeof vi.fn>; execStream: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT, type TEXT NOT NULL, status TEXT DEFAULT 'running',
        output TEXT DEFAULT '', operator TEXT,
        started_at TEXT DEFAULT (datetime('now')), finished_at TEXT
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS config_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        reason TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    manager = new MockInstanceManager();
    manager.seed([
      makeInstanceInfo({ id: "ssh-1-main", connection: { id: "ssh-1-main", url: "ws://10.0.0.1:18789", status: "connected", label: "Main" } }),
    ]);

    mockExecutor = {
      exec: vi.fn(),
      execStream: vi.fn(),
    };
    vi.mocked(getExecutor).mockReturnValue(mockExecutor as any);
    vi.mocked(getHostExecutor).mockReturnValue(mockExecutor as any);

    app = new Hono();
    app.use("/*", mockAuthMiddleware());
    app.route("/lifecycle", lifecycleRoutes({} as any, manager as any, db));
  });

  // ---- Service control ----

  describe("GET /:id/status", () => {
    it("returns running via websocket when connected", async () => {
      const res = await app.request("/lifecycle/ssh-1-main/status");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.running).toBe(true);
      expect(data.source).toBe("websocket");
    });

    it("falls back to SSH check when disconnected", async () => {
      manager.seed([
        makeInstanceInfo({ id: "ssh-1-main", connection: { id: "ssh-1-main", url: "ws://10.0.0.1:18789", status: "disconnected", label: "Main" } }),
      ]);
      vi.mocked(getProcessStatus).mockResolvedValue({ running: false });

      const res = await app.request("/lifecycle/ssh-1-main/status");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.running).toBe(false);
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/status");
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toBe("instance not found");
    });
  });

  describe("POST /:id/stop", () => {
    it("stops a running instance", async () => {
      vi.mocked(getProcessStatus).mockResolvedValue({ running: true, pid: 5678 });
      vi.mocked(stopProcess).mockResolvedValue(undefined);

      const res = await app.request("/lifecycle/ssh-1-main/stop", { method: "POST" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(stopProcess).toHaveBeenCalledWith(mockExecutor, 5678);
    });

    it("returns 400 if not running", async () => {
      vi.mocked(getProcessStatus).mockResolvedValue({ running: false });

      const res = await app.request("/lifecycle/ssh-1-main/stop", { method: "POST" });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toBe("not running");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/stop", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /:id/start", () => {
    it("starts an instance", async () => {
      vi.mocked(startProcess).mockResolvedValue(undefined);

      const res = await app.request("/lifecycle/ssh-1-main/start", { method: "POST" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(startProcess).toHaveBeenCalledWith(mockExecutor, "$HOME/.openclaw-main", 18789, "main");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/start", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /:id/restart", () => {
    it("restarts an instance", async () => {
      vi.mocked(restartProcess).mockResolvedValue(undefined);

      const res = await app.request("/lifecycle/ssh-1-main/restart", { method: "POST" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(restartProcess).toHaveBeenCalledWith(mockExecutor, "$HOME/.openclaw-main", 18789, "main");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/restart", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  // ---- Config ----

  describe("GET /:id/config-file", () => {
    it("returns config JSON", async () => {
      const mockConfig = { gateway: { port: 18789 }, agents: { main: {} } };
      vi.mocked(readRemoteConfig).mockResolvedValue(mockConfig);

      const res = await app.request("/lifecycle/ssh-1-main/config-file");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(mockConfig);
      expect(readRemoteConfig).toHaveBeenCalledWith(mockExecutor, "$HOME/.openclaw-main");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/config-file");
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:id/config-file", () => {
    it("writes config and returns ok", async () => {
      vi.mocked(writeRemoteConfig).mockResolvedValue(undefined);
      const newConfig = { gateway: { port: 18789, auth: { token: "new" } }, agents: {} };

      const res = await app.request("/lifecycle/ssh-1-main/config-file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(writeRemoteConfig).toHaveBeenCalledWith(mockExecutor, "$HOME/.openclaw-main", newConfig);
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/config-file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });
  });

  // ---- Install/Upgrade (host-level) ----

  describe("GET /host/:hostId/versions", () => {
    it("returns node and openclaw versions", async () => {
      const nodeInfo = { installed: true, version: "22.5.0", sufficient: true };
      const openclawInfo = { installed: "1.2.0", latest: "1.3.0", updateAvailable: true };
      vi.mocked(checkNodeVersion).mockResolvedValue(nodeInfo);
      vi.mocked(getVersions).mockResolvedValue(openclawInfo);

      const res = await app.request("/lifecycle/host/local/versions");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.node).toEqual(nodeInfo);
      expect(data.openclaw).toEqual(openclawInfo);
    });

    it("parses numeric hostId for remote hosts", async () => {
      vi.mocked(checkNodeVersion).mockResolvedValue({ installed: true, version: "22.0.0", sufficient: true });
      vi.mocked(getVersions).mockResolvedValue({ installed: "1.0.0", updateAvailable: false });

      const res = await app.request("/lifecycle/host/42/versions");
      expect(res.status).toBe(200);
      expect(getHostExecutor).toHaveBeenCalledWith(42, expect.anything());
    });
  });

  describe("POST /host/:hostId/install", () => {
    it("returns SSE stream for install", async () => {
      vi.mocked(streamInstall).mockImplementation(async (_exec, _emit, _version) => true);

      const res = await app.request("/lifecycle/host/local/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "1.3.0" }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    });

    it("passes version to streamInstall", async () => {
      vi.mocked(streamInstall).mockImplementation(async (_exec, _emit, _version) => true);

      await app.request("/lifecycle/host/local/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "1.3.0" }),
      });
      // streamInstall is called with (exec, emitFn, version)
      expect(streamInstall).toHaveBeenCalledWith(mockExecutor, expect.any(Function), "1.3.0");
    });

    it("installs latest when no version specified", async () => {
      vi.mocked(streamInstall).mockImplementation(async (_exec, _emit, _version) => true);

      await app.request("/lifecycle/host/local/install", { method: "POST" });
      expect(streamInstall).toHaveBeenCalledWith(mockExecutor, expect.any(Function), undefined);
    });
  });

  // ---- Diagnose ----

  describe("POST /host/:hostId/diagnose", () => {
    it("returns diagnostic info", async () => {
      vi.mocked(checkNodeVersion).mockResolvedValue({ installed: true, version: "22.5.0", sufficient: true });
      vi.mocked(getVersions).mockResolvedValue({ installed: "1.2.0", latest: "1.2.0", updateAvailable: false });
      mockExecutor.exec.mockResolvedValue({ stdout: "/dev/sda1  50G  20G  28G  42% /\n", stderr: "", exitCode: 0 });

      const res = await app.request("/lifecycle/host/local/diagnose", { method: "POST" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.node.installed).toBe(true);
      expect(data.openclaw.installed).toBe("1.2.0");
      expect(data.disk).toContain("/dev/sda1");
    });
  });

  // ---- Logs (SSE) ----

  describe("GET /:id/logs", () => {
    it("streams from file when gateway.log exists", async () => {
      mockExecutor.exec.mockResolvedValueOnce({ stdout: "file\n", stderr: "", exitCode: 0 });
      async function* fakeStream() {
        yield "log line 1\n";
        yield "log line 2\n";
      }
      mockExecutor.execStream.mockReturnValue(fakeStream());

      const res = await app.request("/lifecycle/ssh-1-main/logs");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("log line 1");
      expect(body).toContain("log line 2");
    });

    it("falls back to journalctl when no log file", async () => {
      mockExecutor.exec.mockResolvedValueOnce({ stdout: "journal\n", stderr: "", exitCode: 0 });
      // verify call: journal has entries
      mockExecutor.exec.mockResolvedValueOnce({ stdout: "1\n", stderr: "", exitCode: 0 });
      async function* fakeStream() { yield "systemd log\n"; }
      mockExecutor.execStream.mockReturnValue(fakeStream());

      const res = await app.request("/lifecycle/ssh-1-main/logs");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("systemd log");
    });

    it("returns 404 when no log source available", async () => {
      mockExecutor.exec.mockResolvedValueOnce({ stdout: "none\n", stderr: "", exitCode: 0 });

      const res = await app.request("/lifecycle/ssh-1-main/logs");
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toContain("No log source");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/logs");
      expect(res.status).toBe(404);
    });
  });

  // ---- Operation logging ----

  describe("operation logging", () => {
    it("logs stop operation to database", async () => {
      vi.mocked(getProcessStatus).mockResolvedValue({ running: true, pid: 111 });
      vi.mocked(stopProcess).mockResolvedValue(undefined);

      await app.request("/lifecycle/ssh-1-main/stop", { method: "POST" });
      const rows = db.prepare("SELECT * FROM operations WHERE type = 'lifecycle.stop'").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].instance_id).toBe("ssh-1-main");
      expect(rows[0].status).toBe("success");
      expect(rows[0].output).toContain("111");
    });

    it("logs start operation to database", async () => {
      vi.mocked(startProcess).mockResolvedValue(undefined);

      await app.request("/lifecycle/ssh-1-main/start", { method: "POST" });
      const rows = db.prepare("SELECT * FROM operations WHERE type = 'lifecycle.start'").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("success");
    });

    it("logs config-write operation to database", async () => {
      vi.mocked(writeRemoteConfig).mockResolvedValue(undefined);

      await app.request("/lifecycle/ssh-1-main/config-file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agents: {} }),
      });
      const rows = db.prepare("SELECT * FROM operations WHERE type = 'lifecycle.config-write'").all() as any[];
      expect(rows).toHaveLength(1);
    });
  });

  // ---- Agent config (structured) ----

  describe("GET /:id/models", () => {
    it("returns extracted models", async () => {
      const mockConfig = { agents: { defaults: { model: { primary: "gpt-4o" } }, list: [] } };
      vi.mocked(readRemoteConfig).mockResolvedValue(mockConfig);
      const modelsResult = { models: ["gpt-4o", "gpt-4o-mini"], modelsByProvider: { openai: ["gpt-4o", "gpt-4o-mini"] }, defaultModel: "gpt-4o" };
      vi.mocked(extractModels).mockReturnValue(modelsResult);

      const res = await app.request("/lifecycle/ssh-1-main/models");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(modelsResult);
      expect(readRemoteConfig).toHaveBeenCalledWith(mockExecutor, "$HOME/.openclaw-main");
      expect(extractModels).toHaveBeenCalledWith(mockConfig);
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/models");
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toBe("instance not found");
    });
  });

  describe("PUT /:id/agents", () => {
    it("merges agent config and writes back", async () => {
      const mockConfig = { agents: { defaults: {}, list: [] } };
      const payload = { defaults: { model: "gpt-4o", thinkingDefault: "on" }, agents: [] };
      const merged = { agents: { defaults: { model: { primary: "gpt-4o" } }, list: [] } };
      vi.mocked(readRemoteConfig).mockResolvedValue(mockConfig);
      vi.mocked(mergeAgentConfig).mockReturnValue(merged);
      vi.mocked(writeRemoteConfig).mockResolvedValue(undefined);

      const res = await app.request("/lifecycle/ssh-1-main/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(mergeAgentConfig).toHaveBeenCalledWith(mockConfig, payload);
      expect(writeRemoteConfig).toHaveBeenCalledWith(mockExecutor, "$HOME/.openclaw-main", merged);
    });

    it("creates a snapshot after merge", async () => {
      const mockConfig = { agents: {} };
      const merged = { agents: { defaults: { model: { primary: "gpt-4o" } } } };
      vi.mocked(readRemoteConfig).mockResolvedValue(mockConfig);
      vi.mocked(mergeAgentConfig).mockReturnValue(merged);
      vi.mocked(writeRemoteConfig).mockResolvedValue(undefined);

      await app.request("/lifecycle/ssh-1-main/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaults: { model: "gpt-4o", thinkingDefault: "" }, agents: [] }),
      });
      const rows = db.prepare("SELECT * FROM config_snapshots WHERE instance_id = 'ssh-1-main'").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBe("agent config update");
      expect(rows[0].config_json).toBe(JSON.stringify(merged));
    });

    it("logs audit for agent config update", async () => {
      vi.mocked(readRemoteConfig).mockResolvedValue({ agents: {} });
      vi.mocked(mergeAgentConfig).mockReturnValue({ agents: {} });
      vi.mocked(writeRemoteConfig).mockResolvedValue(undefined);

      await app.request("/lifecycle/ssh-1-main/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaults: { model: "gpt-4o", thinkingDefault: "" }, agents: [] }),
      });
      const rows = db.prepare("SELECT * FROM operations WHERE type = 'lifecycle.agent-config'").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].instance_id).toBe("ssh-1-main");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/agents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaults: { model: "gpt-4o", thinkingDefault: "" }, agents: [] }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id/agents/:agentId", () => {
    it("removes agent and writes back", async () => {
      const mockConfig = { agents: { list: [{ id: "agent-1" }] } };
      const updated = { agents: { list: [] } };
      vi.mocked(readRemoteConfig).mockResolvedValue(mockConfig);
      vi.mocked(removeAgent).mockReturnValue(updated);
      vi.mocked(writeRemoteConfig).mockResolvedValue(undefined);

      const res = await app.request("/lifecycle/ssh-1-main/agents/agent-1", { method: "DELETE" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(removeAgent).toHaveBeenCalledWith(mockConfig, "agent-1");
      expect(writeRemoteConfig).toHaveBeenCalledWith(mockExecutor, "$HOME/.openclaw-main", updated);
    });

    it("creates snapshot and audit log on delete", async () => {
      const mockConfig = { agents: { list: [{ id: "agent-1" }] } };
      const updated = { agents: { list: [] } };
      vi.mocked(readRemoteConfig).mockResolvedValue(mockConfig);
      vi.mocked(removeAgent).mockReturnValue(updated);
      vi.mocked(writeRemoteConfig).mockResolvedValue(undefined);

      await app.request("/lifecycle/ssh-1-main/agents/agent-1", { method: "DELETE" });

      const snaps = db.prepare("SELECT * FROM config_snapshots WHERE instance_id = 'ssh-1-main'").all() as any[];
      expect(snaps).toHaveLength(1);
      expect(snaps[0].config_json).toBe(JSON.stringify(updated));

      const ops = db.prepare("SELECT * FROM operations WHERE type = 'lifecycle.agent-delete'").all() as any[];
      expect(ops).toHaveLength(1);
      expect(ops[0].instance_id).toBe("ssh-1-main");
    });

    it("returns 404 when agent not found", async () => {
      const mockConfig = { agents: { list: [] } };
      vi.mocked(readRemoteConfig).mockResolvedValue(mockConfig);
      vi.mocked(removeAgent).mockImplementation(() => { throw new Error("Agent not found: bad-id"); });

      const res = await app.request("/lifecycle/ssh-1-main/agents/bad-id", { method: "DELETE" });
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toContain("not found");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/agents/agent-1", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });

  // ---- Channel endpoints ----

  describe("GET /:id/channels", () => {
    it("returns channel details from gateway", async () => {
      const res = await app.request("/lifecycle/ssh-1-main/channels");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.channels).toHaveLength(1);
      expect(data.channels[0].type).toBe("telegram");
      expect(data.channels[0].accounts[0].accountId).toBe("default");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/channels");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /:id/channels/probe", () => {
    it("returns probed channel details", async () => {
      const res = await app.request("/lifecycle/ssh-1-main/channels/probe", { method: "POST" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.channels).toHaveLength(1);
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/channels/probe", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /:id/channels/logout", () => {
    it("logs out channel account", async () => {
      const res = await app.request("/lifecycle/ssh-1-main/channels/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "telegram", accountId: "default" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
    });

    it("returns 400 when channel missing", async () => {
      const res = await app.request("/lifecycle/ssh-1-main/channels/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/channels/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "telegram" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /:id/channels/config", () => {
    it("merges channel config and writes back", async () => {
      const mockConfig = { channels: { telegram: { accounts: { default: { dmPolicy: "open" } } } } };
      const merged = { channels: { telegram: { accounts: { default: { dmPolicy: "allowlist" } } } } };
      vi.mocked(readRemoteConfig).mockResolvedValue(mockConfig);
      vi.mocked(mergeChannelAccountConfig).mockReturnValue(merged);
      vi.mocked(writeRemoteConfig).mockResolvedValue(undefined);

      const res = await app.request("/lifecycle/ssh-1-main/channels/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "telegram", accountId: "default", config: { dmPolicy: "allowlist" } }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/channels/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "telegram", config: {} }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 when channel missing", async () => {
      const res = await app.request("/lifecycle/ssh-1-main/channels/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { dmPolicy: "open" } }),
      });
      expect(res.status).toBe(400);
    });

    it("creates snapshot after config update", async () => {
      vi.mocked(readRemoteConfig).mockResolvedValue({ channels: { tg: { accounts: { d: {} } } } });
      vi.mocked(mergeChannelAccountConfig).mockReturnValue({ channels: { tg: { accounts: { d: { dmPolicy: "open" } } } } });
      vi.mocked(writeRemoteConfig).mockResolvedValue(undefined);

      await app.request("/lifecycle/ssh-1-main/channels/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "tg", accountId: "d", config: { dmPolicy: "open" } }),
      });
      const snaps = db.prepare("SELECT * FROM config_snapshots WHERE instance_id = 'ssh-1-main'").all() as any[];
      expect(snaps).toHaveLength(1);
      expect(snaps[0].reason).toBe("channel config update");
    });
  });

  // ---- Snapshot restore ----

  describe("POST /:id/snapshots/:snapId/restore", () => {
    it("restores config from snapshot to remote", async () => {
      const config = { gateway: { port: 18789 }, agents: { list: [] } };
      // Create a snapshot first
      db.prepare("INSERT INTO config_snapshots (instance_id, config_json, reason) VALUES (?, ?, ?)")
        .run("ssh-1-main", JSON.stringify(config), "before change");
      const snap = db.prepare("SELECT id FROM config_snapshots ORDER BY id DESC LIMIT 1").get() as any;

      vi.mocked(writeRemoteConfig).mockResolvedValue(undefined);

      const res = await app.request(`/lifecycle/ssh-1-main/snapshots/${snap.id}/restore`, { method: "POST" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(writeRemoteConfig).toHaveBeenCalledWith(mockExecutor, "$HOME/.openclaw-main", config);

      // Should create a new snapshot recording the restore
      const snaps = db.prepare("SELECT * FROM config_snapshots WHERE instance_id = 'ssh-1-main' ORDER BY id DESC").all() as any[];
      expect(snaps.length).toBeGreaterThanOrEqual(2);
      expect(snaps[0].reason).toContain("restored from snapshot");
    });

    it("returns 404 for nonexistent snapshot", async () => {
      const res = await app.request("/lifecycle/ssh-1-main/snapshots/99999/restore", { method: "POST" });
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toBe("snapshot not found");
    });

    it("returns 403 if snapshot belongs to different instance", async () => {
      db.prepare("INSERT INTO config_snapshots (instance_id, config_json, reason) VALUES (?, ?, ?)")
        .run("ssh-2-other", JSON.stringify({ x: 1 }), "other instance");
      const snap = db.prepare("SELECT id FROM config_snapshots ORDER BY id DESC LIMIT 1").get() as any;

      const res = await app.request(`/lifecycle/ssh-1-main/snapshots/${snap.id}/restore`, { method: "POST" });
      expect(res.status).toBe(403);
    });
  });
});
