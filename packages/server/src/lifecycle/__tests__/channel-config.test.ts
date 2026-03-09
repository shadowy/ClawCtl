import { describe, it, expect } from "vitest";
import {
  mergeChannelAccountConfig,
  createChannelConfig,
  CHANNEL_DEFS,
} from "../channel-config.js";

describe("mergeChannelAccountConfig", () => {
  it("merges config into channel.accounts.<id>", () => {
    const config = {
      channels: {
        telegram: {
          accounts: {
            default: { enabled: true, dmPolicy: "open" },
          },
        },
      },
    };
    const result = mergeChannelAccountConfig(config, "telegram", "default", {
      dmPolicy: "allowlist",
      allowFrom: ["user1"],
    });
    expect(result.channels.telegram.accounts.default.dmPolicy).toBe("allowlist");
    expect(result.channels.telegram.accounts.default.allowFrom).toEqual(["user1"]);
    expect(result.channels.telegram.accounts.default.enabled).toBe(true);
  });

  it("merges config at channel root when no accounts map", () => {
    const config = {
      channels: {
        telegram: { enabled: true, dmPolicy: "open" },
      },
    };
    const result = mergeChannelAccountConfig(config, "telegram", "default", {
      dmPolicy: "allowlist",
    });
    expect(result.channels.telegram.dmPolicy).toBe("allowlist");
    expect(result.channels.telegram.enabled).toBe(true);
  });

  it("creates accounts map if accountId is not default", () => {
    const config = {
      channels: {
        telegram: { enabled: true },
      },
    };
    const result = mergeChannelAccountConfig(config, "telegram", "bot2", {
      dmPolicy: "disabled",
    });
    expect(result.channels.telegram.accounts.bot2.dmPolicy).toBe("disabled");
  });

  it("preserves other channels", () => {
    const config = {
      channels: {
        telegram: { accounts: { default: { dmPolicy: "open" } } },
        feishu: { accounts: { abc: { dmPolicy: "allowlist" } } },
      },
    };
    const result = mergeChannelAccountConfig(config, "telegram", "default", {
      dmPolicy: "disabled",
    });
    expect(result.channels.feishu.accounts.abc.dmPolicy).toBe("allowlist");
  });

  it("only merges allowed fields", () => {
    const config = {
      channels: {
        telegram: { accounts: { default: { botToken: "secret123", dmPolicy: "open" } } },
      },
    };
    const result = mergeChannelAccountConfig(config, "telegram", "default", {
      dmPolicy: "allowlist",
      botToken: "hacked",
    } as any);
    expect(result.channels.telegram.accounts.default.dmPolicy).toBe("allowlist");
    expect(result.channels.telegram.accounts.default.botToken).toBe("secret123");
  });

  it("throws for unknown channel type", () => {
    const config = { channels: {} };
    expect(() =>
      mergeChannelAccountConfig(config, "nonexistent", "default", { dmPolicy: "open" })
    ).toThrow("Channel not found");
  });
});

describe("createChannelConfig", () => {
  it("adds feishu channel with account to empty config", () => {
    const config = { channels: {} };
    const result = createChannelConfig(config, "feishu", {
      accountId: "myapp",
      appId: "cli_abc",
      appSecret: "secret123",
    }, []);
    expect(result.channels.feishu).toBeDefined();
    expect(result.channels.feishu.enabled).toBe(true);
    expect(result.channels.feishu.accounts.myapp.appId).toBe("cli_abc");
    expect(result.channels.feishu.accounts.myapp.appSecret).toBe("secret123");
  });

  it("adds telegram channel with botToken", () => {
    const config = { channels: {} };
    const result = createChannelConfig(config, "telegram", {
      accountId: "tgbot",
      botToken: "123:ABC",
    }, []);
    expect(result.channels.telegram.enabled).toBe(true);
    expect(result.channels.telegram.accounts.tgbot.botToken).toBe("123:ABC");
  });

  it("binds multiple agents", () => {
    const config = { channels: {}, bindings: [] };
    const result = createChannelConfig(config, "telegram", {
      accountId: "tgbot",
      botToken: "123:ABC",
    }, ["agent-a", "agent-b"]);
    expect(result.bindings).toHaveLength(2);
    expect(result.bindings[0]).toEqual({
      agentId: "agent-a",
      match: { channel: "telegram", accountId: "tgbot" },
    });
    expect(result.bindings[1]).toEqual({
      agentId: "agent-b",
      match: { channel: "telegram", accountId: "tgbot" },
    });
  });

  it("throws if channel already exists", () => {
    const config = { channels: { telegram: { enabled: true } } };
    expect(() =>
      createChannelConfig(config, "telegram", {
        accountId: "bot",
        botToken: "tok",
      }, [])
    ).toThrow("already exists");
  });

  it("throws on unknown channel type", () => {
    const config = { channels: {} };
    expect(() =>
      createChannelConfig(config, "whatsapp", {
        accountId: "wa",
      }, [])
    ).toThrow("Unknown channel type");
  });

  it("preserves existing config sections", () => {
    const config = {
      channels: { feishu: { enabled: true } },
      agents: { list: [{ id: "a1" }] },
      bindings: [{ agentId: "a1", match: { channel: "feishu" } }],
    };
    const result = createChannelConfig(config, "telegram", {
      accountId: "tgbot",
      botToken: "tok",
    }, []);
    expect(result.channels.feishu.enabled).toBe(true);
    expect(result.agents.list[0].id).toBe("a1");
    expect(result.bindings).toHaveLength(1);
  });

  it("auto-adds allowFrom ['*'] when dmPolicy is open", () => {
    const config = { channels: {} };
    const result = createChannelConfig(config, "telegram", {
      accountId: "tgbot",
      botToken: "tok",
      dmPolicy: "open",
    }, []);
    expect(result.channels.telegram.accounts.tgbot.allowFrom).toEqual(["*"]);
  });

  it("does not override allowFrom when dmPolicy is open but allowFrom provided", () => {
    const config = { channels: {} };
    const result = createChannelConfig(config, "telegram", {
      accountId: "tgbot",
      botToken: "tok",
      dmPolicy: "open",
      allowFrom: ["user1"],
    }, []);
    expect(result.channels.telegram.accounts.tgbot.allowFrom).toEqual(["user1"]);
  });

  it("sets dmPolicy and groupPolicy on the channel level", () => {
    const config = { channels: {} };
    const result = createChannelConfig(config, "telegram", {
      accountId: "tgbot",
      botToken: "tok",
      dmPolicy: "allowlist",
      groupPolicy: "disabled",
    }, []);
    expect(result.channels.telegram.dmPolicy).toBe("allowlist");
    expect(result.channels.telegram.groupPolicy).toBe("disabled");
  });

  it("does not include empty-string fields in account", () => {
    const config = { channels: {} };
    const result = createChannelConfig(config, "feishu", {
      accountId: "app1",
      appId: "cli_abc",
      appSecret: "secret",
      domain: "",
    }, []);
    expect(result.channels.feishu.accounts.app1).not.toHaveProperty("domain");
  });
});

describe("CHANNEL_DEFS", () => {
  it("has entries for feishu, telegram, slack, discord", () => {
    expect(CHANNEL_DEFS).toHaveProperty("feishu");
    expect(CHANNEL_DEFS).toHaveProperty("telegram");
    expect(CHANNEL_DEFS).toHaveProperty("slack");
    expect(CHANNEL_DEFS).toHaveProperty("discord");
  });

  it("feishu requires appId and appSecret", () => {
    expect(CHANNEL_DEFS.feishu.requiredFields).toContain("appId");
    expect(CHANNEL_DEFS.feishu.requiredFields).toContain("appSecret");
  });

  it("telegram requires botToken", () => {
    expect(CHANNEL_DEFS.telegram.requiredFields).toContain("botToken");
  });
});
