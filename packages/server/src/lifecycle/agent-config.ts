// Grouped by provider, newest first within each group
const MODELS_BY_PROVIDER: Record<string, string[]> = {
  openai: [
    "openai-codex/gpt-5.3-codex",
    "openai-codex/gpt-5.2-codex",
    "openai-codex/gpt-5.1-codex",
    "openai-codex/gpt-5.1-codex-mini",
    "openai/gpt-4.1",
    "openai/gpt-4.1-mini",
    "openai/gpt-4.1-nano",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "openai/o4-mini",
    "openai/o3",
    "openai/o3-mini",
  ],
  anthropic: [
    "anthropic/claude-opus-4-6",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-sonnet-4-5-20250514",
    "anthropic/claude-haiku-4-5-20251001",
  ],
  deepseek: [
    "deepseek/deepseek-chat",
    "deepseek/deepseek-reasoner",
  ],
  google: [
    "google/gemini-2.5-pro",
    "google/gemini-2.5-flash",
    "google/gemini-2.0-flash",
  ],
};

// Flat list for backward compatibility (extractModels seed)
const COMMON_MODELS = Object.values(MODELS_BY_PROVIDER).flat();

export interface AgentFormData {
  id: string;
  model: string;
  thinkingDefault: string;
  toolsAllow: string[];
  execSecurity: string;
  workspace: string;
  workspaceOnly: boolean;
  fsWorkspaceOnly: boolean;
}

export interface AgentConfigPayload {
  defaults: { model: string; thinkingDefault: string };
  agents: AgentFormData[];
}

export function extractModels(config: any): {
  models: string[];
  modelsByProvider: Record<string, string[]>;
  defaultModel: string;
} {
  const agents = config?.agents || {};
  const defaultModel = agents.defaults?.model?.primary || "";
  const set = new Set<string>(COMMON_MODELS);
  if (defaultModel) set.add(defaultModel);
  for (const a of agents.list || []) {
    if (a.model?.primary) set.add(a.model.primary);
  }
  // Build grouped result: start from known providers, add unknown models to "other"
  const grouped: Record<string, string[]> = {};
  const knownModels = new Set<string>(COMMON_MODELS);
  for (const [provider, list] of Object.entries(MODELS_BY_PROVIDER)) {
    grouped[provider] = [...list];
  }
  const extras = [...set].filter((m) => !knownModels.has(m));
  if (extras.length > 0) {
    grouped.other = extras;
  }
  return { models: [...set], modelsByProvider: grouped, defaultModel };
}

export function mergeAgentConfig(config: any, payload: AgentConfigPayload): any {
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.list) config.agents.list = [];

  if (payload.defaults.model) {
    if (!config.agents.defaults.model) config.agents.defaults.model = {};
    config.agents.defaults.model.primary = payload.defaults.model;
  } else {
    delete config.agents.defaults.model;
  }
  if (payload.defaults.thinkingDefault) {
    config.agents.defaults.thinkingDefault = payload.defaults.thinkingDefault;
  } else {
    delete config.agents.defaults.thinkingDefault;
  }

  const existingMap = new Map<string, any>();
  for (const a of config.agents.list) {
    existingMap.set(a.id, a);
  }

  config.agents.list = payload.agents.map((input) => {
    const existing = existingMap.get(input.id);
    if (existing) {
      if (input.model) {
        existing.model = { ...existing.model, primary: input.model };
      } else {
        delete existing.model;
      }
      if (input.thinkingDefault) {
        existing.thinkingDefault = input.thinkingDefault;
      } else {
        delete existing.thinkingDefault;
      }
      if (input.workspace) {
        existing.workspace = input.workspace;
      } else {
        delete existing.workspace;
      }
      if (!existing.tools) existing.tools = {};
      existing.tools.allow = input.toolsAllow;
      if (input.execSecurity) {
        if (!existing.tools.exec) existing.tools.exec = {};
        existing.tools.exec.security = input.execSecurity;
        if (!existing.tools.exec.applyPatch) existing.tools.exec.applyPatch = {};
        existing.tools.exec.applyPatch.workspaceOnly = input.workspaceOnly;
      }
      if (!existing.tools.fs) existing.tools.fs = {};
      existing.tools.fs.workspaceOnly = input.fsWorkspaceOnly;
      return existing;
    }
    const entry: any = { id: input.id };
    if (input.model) entry.model = { primary: input.model };
    if (input.thinkingDefault) entry.thinkingDefault = input.thinkingDefault;
    if (input.workspace) entry.workspace = input.workspace;
    const tools: any = { allow: input.toolsAllow };
    if (input.execSecurity) {
      tools.exec = { security: input.execSecurity, applyPatch: { workspaceOnly: input.workspaceOnly } };
    }
    tools.fs = { workspaceOnly: input.fsWorkspaceOnly };
    entry.tools = tools;
    return entry;
  });

  return config;
}

export function removeAgent(config: any, agentId: string): any {
  const list: any[] = config.agents?.list || [];
  const idx = list.findIndex((a) => a.id === agentId);
  if (idx === -1) throw new Error("Agent not found: " + agentId);
  list.splice(idx, 1);
  if (Array.isArray(config.bindings)) {
    config.bindings = config.bindings.filter((b: any) => b.agentId !== agentId);
  }
  return config;
}
