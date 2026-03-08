export interface GatewayConnection {
  id: string;
  url: string;
  token?: string;
  label?: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  error?: string;
  /** Version from the installed binary (via SSH), more reliable than Gateway handshake */
  binaryVersion?: string;
  /** Original remote port before SSH tunnel rewrite (e.g. 18789) */
  remotePort?: number;
}

export interface InstanceInfo {
  id: string;
  connection: GatewayConnection;
  version?: string;
  health?: HealthStatus;
  agents: AgentInfo[];
  channels: ChannelInfo[];
  sessions: SessionSummary[];
  skills: SkillInfo[];
  config?: Record<string, unknown>;
  securityAudit?: SecurityAuditItem[];
}

export interface HealthStatus {
  status: "ok" | "degraded" | "down";
  version?: string;
  uptime?: string;
  lastChannelRefresh?: string;
}

export interface AgentInfo {
  id: string;
  name?: string;
  workspace?: string;
  model?: string;
  thinking?: string;
  toolsAllow?: string[];
  execSecurity?: { security?: string; host?: string; ask?: string; workspaceOnly?: boolean };
  isDefault?: boolean;
}

export interface ChannelInfo {
  type: string;
  accountId?: string;
  enabled: boolean;
  running: boolean;
  configured: boolean;
}

export interface ChannelAccountInfo {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  connected: boolean;
  restartPending?: boolean;
  reconnectAttempts?: number;
  lastConnectedAt?: number | null;
  lastError?: string | null;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
  busy?: boolean;
  activeRuns?: number;
  dmPolicy?: string;
  groupPolicy?: string;
  allowFrom?: (string | number)[];
  groupAllowFrom?: (string | number)[];
}

export interface ChannelDetail {
  type: string;
  label: string;
  defaultAccountId?: string;
  accounts: ChannelAccountInfo[];
}

export interface ChannelStatusResponse {
  channelOrder: string[];
  channelLabels: Record<string, string>;
  channels: ChannelDetail[];
  defaultAccountIds: Record<string, string>;
}

export interface SessionSummary {
  key: string;
  kind: string;
  model?: string;
  displayName?: string;
  alias?: string;
  channel?: string;
  updatedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface SkillInfo {
  name: string;
  status: "ready" | "missing" | "disabled";
  description?: string;
  source?: string;
}

export interface SecurityAuditItem {
  level: "critical" | "warn" | "info";
  title: string;
  detail: string;
  fix?: string;
}

export interface ToolInfo {
  name: string;
  category: string;
  description?: string;
  enabled: boolean;
  source: string;
}

export interface Binding {
  agentId: string;
  match: {
    channel?: string;
    accountId?: string;
    peer?: { kind: string; id: string };
  };
}
