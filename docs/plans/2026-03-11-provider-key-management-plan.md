# Provider Key Management Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-key-per-provider management with validity detection, account info display, and key lifecycle operations to the Models tab.

**Architecture:** New `verify.ts` module handles key verification via SSH curl on remote machines. Existing `lifecycle.ts` gets new key CRUD endpoints. `provider_keys` SQLite table caches verification results. Frontend ModelsTab rewritten to show per-provider key cards with status badges.

**Tech Stack:** Hono (backend), React + Tailwind (frontend), SQLite, SSH/CommandExecutor, i18next

**Spec:** `docs/plans/2026-03-11-provider-key-management-design.md`

---

## Chunk 1: Backend Foundation

### Task 1: Add provider_keys table to SQLite

**Files:**
- Modify: `packages/server/src/instances/store.ts:67` (before migrations section)

- [ ] **Step 1: Add CREATE TABLE statement**

In `store.ts`, add inside the `db.exec()` template literal block, after `skill_templates` table (before the closing `\`);`):

```sql
    CREATE TABLE IF NOT EXISTS provider_keys (
      instance_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      key_masked TEXT,
      status TEXT DEFAULT 'unknown',
      checked_at TEXT,
      error_message TEXT,
      email TEXT,
      account_info TEXT,
      PRIMARY KEY (instance_id, profile_id)
    );
```

- [ ] **Step 2: Run tests to verify no breakage**

Run: `cd packages/server && npx vitest run src/api/__tests__/lifecycle.test.ts --reporter=verbose`
Expected: All existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/instances/store.ts
git commit -m "feat(models): add provider_keys table for key validation cache"
```

---

### Task 2: Create key verification module

**Files:**
- Create: `packages/server/src/lifecycle/verify.ts`
- Test: `packages/server/src/lifecycle/__tests__/verify.test.ts`

- [ ] **Step 1: Write tests for verifyProviderKey**

Create `packages/server/src/lifecycle/__tests__/verify.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { verifyProviderKey, getVerifyConfig } from "../verify.js";

describe("getVerifyConfig", () => {
  it("returns Bearer auth for openai", () => {
    const cfg = getVerifyConfig("openai", "https://api.openai.com/v1");
    expect(cfg.endpoint).toBe("https://api.openai.com/v1/models");
    expect(cfg.authType).toBe("bearer");
  });

  it("returns x-api-key for anthropic", () => {
    const cfg = getVerifyConfig("anthropic", "https://api.anthropic.com/v1");
    expect(cfg.authType).toBe("x-api-key");
  });

  it("returns query param for google", () => {
    const cfg = getVerifyConfig("google", "https://generativelanguage.googleapis.com");
    expect(cfg.authType).toBe("query");
  });

  it("defaults to bearer with /v1/models for unknown provider with baseUrl", () => {
    const cfg = getVerifyConfig("custom-llm", "https://my-llm.example.com/v1");
    expect(cfg.endpoint).toBe("https://my-llm.example.com/v1/models");
    expect(cfg.authType).toBe("bearer");
  });

  it("returns null for unknown provider without baseUrl", () => {
    const cfg = getVerifyConfig("unknown", "");
    expect(cfg).toBeNull();
  });
});

describe("verifyProviderKey", () => {
  it("returns valid when curl returns 200", async () => {
    const exec = { exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "200", stderr: "" }) };
    const result = await verifyProviderKey(exec as any, "openai", "sk-test", "https://api.openai.com/v1");
    expect(result.status).toBe("valid");
  });

  it("returns invalid when curl returns 401", async () => {
    const exec = { exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "401", stderr: "" }) };
    const result = await verifyProviderKey(exec as any, "openai", "sk-test", "https://api.openai.com/v1");
    expect(result.status).toBe("invalid");
  });

  it("returns unknown when curl times out", async () => {
    const exec = { exec: vi.fn().mockResolvedValue({ exitCode: 28, stdout: "000", stderr: "timeout" }) };
    const result = await verifyProviderKey(exec as any, "openai", "sk-test", "https://api.openai.com/v1");
    expect(result.status).toBe("unknown");
    expect(result.error).toContain("timeout");
  });

  it("returns null config for provider without baseUrl", async () => {
    const exec = { exec: vi.fn() };
    const result = await verifyProviderKey(exec as any, "unknown", "key", "");
    expect(result.status).toBe("unknown");
    expect(exec.exec).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && npx vitest run src/lifecycle/__tests__/verify.test.ts --reporter=verbose`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement verify.ts**

Create `packages/server/src/lifecycle/verify.ts`:

```typescript
import type { CommandExecutor } from "../executor/types.js";

export interface VerifyConfig {
  endpoint: string;
  authType: "bearer" | "x-api-key" | "query";
  accountEndpoint?: string;
}

export interface VerifyResult {
  status: "valid" | "invalid" | "unknown";
  error?: string;
  email?: string;
  accountInfo?: Record<string, unknown>;
}

const PROVIDER_VERIFY: Record<string, (baseUrl: string) => VerifyConfig> = {
  openai: (u) => ({ endpoint: `${u}/models`, authType: "bearer", accountEndpoint: `${u}/me` }),
  anthropic: (u) => ({ endpoint: `${u}/models`, authType: "x-api-key" }),
  google: (u) => ({ endpoint: `${u.replace(/\/v1\/?$/, "")}/v1beta/models`, authType: "query" }),
  mistral: (u) => ({ endpoint: `${u}/models`, authType: "bearer" }),
  deepseek: (u) => ({ endpoint: `${u}/models`, authType: "bearer", accountEndpoint: `${u}/user/balance` }),
  groq: (u) => ({ endpoint: `${u}/models`, authType: "bearer" }),
  together: (u) => ({ endpoint: `${u}/models`, authType: "bearer" }),
  cohere: (u) => ({ endpoint: `${u.replace(/\/v1\/?$/, "")}/v2/models`, authType: "bearer" }),
};

export function getVerifyConfig(provider: string, baseUrl: string): VerifyConfig | null {
  // Normalize: strip trailing slash
  const url = baseUrl.replace(/\/+$/, "");
  if (!url) return null;

  const factory = PROVIDER_VERIFY[provider];
  if (factory) return factory(url);

  // Unknown provider with baseUrl: try OpenAI-compatible
  return { endpoint: `${url}/models`, authType: "bearer" };
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "***" + key.slice(-2);
  return key.slice(0, 4) + "..." + key.slice(-4);
}

export async function verifyProviderKey(
  exec: CommandExecutor,
  provider: string,
  key: string,
  baseUrl: string,
): Promise<VerifyResult> {
  const cfg = getVerifyConfig(provider, baseUrl);
  if (!cfg) return { status: "unknown", error: "No base URL configured" };

  // Build curl command with key in temp file (not in process args)
  let curlCmd: string;
  const tmpKey = "/tmp/.clawctl-vk-$$";
  const cleanup = `rm -f ${tmpKey}`;

  if (cfg.authType === "query") {
    // Google: key as query parameter — write to temp file, read with cat
    curlCmd = [
      `printf '%s' '${escapeShell(key)}' > ${tmpKey}`,
      `CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "${cfg.endpoint}?key=$(cat ${tmpKey})")`,
      cleanup,
      `echo $CODE`,
    ].join(" && ");
  } else {
    const header = cfg.authType === "x-api-key" ? "x-api-key" : "Authorization";
    const prefix = cfg.authType === "x-api-key" ? "" : "Bearer ";
    curlCmd = [
      `printf '%s' '${escapeShell(key)}' > ${tmpKey}`,
      `CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "${header}: ${prefix}$(cat ${tmpKey})" "${cfg.endpoint}")`,
      cleanup,
      `echo $CODE`,
    ].join(" && ");
  }

  try {
    const r = await exec.exec(curlCmd, { timeout: 15_000 });
    const code = parseInt(r.stdout.trim()) || 0;

    if (code === 200) {
      // Try to fetch account info
      const account = cfg.accountEndpoint
        ? await fetchAccountInfo(exec, cfg, key)
        : undefined;
      return {
        status: "valid",
        email: account?.email,
        accountInfo: account?.info,
      };
    }
    if (code === 401 || code === 403) {
      return { status: "invalid", error: `HTTP ${code}: unauthorized` };
    }
    return { status: "unknown", error: `HTTP ${code}` };
  } catch (err: any) {
    // Ensure temp file cleanup even on exception
    exec.exec(cleanup).catch(() => {});
    const msg = err.message || String(err);
    if (msg.includes("timeout") || msg.includes("Timeout")) {
      return { status: "unknown", error: "Connection timeout" };
    }
    return { status: "unknown", error: msg };
  }
}

async function fetchAccountInfo(
  exec: CommandExecutor,
  cfg: VerifyConfig,
  key: string,
): Promise<{ email?: string; info?: Record<string, unknown> } | undefined> {
  if (!cfg.accountEndpoint) return undefined;
  const tmpKey = "/tmp/.clawctl-vk-acct-$$";
  const header = cfg.authType === "x-api-key" ? "x-api-key" : "Authorization";
  const prefix = cfg.authType === "x-api-key" ? "" : "Bearer ";
  const cmd = [
    `printf '%s' '${escapeShell(key)}' > ${tmpKey}`,
    `curl -s -m 10 -H "${header}: ${prefix}$(cat ${tmpKey})" "${cfg.accountEndpoint}"`,
  ].join(" && ") + `; rm -f ${tmpKey}`;

  try {
    const r = await exec.exec(cmd, { timeout: 15_000 });
    if (r.exitCode !== 0) return undefined;
    const data = JSON.parse(r.stdout);
    return {
      email: data.email || data.user?.email || data.organization?.name,
      info: data,
    };
  } catch {
    return undefined;
  }
}

function escapeShell(s: string): string {
  return s.replace(/'/g, "'\\''");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/lifecycle/__tests__/verify.test.ts --reporter=verbose`
Expected: All 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/lifecycle/verify.ts packages/server/src/lifecycle/__tests__/verify.test.ts
git commit -m "feat(models): add key verification module with SSH curl"
```

---

### Task 3: Add deleteProfile helper to config.ts

**Files:**
- Modify: `packages/server/src/lifecycle/config.ts:38` (append)

- [ ] **Step 1: Append deleteProfile function**

Add at the end of `config.ts`:

```typescript
/** Remove a single profile from auth-profiles.json and clean up references */
export async function deleteAuthProfile(
  exec: CommandExecutor,
  configDir: string,
  agentId: string,
  profileId: string,
): Promise<void> {
  const data = await readAuthProfiles(exec, configDir, agentId);
  if (!data.profiles) return;

  delete data.profiles[profileId];

  // Clean up order references
  if (data.order) {
    for (const [provider, ids] of Object.entries(data.order) as [string, string[]][]) {
      data.order[provider] = ids.filter((id: string) => id !== profileId);
      if (data.order[provider].length === 0) delete data.order[provider];
    }
  }
  // Clean up lastGood references
  if (data.lastGood) {
    for (const [provider, id] of Object.entries(data.lastGood) as [string, string][]) {
      if (id === profileId) delete data.lastGood[provider];
    }
  }
  // Clean up usageStats references
  if (data.usageStats) {
    delete data.usageStats[profileId];
  }

  await writeAuthProfiles(exec, configDir, agentId, data);
}
```

- [ ] **Step 2: Run existing lifecycle tests**

Run: `cd packages/server && npx vitest run src/api/__tests__/lifecycle.test.ts --reporter=verbose`
Expected: All pass (no regressions).

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/lifecycle/config.ts
git commit -m "feat(models): add deleteAuthProfile helper with order/lastGood/usageStats cleanup"
```

---

### Task 4: Add key management API endpoints

**Files:**
- Modify: `packages/server/src/api/lifecycle.ts` (add after PUT providers endpoint, ~line 480)
- Test: `packages/server/src/api/__tests__/lifecycle-keys.test.ts`

- [ ] **Step 1: Write tests**

Create `packages/server/src/api/__tests__/lifecycle-keys.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";

vi.mock("../../executor/factory.js", () => ({
  getExecutor: vi.fn(),
  getHostExecutor: vi.fn(),
}));
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
  readAuthProfiles: vi.fn(),
  writeAuthProfiles: vi.fn(),
  deleteAuthProfile: vi.fn(),
  getConfigDir: vi.fn((p: string) => p === "default" ? "$HOME/.openclaw" : `$HOME/.openclaw-${p}`),
  profileFromInstanceId: vi.fn((id: string) => id.split("-").pop()),
}));
vi.mock("../../lifecycle/verify.js", () => ({
  verifyProviderKey: vi.fn(),
  maskKey: vi.fn((k: string) => k.slice(0, 4) + "..." + k.slice(-4)),
}));

import { lifecycleRoutes } from "../lifecycle.js";
import { MockInstanceManager } from "../../__tests__/helpers/mock-instance-manager.js";
import { makeInstanceInfo } from "../../__tests__/helpers/fixtures.js";
import { mockAuthMiddleware } from "../../__tests__/helpers/mock-auth.js";
import { getExecutor } from "../../executor/factory.js";
import { readRemoteConfig, readAuthProfiles, deleteAuthProfile } from "../../lifecycle/config.js";
import { verifyProviderKey } from "../../lifecycle/verify.js";

describe("Key management endpoints", () => {
  let app: Hono;
  let manager: MockInstanceManager;
  let db: Database.Database;
  let mockExec: { exec: ReturnType<typeof vi.fn>; execStream: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE operations (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT, type TEXT NOT NULL, status TEXT DEFAULT 'running', output TEXT DEFAULT '', operator TEXT, started_at TEXT DEFAULT (datetime('now')), finished_at TEXT);
      CREATE TABLE config_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL, config_json TEXT NOT NULL, reason TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE provider_keys (instance_id TEXT NOT NULL, profile_id TEXT NOT NULL, provider TEXT NOT NULL, key_masked TEXT, status TEXT DEFAULT 'unknown', checked_at TEXT, error_message TEXT, email TEXT, account_info TEXT, PRIMARY KEY (instance_id, profile_id));
    `);
    manager = new MockInstanceManager();
    manager.seed([
      makeInstanceInfo({ id: "ssh-1-main", connection: { id: "ssh-1-main", url: "ws://10.0.0.1:18789", status: "connected", label: "Main" } }),
    ]);
    mockExec = { exec: vi.fn(), execStream: vi.fn() };
    vi.mocked(getExecutor).mockReturnValue(mockExec as any);
    vi.mocked(readRemoteConfig).mockResolvedValue({ agents: { list: [{ id: "main" }] } });
    app = new Hono();
    app.use("/*", mockAuthMiddleware());
    app.route("/lifecycle", lifecycleRoutes({} as any, manager as any, db));
  });

  describe("GET /:id/keys", () => {
    it("returns keys from auth-profiles with cached status", async () => {
      vi.mocked(readAuthProfiles).mockResolvedValue({
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-test1234" },
        },
      });
      // Seed cache
      db.prepare("INSERT INTO provider_keys (instance_id, profile_id, provider, key_masked, status, checked_at) VALUES (?, ?, ?, ?, ?, datetime('now'))").run("ssh-1-main", "openai:default", "openai", "sk-t...1234", "valid");

      const res = await app.request("/lifecycle/ssh-1-main/keys");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.keys).toHaveLength(1);
      expect(data.keys[0].profileId).toBe("openai:default");
      expect(data.keys[0].status).toBe("valid");
      expect(data.keys[0].keyMasked).toBe("sk-t...1234");
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/lifecycle/nonexistent/keys");
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /:id/keys/:profileId", () => {
    it("deletes key from auth-profiles and cache", async () => {
      vi.mocked(readAuthProfiles).mockResolvedValue({
        version: 1,
        profiles: { "openai:default": { type: "api_key", provider: "openai", key: "sk-test" } },
      });
      db.prepare("INSERT INTO provider_keys (instance_id, profile_id, provider, key_masked, status) VALUES (?, ?, ?, ?, ?)").run("ssh-1-main", "openai:default", "openai", "sk-...test", "valid");

      const res = await app.request("/lifecycle/ssh-1-main/keys/openai%3Adefault", { method: "DELETE" });
      expect(res.status).toBe(200);
      expect(vi.mocked(deleteAuthProfile)).toHaveBeenCalled();

      // Cache should be cleared
      const row = db.prepare("SELECT * FROM provider_keys WHERE instance_id = ? AND profile_id = ?").get("ssh-1-main", "openai:default");
      expect(row).toBeUndefined();
    });
  });

  describe("POST /:id/keys/:profileId/verify", () => {
    it("re-verifies a key and updates cache", async () => {
      vi.mocked(readAuthProfiles).mockResolvedValue({
        version: 1,
        profiles: { "openai:default": { type: "api_key", provider: "openai", key: "sk-test1234" } },
      });
      vi.mocked(readRemoteConfig).mockResolvedValue({
        agents: { list: [{ id: "main" }] },
        models: { providers: { openai: { baseUrl: "https://api.openai.com/v1" } } },
      });
      vi.mocked(verifyProviderKey).mockResolvedValue({ status: "valid", email: "kris@example.com" });

      const res = await app.request("/lifecycle/ssh-1-main/keys/openai%3Adefault/verify", { method: "POST" });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.status).toBe("valid");
      expect(data.email).toBe("kris@example.com");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/api/__tests__/lifecycle-keys.test.ts --reporter=verbose`
Expected: FAIL — endpoints not implemented yet.

- [ ] **Step 3: Add imports to lifecycle.ts**

At the top of `packages/server/src/api/lifecycle.ts`, add to the existing imports from config.js:

```typescript
import { readRemoteConfig, writeRemoteConfig, getConfigDir, profileFromInstanceId, readAuthProfiles, writeAuthProfiles, deleteAuthProfile } from "../lifecycle/config.js";
import { verifyProviderKey, maskKey } from "../lifecycle/verify.js";
```

Note: `readAuthProfiles` and `writeAuthProfiles` may already be imported — check and add only what's missing.

- [ ] **Step 4: Implement GET /:id/keys endpoint**

Add after the PUT `/:id/providers` endpoint (after line 480 in lifecycle.ts):

```typescript
  // --- Key management endpoints ---

  // GET /:id/keys — list all API keys with cached verification status
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
      const providerConfigs = config?.models?.providers || {};

      const keys: {
        profileId: string;
        provider: string;
        type: string;
        keyMasked: string;
        status: string;
        checkedAt: string | null;
        errorMessage: string | null;
        email: string | null;
        accountInfo: any;
      }[] = [];

      for (const [profileId, cred] of Object.entries(profiles) as [string, any][]) {
        const provider = cred.provider || profileId.split(":")[0];
        const rawKey = cred.key || cred.token || cred.access || "";
        const masked = maskKey(rawKey);

        // Read cached status from DB
        const cached = db.prepare(
          "SELECT status, checked_at, error_message, email, account_info FROM provider_keys WHERE instance_id = ? AND profile_id = ?"
        ).get(id, profileId) as any;

        keys.push({
          profileId,
          provider,
          type: cred.type || "api_key",
          keyMasked: masked,
          status: cached?.status || "unknown",
          checkedAt: cached?.checked_at || null,
          errorMessage: cached?.error_message || null,
          email: cached?.email || null,
          accountInfo: cached?.account_info ? JSON.parse(cached.account_info) : null,
        });
      }

      return c.json({ keys });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
```

- [ ] **Step 5: Implement POST /:id/keys/refresh endpoint**

```typescript
  // POST /:id/keys/refresh — trigger background re-verification of stale keys
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
        if (cred.type === "oauth") continue; // skip OAuth
        const cached = db.prepare(
          "SELECT checked_at FROM provider_keys WHERE instance_id = ? AND profile_id = ?"
        ).get(id, profileId) as any;
        if (!cached || !cached.checked_at || cached.checked_at < oneHourAgo) {
          staleKeys.push({ profileId, cred });
        }
      }

      // Fire-and-forget: verify stale keys in background, return immediately
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
```

- [ ] **Step 6: Implement POST /:id/keys/:profileId/verify endpoint**

```typescript
  // POST /:id/keys/:profileId/verify — manually re-verify a single key
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
```

- [ ] **Step 7: Implement DELETE /:id/keys/:profileId endpoint**

```typescript
  // DELETE /:id/keys/:profileId — remove a key from all agents
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

      // Clear cache
      db.prepare("DELETE FROM provider_keys WHERE instance_id = ? AND profile_id = ?").run(id, profileId);

      auditLog(db, c, "lifecycle.key.delete", `Deleted key profile: ${profileId}`, id);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
```

- [ ] **Step 8: Run tests**

Run: `cd packages/server && npx vitest run src/api/__tests__/lifecycle-keys.test.ts --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 9: Run all lifecycle tests**

Run: `cd packages/server && npx vitest run src/api/__tests__/lifecycle.test.ts --reporter=verbose`
Expected: All existing tests still pass.

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/api/lifecycle.ts packages/server/src/api/__tests__/lifecycle-keys.test.ts
git commit -m "feat(models): add key management API endpoints (list, verify, delete, refresh)"
```

---

### Task 5: Modify PUT providers to support key append + verification

**Files:**
- Modify: `packages/server/src/api/lifecycle.ts:419-480` (PUT providers endpoint)

- [ ] **Step 1: Add test for key append behavior**

Add to `lifecycle-keys.test.ts`:

```typescript
  describe("PUT /:id/providers — key append", () => {
    it("appends key2 when default already exists with different key", async () => {
      vi.mocked(readAuthProfiles).mockResolvedValue({
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-existing" },
        },
      });
      vi.mocked(readRemoteConfig).mockResolvedValue({
        agents: { list: [{ id: "main" }] },
        models: { providers: {} },
      });
      vi.mocked(verifyProviderKey).mockResolvedValue({ status: "valid" });
      const { writeAuthProfiles } = await import("../../lifecycle/config.js");

      const res = await app.request("/lifecycle/ssh-1-main/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-newkey1234", models: [] } },
        }),
      });
      expect(res.status).toBe(200);

      // Should have written with key2 identifier (not overwriting default)
      const writeCalls = vi.mocked(writeAuthProfiles).mock.calls;
      expect(writeCalls.length).toBeGreaterThan(0);
      const lastData = writeCalls[writeCalls.length - 1][3];
      expect(lastData.profiles["openai:default"]).toBeDefined();
      expect(lastData.profiles["openai:key2"]).toBeDefined();
    });

    it("rejects duplicate key", async () => {
      vi.mocked(readAuthProfiles).mockResolvedValue({
        version: 1,
        profiles: {
          "openai:default": { type: "api_key", provider: "openai", key: "sk-samekey1234" },
        },
      });
      vi.mocked(readRemoteConfig).mockResolvedValue({
        agents: { list: [{ id: "main" }] },
        models: { providers: {} },
      });

      const res = await app.request("/lifecycle/ssh-1-main/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-samekey1234", models: [] } },
        }),
      });
      expect(res.status).toBe(409);
    });
  });
```

- [ ] **Step 2: Rewrite PUT providers key-writing section**

Replace lines 440-451 in `lifecycle.ts` (the apiKey writing block) with:

```typescript
          if (p.apiKey && p.auth !== "oauth") {
            const newKey = p.apiKey;
            // Verify key before writing
            const baseUrl = p.baseUrl || "";
            const vResult = await verifyProviderKey(exec, providerName, newKey, baseUrl);
            if (vResult.status === "invalid") {
              return c.json({ error: `API key invalid for ${providerName}: ${vResult.error}` }, 400);
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
          }
```

- [ ] **Step 3: Run tests**

Run: `cd packages/server && npx vitest run src/api/__tests__/lifecycle-keys.test.ts --reporter=verbose`
Expected: All tests pass including new append/duplicate tests.

- [ ] **Step 4: Run all backend tests**

Run: `cd packages/server && npm run test:unit`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/api/lifecycle.ts packages/server/src/api/__tests__/lifecycle-keys.test.ts
git commit -m "feat(models): PUT providers now verifies key, appends instead of overwriting, rejects duplicates"
```

---

## Chunk 2: Frontend & i18n

### Task 6: Add i18n keys

**Files:**
- Modify: `packages/web/src/locales/en.json`
- Modify: `packages/web/src/locales/zh.json`

- [ ] **Step 1: Add English i18n keys**

First check if a `"models"` key already exists in `en.json`. If it does, merge the new keys into the existing object. If not, create it. Add under `"models"` in `en.json`:

```json
"models": {
  "keys": {
    "valid": "Valid",
    "invalid": "Invalid",
    "unknown": "Unknown",
    "addKey": "Add Key",
    "deleteKey": "Delete",
    "verify": "Verify",
    "noKeys": "No API keys configured",
    "lastChecked": "{{time}} ago",
    "verifying": "Verifying...",
    "deleteConfirm": "Delete key {{key}}? This will remove it from all agents.",
    "totalUsage": "Total: {{tokens}} tok  {{cost}}",
    "invalidError": "Error: {{error}}",
    "addProvider": "Add Provider",
    "providerName": "Provider",
    "baseUrl": "Base URL",
    "apiKey": "API Key",
    "networkUnreachable": "Cannot connect",
    "duplicateKey": "This key already exists",
    "sshError": "SSH connection failed",
    "partialSuccess": "Partially saved ({{success}}/{{total}} agents)",
    "refreshing": "Refreshing...",
    "oauthManaged": "Managed by OAuth",
    "noBaseUrl": "No base URL",
    "keyPlaceholder": "sk-...",
    "addKeyTitle": "Add API Key for {{provider}}"
  }
}
```

- [ ] **Step 2: Add Chinese i18n keys**

Add the same structure in `zh.json`:

```json
"models": {
  "keys": {
    "valid": "有效",
    "invalid": "已失效",
    "unknown": "未知",
    "addKey": "添加密钥",
    "deleteKey": "删除",
    "verify": "验证",
    "noKeys": "未配置 API 密钥",
    "lastChecked": "{{time}}前验证",
    "verifying": "验证中...",
    "deleteConfirm": "删除密钥 {{key}}？将从所有智能体中移除。",
    "totalUsage": "总用量: {{tokens}} tok  {{cost}}",
    "invalidError": "错误: {{error}}",
    "addProvider": "添加提供商",
    "providerName": "提供商",
    "baseUrl": "Base URL",
    "apiKey": "API Key",
    "networkUnreachable": "无法连接",
    "duplicateKey": "该密钥已存在",
    "sshError": "SSH 连接失败",
    "partialSuccess": "部分保存 ({{success}}/{{total}} 个智能体)",
    "refreshing": "刷新中...",
    "oauthManaged": "由 OAuth 管理",
    "noBaseUrl": "无 Base URL",
    "keyPlaceholder": "sk-...",
    "addKeyTitle": "为 {{provider}} 添加 API Key"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/locales/en.json packages/web/src/locales/zh.json
git commit -m "feat(models): add i18n keys for key management UI"
```

---

### Task 7: Rewrite ModelsTab provider section

**Files:**
- Modify: `packages/web/src/pages/Instance.tsx` — the LlmTab component (starts ~line 741)

This is the largest task. The provider section (currently lines ~1009-1061) needs to be replaced with the new key cards UI. The existing add/edit provider form can be kept and adapted.

- [ ] **Step 1: Add key-related state and fetch function**

Inside the `LlmTab` component (after existing state declarations ~line 765), add:

```typescript
  const [keys, setKeys] = useState<{
    profileId: string; provider: string; type: string;
    keyMasked: string; status: string; checkedAt: string | null;
    errorMessage: string | null; email: string | null;
  }[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [verifyingKey, setVerifyingKey] = useState<string | null>(null);
  const [addKeyProvider, setAddKeyProvider] = useState<string | null>(null);
  const [newKeyValue, setNewKeyValue] = useState("");
  const [addKeyError, setAddKeyError] = useState<string | null>(null);
  const [addingKey, setAddingKey] = useState(false);
  const [providerUsage, setProviderUsage] = useState<Record<string, { tokens: number; cost: number }>>({});

  // Compute per-provider usage from existing cost estimate data (already fetched by LlmTab)
  // Group the existing costEstimate.models data by provider name
  useEffect(() => {
    if (!costEstimate?.models) return;
    const usage: Record<string, { tokens: number; cost: number }> = {};
    for (const m of costEstimate.models) {
      const provider = m.model?.split("/")[0] || "other";
      if (!usage[provider]) usage[provider] = { tokens: 0, cost: 0 };
      usage[provider].tokens += m.totalTokens || 0;
      usage[provider].cost += m.cost || 0;
    }
    setProviderUsage(usage);
  }, [costEstimate]);

  const fetchKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const data = await get<{ keys: typeof keys }>(`/lifecycle/${inst.id}/keys`);
      setKeys(data.keys || []);
    } catch { /* ignore */ }
    setKeysLoading(false);
  }, [inst.id]);

  // Fetch keys when tab mounts + trigger background refresh with polling
  useEffect(() => {
    fetchKeys();
    let pollTimer: ReturnType<typeof setInterval>;
    post<{ refreshing: number }>(`/lifecycle/${inst.id}/keys/refresh`).then((r) => {
      if (r.refreshing > 0) {
        // Poll every 3 seconds until no more stale keys
        let polls = 0;
        pollTimer = setInterval(async () => {
          await fetchKeys();
          polls++;
          if (polls >= 10) clearInterval(pollTimer); // max 30s polling
        }, 3000);
      }
    }).catch(() => {});
    return () => { if (pollTimer) clearInterval(pollTimer); };
  }, [inst.id, fetchKeys]);
```

- [ ] **Step 2: Add key action handlers**

```typescript
  const handleVerifyKey = async (profileId: string) => {
    setVerifyingKey(profileId);
    try {
      await post(`/lifecycle/${inst.id}/keys/${encodeURIComponent(profileId)}/verify`);
      await fetchKeys();
    } catch { /* ignore */ }
    setVerifyingKey(null);
  };

  const handleDeleteKey = async (profileId: string, keyMasked: string) => {
    if (!confirm(t("models.keys.deleteConfirm", { key: keyMasked }))) return;
    try {
      await del(`/lifecycle/${inst.id}/keys/${encodeURIComponent(profileId)}`);
      await fetchKeys();
    } catch { /* ignore */ }
  };

  const handleAddKey = async (providerName: string) => {
    if (!newKeyValue.trim()) return;
    setAddingKey(true);
    setAddKeyError(null);
    try {
      const providerConfig = providers[providerName] || {};
      await put(`/lifecycle/${inst.id}/providers`, {
        providers: {
          ...providers,
          [providerName]: { ...providerConfig, apiKey: newKeyValue.trim() },
        },
      });
      setNewKeyValue("");
      setAddKeyProvider(null);
      await fetchKeys();
      await fetchProviders();
    } catch (err: any) {
      setAddKeyError(err.message || t("models.keys.sshError"));
    }
    setAddingKey(false);
  };

- [ ] **Step 3: Replace provider list UI**

Replace the provider list section (the `大模型提供商` card area) with key cards. Each provider gets a card showing its keys. Keep the "Add Provider" button for adding completely new providers.

The JSX for each provider card:

```tsx
{/* Provider cards with keys */}
{Object.entries(providers).map(([name, prov]: [string, any]) => {
  const provKeys = keys.filter(k => k.provider === name);
  return (
    <div key={name} className="bg-s1 border border-edge rounded-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
        <div>
          <div>
            <span className="text-sm font-medium text-ink">{name}</span>
            <span className="text-xs text-ink-3 ml-2">{prov.baseUrl}</span>
          </div>
          {/* Per-provider usage — computed from existing cost estimate data */}
          {providerUsage[name] && (
            <div className="text-xs text-ink-3 mt-0.5">
              {t("models.keys.totalUsage", {
                tokens: formatTokens(providerUsage[name].tokens),
                cost: `$${providerUsage[name].cost.toFixed(4)}`,
              })}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={() => startEdit(name)}
            className="text-xs text-brand hover:text-brand-light">{t("common.edit")}</button>
          <button onClick={() => deleteProvider(name)}
            className="text-xs text-danger hover:text-danger/80">{t("common.delete")}</button>
        </div>
      </div>

      {/* Key rows */}
      <div className="divide-y divide-edge">
        {provKeys.length === 0 && (
          <div className="px-4 py-3 text-sm text-ink-3">{t("models.keys.noKeys")}</div>
        )}
        {provKeys.map(k => (
          <div key={k.profileId} className="flex items-center gap-3 px-4 py-2.5">
            <code className="text-xs text-ink font-mono">{k.keyMasked}</code>
            <span className={`text-xs px-2 py-0.5 rounded whitespace-nowrap ${
              k.status === "valid" ? "bg-ok/10 text-ok" :
              k.status === "invalid" ? "bg-red-500/10 text-red-500" :
              "bg-ink-3/10 text-ink-3"
            }`}>
              {t(`models.keys.${k.status}`)}
            </span>
            {k.email && <span className="text-xs text-ink-3">{k.email}</span>}
            {k.status === "invalid" && k.errorMessage && (
              <span className="text-xs text-red-500">{k.errorMessage}</span>
            )}
            {k.checkedAt && (
              <span className="text-xs text-ink-3 ml-auto">
                {formatTimeAgo(k.checkedAt, t)}
              </span>
            )}
            <button
              onClick={() => handleVerifyKey(k.profileId)}
              disabled={verifyingKey === k.profileId}
              className="text-ink-3 hover:text-brand transition-colors disabled:opacity-50"
              title={t("models.keys.verify")}>
              <RefreshCw size={14} className={verifyingKey === k.profileId ? "animate-spin" : ""} />
            </button>
            {k.type !== "oauth" && (
              <button
                onClick={() => handleDeleteKey(k.profileId, k.keyMasked)}
                className="text-ink-3 hover:text-danger transition-colors"
                title={t("models.keys.deleteKey")}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Add key button / inline form */}
      <div className="px-4 py-2.5 border-t border-edge">
        {addKeyProvider === name ? (
          <div className="flex items-center gap-2">
            <input
              type="password"
              value={newKeyValue}
              onChange={e => setNewKeyValue(e.target.value)}
              placeholder={t("models.keys.keyPlaceholder")}
              className="flex-1 bg-s2 border border-edge rounded px-3 py-1.5 text-sm text-ink"
              autoFocus
            />
            <button onClick={() => handleAddKey(name)}
              disabled={addingKey || !newKeyValue.trim()}
              className="text-xs bg-brand hover:bg-brand-light text-white px-3 py-1.5 rounded disabled:opacity-50">
              {addingKey ? t("models.keys.verifying") : t("common.save")}
            </button>
            <button onClick={() => { setAddKeyProvider(null); setNewKeyValue(""); setAddKeyError(null); }}
              className="text-xs text-ink-3 hover:text-ink px-2 py-1.5">
              {t("common.cancel")}
            </button>
            {addKeyError && <span className="text-xs text-red-500">{addKeyError}</span>}
          </div>
        ) : (
          <button onClick={() => setAddKeyProvider(name)}
            className="text-xs text-brand hover:text-brand-light">
            + {t("models.keys.addKey")}
          </button>
        )}
      </div>
    </div>
  );
})}
```

- [ ] **Step 4: Add formatTimeAgo helper**

Add a simple helper function (inside or above the component):

```typescript
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function formatTimeAgo(isoDate: string, t: (k: string, o?: any) => string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t("models.keys.lastChecked", { time: "<1m" });
  if (mins < 60) return t("models.keys.lastChecked", { time: `${mins}m` });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("models.keys.lastChecked", { time: `${hours}h` });
  const days = Math.floor(hours / 24);
  return t("models.keys.lastChecked", { time: `${days}d` });
}
```

- [ ] **Step 5: Ensure necessary imports**

Add to Instance.tsx imports if not already present:

```typescript
import { RefreshCw, Trash2 } from "lucide-react";
import { post, put, del } from "../lib/api";
```

- [ ] **Step 6: Build check**

Run: `cd packages/web && npx vite build`
Expected: Build succeeds with no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/pages/Instance.tsx
git commit -m "feat(models): rewrite provider section with per-key cards, status badges, add/delete/verify"
```

---

### Task 8: Frontend component tests

**Files:**
- Create: `packages/web/src/pages/__tests__/Instance-models.test.tsx`

- [ ] **Step 1: Write basic render test**

Create `packages/web/src/pages/__tests__/Instance-models.test.tsx` with tests that verify:
- Provider cards render with provider names
- Key rows display with masked keys and status badges
- Add key button appears in each provider card
- Delete and verify buttons appear for each key

Use the existing test patterns from `packages/web/src/pages/__tests__/Skills.test.tsx`:
- Wrap component in `<MemoryRouter>`
- Mock API responses with MSW handlers or `vi.mock`
- Use `render()`, `screen`, `waitFor()` from testing-library

Mock data should include at least 2 providers with 2+ keys each, with mixed status (valid/invalid/unknown).

- [ ] **Step 2: Run tests**

Run: `cd packages/web && npx vitest run src/pages/__tests__/Instance-models.test.tsx --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/pages/__tests__/Instance-models.test.tsx
git commit -m "test(models): add component tests for provider key management UI"
```

---

### Task 9: Manual smoke test

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Navigate to instance → Models tab**

Open `http://localhost:7101/instance/ssh-1-default`, click "大模型" tab.

- [ ] **Step 3: Verify provider cards display with key status**

Check that:
- Each provider shows as a card
- Keys show masked values with status badges
- Background refresh triggers and updates status

- [ ] **Step 4: Test add key flow**

Click "+ 添加密钥" on a provider, enter a test key, verify it validates via SSH curl on the remote machine.

- [ ] **Step 5: Test delete key flow**

Click delete on a key, confirm dialog appears, key is removed.

- [ ] **Step 6: Test verify button**

Click 🔄 on a key, verify it re-checks and updates status.

- [ ] **Step 7: Final commit with any fixes**

```bash
git add -A
git commit -m "fix(models): smoke test fixes for key management UI"
```
