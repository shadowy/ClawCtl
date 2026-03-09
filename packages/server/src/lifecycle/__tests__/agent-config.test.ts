import { describe, it, expect } from "vitest";
import { extractModels, mergeAgentConfig, removeAgent } from "../agent-config.js";

const SAMPLE_CONFIG = {
  gateway: { port: 18789 },
  agents: {
    defaults: {
      model: { primary: "gpt-4o" },
      thinkingDefault: "full",
    },
    list: [
      {
        id: "main",
        model: { primary: "claude-sonnet-4-5-20250514" },
        tools: {
          allow: ["read", "search", "exec"],
          exec: { security: "allowlist", host: "localhost", ask: true, applyPatch: { workspaceOnly: true } },
        },
      },
      {
        id: "dev",
        model: { primary: "gpt-4o-mini" },
        tools: { allow: ["read", "search"] },
      },
    ],
  },
  channels: { feishu: { enabled: true } },
  bindings: [
    { agentId: "main", match: { channel: "feishu" } },
    { agentId: "dev", match: { channel: "slack" } },
  ],
};

describe("extractModels", () => {
  it("returns unique models from defaults + agents + common list", () => {
    const result = extractModels(SAMPLE_CONFIG);
    expect(result.defaultModel).toBe("gpt-4o");
    // Config models (without prefix) are included
    expect(result.models).toContain("gpt-4o");
    expect(result.models).toContain("claude-sonnet-4-5-20250514");
    expect(result.models).toContain("gpt-4o-mini");
    // Preset models use provider/ prefix
    expect(result.models).toContain("anthropic/claude-haiku-4-5-20251001");
    const unique = new Set(result.models);
    expect(unique.size).toBe(result.models.length);
    // Grouped models include known providers
    expect(result.modelsByProvider).toHaveProperty("openai");
    expect(result.modelsByProvider).toHaveProperty("anthropic");
    // Config models and preset models both present in groups
    expect(result.modelsByProvider.anthropic).toContain("anthropic/claude-sonnet-4-6");
    // Config model without prefix lands in "other" group
    expect(result.modelsByProvider.other).toContain("claude-sonnet-4-5-20250514");
  });

  it("handles missing agents section gracefully", () => {
    const result = extractModels({ gateway: {} });
    expect(result.defaultModel).toBe("");
    expect(result.models.length).toBeGreaterThan(0);
    expect(Object.keys(result.modelsByProvider).length).toBeGreaterThan(0);
  });
});

describe("mergeAgentConfig", () => {
  it("updates defaults model and thinking", () => {
    const result = mergeAgentConfig(structuredClone(SAMPLE_CONFIG), {
      defaults: { model: "gpt-4o-mini", thinkingDefault: "disabled" },
      agents: [],
    });
    expect(result.agents.defaults.model.primary).toBe("gpt-4o-mini");
    expect(result.agents.defaults.thinkingDefault).toBe("disabled");
  });

  it("updates existing agent preserving unknown fields", () => {
    const result = mergeAgentConfig(structuredClone(SAMPLE_CONFIG), {
      defaults: { model: "gpt-4o", thinkingDefault: "full" },
      agents: [
        { id: "main", model: "gpt-4o", thinkingDefault: "full", toolsAllow: ["read"], execSecurity: "full", workspace: "", workspaceOnly: false, fsWorkspaceOnly: false },
      ],
    });
    const main = result.agents.list.find((a: any) => a.id === "main");
    expect(main.model.primary).toBe("gpt-4o");
    // thinkingDefault should NOT be on individual agents (only agents.defaults)
    expect(main.thinkingDefault).toBeUndefined();
    expect(main.tools.allow).toEqual(["read"]);
    expect(main.tools.exec.security).toBe("full");
    expect(main.tools.exec.applyPatch.workspaceOnly).toBe(false);
    expect(main.tools.fs.workspaceOnly).toBe(false);
    expect(main.tools.exec.host).toBe("localhost");
    expect(main.tools.exec.ask).toBe(true);
  });

  it("adds new agent", () => {
    const result = mergeAgentConfig(structuredClone(SAMPLE_CONFIG), {
      defaults: { model: "gpt-4o", thinkingDefault: "full" },
      agents: [
        { id: "main", model: "claude-sonnet-4-5-20250514", thinkingDefault: "brief", toolsAllow: ["read", "search", "exec"], execSecurity: "allowlist", workspace: "", workspaceOnly: true, fsWorkspaceOnly: true },
        { id: "dev", model: "gpt-4o-mini", thinkingDefault: "", toolsAllow: ["read", "search"], execSecurity: "", workspace: "", workspaceOnly: false, fsWorkspaceOnly: false },
        { id: "newbot", model: "gpt-4o", thinkingDefault: "full", toolsAllow: ["*"], execSecurity: "full", workspace: "/home/user/proj", workspaceOnly: false, fsWorkspaceOnly: false },
      ],
    });
    expect(result.agents.list).toHaveLength(3);
    const newbot = result.agents.list.find((a: any) => a.id === "newbot");
    expect(newbot).toBeDefined();
    expect(newbot.model.primary).toBe("gpt-4o");
    expect(newbot.workspace).toBe("/home/user/proj");
    expect(newbot.tools.allow).toEqual(["*"]);
    expect(newbot.tools.fs.workspaceOnly).toBe(false);
  });

  it("preserves non-agents config (gateway, channels, etc.)", () => {
    const result = mergeAgentConfig(structuredClone(SAMPLE_CONFIG), {
      defaults: { model: "gpt-4o", thinkingDefault: "full" },
      agents: [],
    });
    expect(result.gateway.port).toBe(18789);
    expect(result.channels.feishu.enabled).toBe(true);
  });

  it("creates agents section if missing", () => {
    const config = { gateway: { port: 18789 } };
    const result = mergeAgentConfig(config, {
      defaults: { model: "gpt-4o", thinkingDefault: "full" },
      agents: [{ id: "first", model: "gpt-4o", thinkingDefault: "", toolsAllow: [], execSecurity: "", workspace: "", workspaceOnly: false, fsWorkspaceOnly: false }],
    });
    expect(result.agents.defaults.model.primary).toBe("gpt-4o");
    expect(result.agents.list).toHaveLength(1);
  });
});

describe("removeAgent", () => {
  it("removes agent from list", () => {
    const result = removeAgent(structuredClone(SAMPLE_CONFIG), "dev");
    expect(result.agents.list).toHaveLength(1);
    expect(result.agents.list[0].id).toBe("main");
  });

  it("removes associated bindings", () => {
    const result = removeAgent(structuredClone(SAMPLE_CONFIG), "dev");
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].agentId).toBe("main");
  });

  it("throws if agent not found", () => {
    expect(() => removeAgent(structuredClone(SAMPLE_CONFIG), "nonexistent")).toThrow("Agent not found");
  });

  it("works when no bindings array exists", () => {
    const config = structuredClone(SAMPLE_CONFIG);
    delete (config as any).bindings;
    const result = removeAgent(config, "dev");
    expect(result.agents.list).toHaveLength(1);
  });
});
