export interface ChannelDef {
  label: string;
  requiredFields: string[];
  optionalFields: string[];
  extensionDir: string;
  depCheckPath: string;
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
    extensionDir: "",
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
  appId?: string;
  appSecret?: string;
  domain?: string;
  connectionMode?: string;
  botToken?: string;
  appToken?: string;
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
  if (!def) throw new Error(`Unknown channel type: ${channel}`);

  if (config.channels?.[channel]) {
    throw new Error(`Channel already exists: ${channel}`);
  }

  const result = JSON.parse(JSON.stringify(config));
  if (!result.channels) result.channels = {};

  // Build account object from required + optional fields, excluding empty strings
  const account: Record<string, unknown> = {};
  const allFields = [...def.requiredFields, ...def.optionalFields];
  for (const field of allFields) {
    const value = (input as any)[field];
    if (value !== undefined && value !== "") {
      account[field] = value;
    }
  }

  // Auto-add allowFrom when dmPolicy is open and no allowFrom provided
  if (input.dmPolicy === "open" && (!input.allowFrom || input.allowFrom.length === 0)) {
    account.allowFrom = ["*"];
  } else if (input.allowFrom && input.allowFrom.length > 0) {
    account.allowFrom = input.allowFrom;
  }

  // Build channel config
  const chConfig: Record<string, unknown> = {
    enabled: true,
    accounts: { [input.accountId]: account },
  };
  if (input.dmPolicy) chConfig.dmPolicy = input.dmPolicy;
  if (input.groupPolicy) chConfig.groupPolicy = input.groupPolicy;

  result.channels[channel] = chConfig;

  // Add bindings
  if (bindAgentIds.length > 0) {
    if (!result.bindings) result.bindings = [];
    for (const agentId of bindAgentIds) {
      result.bindings.push({
        agentId,
        match: { channel, accountId: input.accountId },
      });
    }
  }

  return result;
}

const ALLOWED_FIELDS = new Set([
  "enabled",
  "dmPolicy",
  "groupPolicy",
  "allowFrom",
  "groupAllowFrom",
  "historyLimit",
  "dmHistoryLimit",
  "textChunkLimit",
  "chunkMode",
  "blockStreaming",
]);

export interface ChannelAccountConfigUpdate {
  enabled?: boolean;
  dmPolicy?: string;
  groupPolicy?: string;
  allowFrom?: (string | number)[];
  groupAllowFrom?: (string | number)[];
  historyLimit?: number;
  dmHistoryLimit?: number;
  textChunkLimit?: number;
  chunkMode?: string;
  blockStreaming?: boolean;
}

export function mergeChannelAccountConfig(
  config: any,
  channel: string,
  accountId: string,
  update: ChannelAccountConfigUpdate,
): any {
  const channels = config?.channels || {};
  const chConfig = channels[channel];
  if (!chConfig) throw new Error(`Channel not found: ${channel}`);

  const result = JSON.parse(JSON.stringify(config));
  const chResult = result.channels[channel];

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (ALLOWED_FIELDS.has(key)) filtered[key] = value;
  }

  if (chResult.accounts?.[accountId]) {
    Object.assign(chResult.accounts[accountId], filtered);
  } else if (accountId === "default" && !chResult.accounts) {
    Object.assign(chResult, filtered);
  } else {
    if (!chResult.accounts) chResult.accounts = {};
    chResult.accounts[accountId] = { ...filtered };
  }

  return result;
}
