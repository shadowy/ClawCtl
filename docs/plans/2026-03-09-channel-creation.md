# Channel Creation Feature Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full channel creation flow to ClawCtl — users can create Feishu/Lark, Telegram, Slack, and Discord channels on OpenClaw instances, with automatic dependency installation, config writing, gateway restart, and real-time progress feedback.

**Architecture:** SSE streaming endpoint (same pattern as install/uninstall flows) handles the multi-step process: validate → backup config → check/install deps → write config + bindings → restart gateway → verify. Frontend uses an inline form in the ChannelsTab with a step-by-step progress display. On failure, config is auto-rolled back from backup.

**Tech Stack:** Hono SSE streaming, React inline form with dynamic fields per channel type, i18next for i18n.

---

### Task 1: Backend — `createChannelConfig()` in channel-config.ts

**Files:**
- Modify: `packages/server/src/lifecycle/channel-config.ts`
- Test: `packages/server/src/lifecycle/__tests__/channel-config.test.ts`

**Step 1: Write the failing tests**

Add to `packages/server/src/lifecycle/__tests__/channel-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mergeChannelAccountConfig, createChannelConfig, CHANNEL_DEFS } from "../channel-config.js";

describe("createChannelConfig", () => {
  it("adds feishu channel with account to empty config", () => {
    const config = { gateway: { port: 18789 }, agents: { list: [{ id: "my" }] } };
    const result = createChannelConfig(config, "feishu", {
      accountId: "default",
      appId: "cli_xxx",
      appSecret: "secret",
      domain: "feishu",
      connectionMode: "websocket",
      dmPolicy: "open",
      groupPolicy: "open",
    }, ["my"]);
    expect(result.channels.feishu).toBeDefined();
    expect(result.channels.feishu.enabled).toBe(true);
    expect(result.channels.feishu.accounts.default.appId).toBe("cli_xxx");
    expect(result.channels.feishu.accounts.default.enabled).toBe(true);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]).toEqual({ agentId: "my", match: { channel: "feishu" } });
  });

  it("adds telegram channel with botToken", () => {
    const config = { gateway: { port: 18789 }, agents: { list: [{ id: "bot" }] } };
    const result = createChannelConfig(config, "telegram", {
      accountId: "default",
      botToken: "123:ABC",
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
    }, ["bot"]);
    expect(result.channels.telegram.accounts.default.botToken).toBe("123:ABC");
    expect(result.bindings[0].agentId).toBe("bot");
  });

  it("binds multiple agents", () => {
    const config = { gateway: { port: 18789 }, agents: { list: [{ id: "a" }, { id: "b" }] } };
    const result = createChannelConfig(config, "telegram", {
      accountId: "default",
      botToken: "tok",
    }, ["a", "b"]);
    expect(result.bindings).toHaveLength(2);
  });

  it("throws if channel already exists", () => {
    const config = { channels: { feishu: { enabled: true } } };
    expect(() => createChannelConfig(config, "feishu", { accountId: "default", appId: "x", appSecret: "y" }, []))
      .toThrow("already exists");
  });

  it("throws on unknown channel type", () => {
    expect(() => createChannelConfig({}, "whatsapp" as any, { accountId: "default" }, []))
      .toThrow("Unsupported");
  });

  it("preserves existing config sections", () => {
    const config = { gateway: { port: 18789 }, models: { providers: {} } };
    const result = createChannelConfig(config, "discord", {
      accountId: "default",
      botToken: "tok",
    }, []);
    expect(result.gateway.port).toBe(18789);
    expect(result.models.providers).toEqual({});
  });
});

describe("CHANNEL_DEFS", () => {
  it("has entries for feishu, telegram, slack, discord", () => {
    expect(CHANNEL_DEFS.feishu).toBeDefined();
    expect(CHANNEL_DEFS.telegram).toBeDefined();
    expect(CHANNEL_DEFS.slack).toBeDefined();
    expect(CHANNEL_DEFS.discord).toBeDefined();
  });

  it("feishu requires appId and appSecret", () => {
    expect(CHANNEL_DEFS.feishu.requiredFields).toContain("appId");
    expect(CHANNEL_DEFS.feishu.requiredFields).toContain("appSecret");
  });

  it("telegram requires botToken", () => {
    expect(CHANNEL_DEFS.telegram.requiredFields).toContain("botToken");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/server && npx vitest run src/lifecycle/__tests__/channel-config.test.ts`
Expected: FAIL — `createChannelConfig` and `CHANNEL_DEFS` not exported

**Step 3: Write the implementation**

Add to `packages/server/src/lifecycle/channel-config.ts`:

```typescript
export interface ChannelDef {
  label: string;
  requiredFields: string[];
  optionalFields: string[];
  extensionDir: string; // relative to openclaw install dir
  depCheckPath: string; // path inside node_modules to verify deps installed
}

export const CHANNEL_DEFS: Record<string, ChannelDef> = {
  feishu: {
    label: "Feishu/Lark",
    requiredFields: ["appId", "appSecret"],
    optionalFields: ["domain", "connectionMode"],
    extensionDir: "extensions/feishu",
    depCheckPath: "@larksuiteoapi/node-sdk",
  },
  telegram: {
    label: "Telegram",
    requiredFields: ["botToken"],
    optionalFields: [],
    extensionDir: "", // built-in, no extension deps
    depCheckPath: "",
  },
  slack: {
    label: "Slack",
    requiredFields: ["botToken", "appToken"],
    optionalFields: [],
    extensionDir: "",
    depCheckPath: "",
  },
  discord: {
    label: "Discord",
    requiredFields: ["botToken"],
    optionalFields: [],
    extensionDir: "",
    depCheckPath: "",
  },
};

export interface CreateChannelInput {
  accountId: string;
  // feishu
  appId?: string;
  appSecret?: string;
  domain?: string;
  connectionMode?: string;
  // telegram/slack/discord
  botToken?: string;
  appToken?: string; // slack
  // policies
  dmPolicy?: string;
  groupPolicy?: string;
  allowFrom?: string[];
}

export function createChannelConfig(
  config: any,
  channel: string,
  input: CreateChannelInput,
  bindAgentIds: string[],
): any {
  const def = CHANNEL_DEFS[channel];
  if (!def) throw new Error(`Unsupported channel type: ${channel}`);

  if (config.channels?.[channel]) {
    throw new Error(`Channel ${channel} already exists`);
  }

  const result = JSON.parse(JSON.stringify(config));
  if (!result.channels) result.channels = {};
  if (!result.bindings) result.bindings = [];

  // Build account config (only include non-empty fields)
  const account: Record<string, any> = { enabled: true };
  for (const f of [...def.requiredFields, ...def.optionalFields]) {
    if ((input as any)[f]) account[f] = (input as any)[f];
  }
  if (input.dmPolicy) account.dmPolicy = input.dmPolicy;
  if (input.groupPolicy) account.groupPolicy = input.groupPolicy;
  if (input.allowFrom) account.allowFrom = input.allowFrom;
  if (input.dmPolicy === "open" && !input.allowFrom) {
    account.allowFrom = ["*"];
  }

  // Channel top-level config
  result.channels[channel] = {
    enabled: true,
    accounts: { [input.accountId]: account },
    dmPolicy: input.dmPolicy || "pairing",
    groupPolicy: input.groupPolicy || "allowlist",
  };

  // Add bindings
  for (const agentId of bindAgentIds) {
    result.bindings.push({ agentId, match: { channel } });
  }

  return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/server && npx vitest run src/lifecycle/__tests__/channel-config.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add packages/server/src/lifecycle/channel-config.ts packages/server/src/lifecycle/__tests__/channel-config.test.ts
git commit -m "feat: add createChannelConfig and CHANNEL_DEFS for channel creation"
```

---

### Task 2: Backend — `streamChannelCreate()` in install.ts

**Files:**
- Modify: `packages/server/src/lifecycle/install.ts`

**Step 1: Write `streamChannelCreate` function**

Add to end of `packages/server/src/lifecycle/install.ts`:

```typescript
import { createChannelConfig, CHANNEL_DEFS, type CreateChannelInput } from "./channel-config.js";
import { readRemoteConfig, writeRemoteConfig } from "./config.js";

export async function streamChannelCreate(
  exec: CommandExecutor,
  configDir: string,
  channel: string,
  input: CreateChannelInput,
  bindAgentIds: string[],
  emit: EmitFn,
): Promise<boolean> {
  const def = CHANNEL_DEFS[channel];
  if (!def) {
    await emit({ step: "Validate", status: "error", detail: `Unsupported channel: ${channel}` });
    return false;
  }

  // Step 1: Validate required fields
  await emit({ step: "Validate", status: "running" });
  for (const field of def.requiredFields) {
    if (!(input as any)[field]) {
      await emit({ step: "Validate", status: "error", detail: `Missing required field: ${field}` });
      return false;
    }
  }
  await emit({ step: "Validate", status: "done" });

  // Step 2: Backup config
  await emit({ step: "Backup config", status: "running" });
  const backupPath = `${configDir}/openclaw.json.channel-bak`;
  const bkR = await exec.exec(`cp "${configDir}/openclaw.json" "${backupPath}" 2>/dev/null`);
  if (bkR.exitCode !== 0) {
    await emit({ step: "Backup config", status: "error", detail: "Failed to backup config" });
    return false;
  }
  await emit({ step: "Backup config", status: "done" });

  // Step 3: Check & install extension dependencies
  if (def.extensionDir && def.depCheckPath) {
    await emit({ step: "Check dependencies", status: "running" });

    // Find openclaw install dir
    const whichR = await exec.exec("readlink -f $(which openclaw) 2>/dev/null");
    const binPath = whichR.stdout.trim();
    // e.g. /usr/lib/node_modules/openclaw/dist/cli.js → /usr/lib/node_modules/openclaw
    const openclawDir = binPath.replace(/\/dist\/.*$/, "").replace(/\/bin\/.*$/, "");

    const extDir = `${openclawDir}/${def.extensionDir}`;
    const depCheck = await exec.exec(`ls "${extDir}/node_modules/${def.depCheckPath}/package.json" 2>/dev/null`);

    if (depCheck.exitCode === 0) {
      await emit({ step: "Check dependencies", status: "done", detail: "Already installed" });
    } else {
      // Check for concurrent install (lock file)
      const lockFile = `/tmp/openclaw-channel-install-${channel}.lock`;
      const lockCheck = await exec.exec(`test -f "${lockFile}" && echo locked || echo ok`);
      if (lockCheck.stdout.trim() === "locked") {
        await emit({ step: "Install dependencies", status: "error", detail: "Another install in progress" });
        await rollback(exec, backupPath, configDir);
        return false;
      }

      await emit({ step: "Install dependencies", status: "running" });
      await exec.exec(`touch "${lockFile}"`);
      try {
        const hasSudo = (await exec.exec("command -v sudo >/dev/null 2>&1 && echo yes")).stdout.trim() === "yes";
        const prefix = hasSudo ? "sudo " : "";
        const r = await execLong(exec, `cd "${extDir}" && ${prefix}npm install`, 180_000);
        if (r.exitCode !== 0) {
          await emit({ step: "Install dependencies", status: "error", detail: (r.stderr || r.stdout).slice(0, 200) });
          await rollback(exec, backupPath, configDir);
          return false;
        }
        // Verify
        const verifyDep = await exec.exec(`ls "${extDir}/node_modules/${def.depCheckPath}/package.json" 2>/dev/null`);
        if (verifyDep.exitCode !== 0) {
          await emit({ step: "Install dependencies", status: "error", detail: "Dependencies installed but verification failed" });
          await rollback(exec, backupPath, configDir);
          return false;
        }
        await emit({ step: "Install dependencies", status: "done" });
      } finally {
        await exec.exec(`rm -f "${lockFile}"`);
      }
    }
  } else {
    await emit({ step: "Check dependencies", status: "skipped", detail: "Built-in channel" });
  }

  // Step 4: Write config
  await emit({ step: "Write config", status: "running" });
  try {
    const config = await readRemoteConfig(exec, configDir);
    const merged = createChannelConfig(config, channel, input, bindAgentIds);
    await writeRemoteConfig(exec, configDir, merged);
    await emit({ step: "Write config", status: "done" });
  } catch (err: any) {
    await emit({ step: "Write config", status: "error", detail: err.message });
    await rollback(exec, backupPath, configDir);
    return false;
  }

  // Step 5: Restart gateway
  await emit({ step: "Restart gateway", status: "running" });
  try {
    // Find gateway PID on the standard port from config
    const config = await readRemoteConfig(exec, configDir);
    const port = config.gateway?.port || 18789;
    const pidR = await exec.exec(`lsof -ti :${port} 2>/dev/null | head -1`);
    const pid = parseInt(pidR.stdout.trim());
    if (pid > 0) {
      await exec.exec(`kill ${pid} 2>/dev/null; true`);
      // Wait for it to stop
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const check = await exec.exec(`lsof -ti :${port} 2>/dev/null | head -1`);
        if (!check.stdout.trim()) break;
      }
    }
    // Start gateway
    await exec.exec(`nohup openclaw gateway > "${configDir}/gateway.log" 2>&1 &`);
    await emit({ step: "Restart gateway", status: "done" });
  } catch (err: any) {
    await emit({ step: "Restart gateway", status: "error", detail: err.message });
    // Don't rollback here — config is valid, just restart failed
    return false;
  }

  // Step 6: Verify channel loaded
  await emit({ step: "Verify channel", status: "running" });
  await new Promise((r) => setTimeout(r, 5000)); // wait for gateway startup
  const logR = await exec.exec(`tail -50 "${configDir}/gateway.log" 2>/dev/null`);
  const logText = logR.stdout;
  if (logText.includes(`[${channel}]`) && !logText.includes(`failed to load`)) {
    await emit({ step: "Verify channel", status: "done", detail: "Channel loaded successfully" });
  } else if (logText.includes(`failed to load`)) {
    await emit({ step: "Verify channel", status: "error", detail: "Plugin failed to load — check gateway logs" });
    return false;
  } else {
    // Gateway may write logs elsewhere
    await emit({ step: "Verify channel", status: "done", detail: "Gateway started (check logs for channel status)" });
  }

  return true;
}

async function rollback(exec: CommandExecutor, backupPath: string, configDir: string): Promise<void> {
  await exec.exec(`cp "${backupPath}" "${configDir}/openclaw.json" 2>/dev/null; rm -f "${backupPath}"`);
}
```

Note: `execLong` is already defined in the same file and can be reused directly.

**Step 2: Commit**

```bash
git add packages/server/src/lifecycle/install.ts
git commit -m "feat: add streamChannelCreate for SSE channel creation flow"
```

---

### Task 3: Backend — POST endpoint in lifecycle.ts

**Files:**
- Modify: `packages/server/src/api/lifecycle.ts`

**Step 1: Add the endpoint**

After the existing `PUT /:id/channels/config` endpoint (~line 263), add:

```typescript
import { streamChannelCreate } from "../lifecycle/install.js";

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
```

**Step 2: Verify import of `stream` from hono**

Check that `stream` is already imported at the top of lifecycle.ts (it should be, used by install endpoint). If not:
```typescript
import { stream } from "hono/streaming";
```

**Step 3: Commit**

```bash
git add packages/server/src/api/lifecycle.ts
git commit -m "feat: add POST /:id/channels/create SSE endpoint"
```

---

### Task 4: Frontend — i18n strings

**Files:**
- Modify: `packages/web/src/locales/en.json`
- Modify: `packages/web/src/locales/zh.json`

**Step 1: Add English strings**

Add under `"instance"` → `"channel"` namespace in `en.json`:

```json
"channelCreate": {
  "addChannel": "Add Channel",
  "channelType": "Channel Type",
  "selectType": "Select channel type",
  "accountId": "Account ID",
  "appId": "App ID",
  "appSecret": "App Secret",
  "botToken": "Bot Token",
  "appToken": "App Token (Socket Mode)",
  "domain": "Domain",
  "connectionMode": "Connection Mode",
  "dmPolicy": "DM Policy",
  "groupPolicy": "Group Policy",
  "bindAgents": "Bind to Agents",
  "create": "Create Channel",
  "creating": "Creating...",
  "success": "Channel created successfully",
  "failed": "Channel creation failed",
  "retry": "Retry",
  "stepValidate": "Validate",
  "stepBackup": "Backup config",
  "stepCheckDeps": "Check dependencies",
  "stepInstallDeps": "Install dependencies",
  "stepWriteConfig": "Write config",
  "stepRestart": "Restart gateway",
  "stepVerify": "Verify channel"
}
```

**Step 2: Add Chinese strings**

Same keys in `zh.json`:

```json
"channelCreate": {
  "addChannel": "添加渠道",
  "channelType": "渠道类型",
  "selectType": "选择渠道类型",
  "accountId": "账户 ID",
  "appId": "App ID",
  "appSecret": "App Secret",
  "botToken": "Bot Token",
  "appToken": "App Token (Socket 模式)",
  "domain": "域名",
  "connectionMode": "连接方式",
  "dmPolicy": "私聊策略",
  "groupPolicy": "群组策略",
  "bindAgents": "绑定 Agent",
  "create": "创建渠道",
  "creating": "创建中...",
  "success": "渠道创建成功",
  "failed": "渠道创建失败",
  "retry": "重试",
  "stepValidate": "校验参数",
  "stepBackup": "备份配置",
  "stepCheckDeps": "检查依赖",
  "stepInstallDeps": "安装依赖",
  "stepWriteConfig": "写入配置",
  "stepRestart": "重启网关",
  "stepVerify": "验证渠道"
}
```

**Step 3: Commit**

```bash
git add packages/web/src/locales/en.json packages/web/src/locales/zh.json
git commit -m "feat: add i18n strings for channel creation"
```

---

### Task 5: Frontend — Channel creation form + SSE progress in Instance.tsx

**Files:**
- Modify: `packages/web/src/pages/Instance.tsx`

**Step 1: Add state and form to ChannelsTab**

At the top of `ChannelsTab` function (after existing state declarations ~line 1586), add:

```typescript
// Channel creation state
const [showCreate, setShowCreate] = useState(false);
const [createType, setCreateType] = useState("");
const [createAccount, setCreateAccount] = useState<Record<string, string>>({ accountId: "default", dmPolicy: "open", groupPolicy: "open" });
const [createBindAgents, setCreateBindAgents] = useState<string[]>([]);
const [createSteps, setCreateSteps] = useState<{ step: string; status: string; detail?: string }[]>([]);
const [createRunning, setCreateRunning] = useState(false);
const [createDone, setCreateDone] = useState<boolean | null>(null);

const CHANNEL_TYPES = [
  { id: "feishu", label: "Feishu/Lark", fields: ["appId", "appSecret"], optional: ["domain", "connectionMode"] },
  { id: "telegram", label: "Telegram", fields: ["botToken"], optional: [] },
  { id: "slack", label: "Slack", fields: ["botToken", "appToken"], optional: [] },
  { id: "discord", label: "Discord", fields: ["botToken"], optional: [] },
];

const agents: { id: string }[] = (inst as any).agents || [];

const selectedTypeDef = CHANNEL_TYPES.find((ct) => ct.id === createType);

async function handleCreate() {
  if (!createType || !selectedTypeDef) return;
  setCreateRunning(true);
  setCreateSteps([]);
  setCreateDone(null);

  try {
    const res = await fetch(`/api/lifecycle/${inst.id}/channels/create`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: createType,
        account: createAccount,
        bindAgentIds: createBindAgents,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.done !== undefined) {
            setCreateDone(msg.success);
            if (msg.success) {
              loadChannels();
              // Auto-close form after success
              setTimeout(() => { setShowCreate(false); setCreateSteps([]); setCreateDone(null); setCreateType(""); }, 2000);
            }
          } else {
            setCreateSteps((prev) => {
              const idx = prev.findIndex((s) => s.step === msg.step);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = msg;
                return next;
              }
              return [...prev, msg];
            });
          }
        } catch { /* ignore parse errors */ }
      }
    }
  } catch (err: any) {
    setCreateSteps((prev) => [...prev, { step: "Connection", status: "error", detail: err.message }]);
    setCreateDone(false);
  }
  setCreateRunning(false);
}

function resetCreate() {
  setCreateSteps([]);
  setCreateDone(null);
  setCreateAccount({ accountId: "default", dmPolicy: "open", groupPolicy: "open" });
  setCreateBindAgents([]);
}
```

**Step 2: Add "Add Channel" button next to probe button**

In the header area (~line 1676), after the probe button, add:

```tsx
<button
  onClick={() => { setShowCreate(true); resetCreate(); }}
  className="flex items-center gap-1 px-3 py-1.5 bg-brand hover:bg-brand-light rounded-lg text-sm"
>
  <Plus size={14} /> {t("instance.channelCreate.addChannel")}
</button>
```

Import `Plus` from lucide-react if not already imported.

**Step 3: Add inline form after the header**

After the header div and before the channel list, add:

```tsx
{showCreate && (
  <div className="bg-s1 border border-edge rounded-card shadow-card p-4 space-y-4">
    <h4 className="text-sm font-semibold text-ink">{t("instance.channelCreate.addChannel")}</h4>

    {/* Channel type selector */}
    <div>
      <label className="block text-sm text-ink-2 mb-1">{t("instance.channelCreate.channelType")}</label>
      <select
        value={createType}
        onChange={(e) => { setCreateType(e.target.value); setCreateAccount({ accountId: "default", dmPolicy: "open", groupPolicy: "open" }); }}
        className="w-full px-3 py-2 rounded-lg bg-s2 border border-edge text-ink text-sm"
        disabled={createRunning}
      >
        <option value="">{t("instance.channelCreate.selectType")}</option>
        {CHANNEL_TYPES.map((ct) => (
          <option key={ct.id} value={ct.id}>{ct.label}</option>
        ))}
      </select>
    </div>

    {selectedTypeDef && (
      <>
        {/* Account ID */}
        <div>
          <label className="block text-sm text-ink-2 mb-1">{t("instance.channelCreate.accountId")}</label>
          <input
            value={createAccount.accountId || "default"}
            onChange={(e) => setCreateAccount({ ...createAccount, accountId: e.target.value })}
            className="w-full px-3 py-2 rounded-lg bg-s2 border border-edge text-ink text-sm"
            disabled={createRunning}
          />
        </div>

        {/* Dynamic required fields */}
        {selectedTypeDef.fields.map((f) => (
          <div key={f}>
            <label className="block text-sm text-ink-2 mb-1">{t(`instance.channelCreate.${f}`)}</label>
            <input
              value={createAccount[f] || ""}
              onChange={(e) => setCreateAccount({ ...createAccount, [f]: e.target.value })}
              className="w-full px-3 py-2 rounded-lg bg-s2 border border-edge text-ink text-sm"
              placeholder={f}
              disabled={createRunning}
              type={f.toLowerCase().includes("secret") || f.toLowerCase().includes("token") ? "password" : "text"}
            />
          </div>
        ))}

        {/* Feishu-specific optional fields */}
        {createType === "feishu" && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-ink-2 mb-1">{t("instance.channelCreate.domain")}</label>
              <select
                value={createAccount.domain || "feishu"}
                onChange={(e) => setCreateAccount({ ...createAccount, domain: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-s2 border border-edge text-ink text-sm"
                disabled={createRunning}
              >
                <option value="feishu">Feishu (飞书)</option>
                <option value="lark">Lark (国际版)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-ink-2 mb-1">{t("instance.channelCreate.connectionMode")}</label>
              <select
                value={createAccount.connectionMode || "websocket"}
                onChange={(e) => setCreateAccount({ ...createAccount, connectionMode: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-s2 border border-edge text-ink text-sm"
                disabled={createRunning}
              >
                <option value="websocket">WebSocket</option>
                <option value="webhook">Webhook</option>
              </select>
            </div>
          </div>
        )}

        {/* Policies */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-ink-2 mb-1">{t("instance.channelCreate.dmPolicy")}</label>
            <select
              value={createAccount.dmPolicy || "open"}
              onChange={(e) => setCreateAccount({ ...createAccount, dmPolicy: e.target.value })}
              className="w-full px-3 py-2 rounded-lg bg-s2 border border-edge text-ink text-sm"
              disabled={createRunning}
            >
              <option value="open">Open</option>
              <option value="pairing">Pairing</option>
              <option value="allowlist">Allowlist</option>
            </select>
          </div>
          <div>
            <label className="block text-sm text-ink-2 mb-1">{t("instance.channelCreate.groupPolicy")}</label>
            <select
              value={createAccount.groupPolicy || "open"}
              onChange={(e) => setCreateAccount({ ...createAccount, groupPolicy: e.target.value })}
              className="w-full px-3 py-2 rounded-lg bg-s2 border border-edge text-ink text-sm"
              disabled={createRunning}
            >
              <option value="open">Open</option>
              <option value="allowlist">Allowlist</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
        </div>

        {/* Agent binding multi-select */}
        {agents.length > 0 && (
          <div>
            <label className="block text-sm text-ink-2 mb-1">{t("instance.channelCreate.bindAgents")}</label>
            <div className="flex flex-wrap gap-2">
              {agents.map((a) => (
                <label key={a.id} className="flex items-center gap-1.5 text-sm text-ink cursor-pointer">
                  <input
                    type="checkbox"
                    checked={createBindAgents.includes(a.id)}
                    onChange={(e) => {
                      if (e.target.checked) setCreateBindAgents([...createBindAgents, a.id]);
                      else setCreateBindAgents(createBindAgents.filter((x) => x !== a.id));
                    }}
                    disabled={createRunning}
                    className="rounded"
                  />
                  {a.id}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Progress steps */}
        {createSteps.length > 0 && (
          <div className="space-y-1 text-sm">
            {createSteps.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span>{s.status === "running" ? "⏳" : s.status === "done" ? "✅" : s.status === "error" ? "❌" : "⏭️"}</span>
                <span className={s.status === "error" ? "text-danger" : "text-ink"}>{s.step}</span>
                {s.detail && <span className="text-ink-3 text-xs">{s.detail}</span>}
              </div>
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3 pt-2">
          {createDone === null && (
            <button
              onClick={handleCreate}
              disabled={createRunning || !selectedTypeDef.fields.every((f) => createAccount[f])}
              className="px-4 py-2 bg-brand hover:bg-brand-light rounded-lg text-sm disabled:opacity-50"
            >
              {createRunning ? t("instance.channelCreate.creating") : t("instance.channelCreate.create")}
            </button>
          )}
          {createDone === true && (
            <span className="text-ok text-sm font-medium">{t("instance.channelCreate.success")}</span>
          )}
          {createDone === false && (
            <button onClick={() => { resetCreate(); }} className="px-4 py-2 bg-brand hover:bg-brand-light rounded-lg text-sm">
              {t("instance.channelCreate.retry")}
            </button>
          )}
          <button
            onClick={() => { setShowCreate(false); resetCreate(); }}
            disabled={createRunning}
            className="px-4 py-2 text-sm text-ink-3 hover:text-ink disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
        </div>
      </>
    )}
  </div>
)}
```

**Step 4: Commit**

```bash
git add packages/web/src/pages/Instance.tsx
git commit -m "feat: add channel creation form with SSE progress in ChannelsTab"
```

---

### Task 6: Integration test — run full test suite

**Step 1: Run backend tests**

Run: `npm run test:unit`
Expected: ALL PASS

**Step 2: Run frontend tests**

Run: `npm run test:components`
Expected: ALL PASS

**Step 3: Manual smoke test**

1. Open `http://localhost:7101` → login → go to any instance → Channels tab
2. Click "Add Channel" → select Feishu → fill appId/appSecret → select agents → Create
3. Verify SSE progress steps appear
4. Verify channel appears in list after success

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: channel creation with dependency install, SSE progress, and auto-rollback"
```
