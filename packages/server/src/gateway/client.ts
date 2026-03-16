import crypto from "node:crypto";
import WebSocket from "ws";
import { EventEmitter } from "events";
import type {
  GatewayConnection,
  InstanceInfo,
  HealthStatus,
  AgentInfo,
  ChannelInfo,
  ChannelDetail,
  ChannelStatusResponse,
  ChannelAccountInfo,
  SessionSummary,
  SkillInfo,
  SecurityAuditItem,
  ToolInfo,
  Binding,
} from "./types.js";

// --- Device identity for Gateway auth ---
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}
interface DeviceIdentity { deviceId: string; publicKeyPem: string; privateKeyPem: string; }
let cachedIdentity: DeviceIdentity | null = null;
function getDeviceIdentity(): DeviceIdentity {
  if (cachedIdentity) return cachedIdentity;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(ED25519_SPKI_PREFIX.length);
  const deviceId = crypto.createHash("sha256").update(raw).digest("hex");
  cachedIdentity = { deviceId, publicKeyPem, privateKeyPem };
  return cachedIdentity;
}
function buildDeviceParams(nonce: string, token?: string) {
  const identity = getDeviceIdentity();
  const signedAt = Date.now();
  const raw = (crypto.createPublicKey(identity.publicKeyPem).export({ type: "spki", format: "der" }) as Buffer).subarray(ED25519_SPKI_PREFIX.length);
  const publicKey = base64UrlEncode(raw);
  const payload = ["v3", identity.deviceId, "gateway-client", "backend", "operator", "operator.admin", String(signedAt), token ?? "", nonce, "node", ""].join("|");
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(identity.privateKeyPem));
  return { id: identity.deviceId, publicKey, signature: base64UrlEncode(sig), signedAt, nonce };
}

export class GatewayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  public conn: GatewayConnection;
  private helloOk: any = null;

  constructor(conn: GatewayConnection) {
    super();
    this.conn = { ...conn, status: "disconnected" };
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.status = "connecting";
      this.emit("status", this.conn);

      this.ws = new WebSocket(this.conn.url);
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.conn.status = "error";
          this.conn.error = "connect timeout";
          this.emit("status", this.conn);
          this.ws?.close();
          reject(new Error("connect timeout"));
        }
      }, 30_000);

      this.ws.on("open", () => {
        // Don't resolve yet — wait for challenge handshake
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handle Gateway challenge-response auth
          if (msg.type === "event" && msg.event === "connect.challenge") {
            const nonce = msg.payload?.nonce;
            if (!nonce) return;
            // Send connect RPC with auth token + device identity
            const connectParams: Record<string, unknown> = {
              minProtocol: 3,
              maxProtocol: 3,
              client: { id: "gateway-client", displayName: "ClawCtl", version: "0.1.0", platform: "node", mode: "backend" },
              role: "operator",
              scopes: ["operator.admin"],
            };
            if (this.conn.token) {
              connectParams.auth = { token: this.conn.token };
            }
            // Add device identity — required when no shared auth token
            try {
              connectParams.device = buildDeviceParams(nonce, this.conn.token);
            } catch { /* skip device identity if generation fails */ }
            this.rpc("connect", connectParams)
              .then((helloOk) => {
                this.helloOk = helloOk;
                // Extract version from hello-ok, falling back to CLI if needed
                const helloVer = helloOk?.server?.version;
                const verMatch = helloVer?.match(/(\d+\.\d+\.\d+)/);
                if (verMatch) {
                  this.conn.binaryVersion = verMatch[1];
                } else if (!this.conn.binaryVersion && this.conn.id.startsWith("local-")) {
                  // Local instance: try to get version from CLI
                  import("child_process").then(({ execSync }) => {
                    try {
                      const out = execSync("openclaw --version 2>/dev/null", { timeout: 3000 }).toString().trim();
                      const m = out.match(/(\d+\.\d+\.\d+)/);
                      if (m) this.conn.binaryVersion = m[1];
                    } catch { /* ignore */ }
                  }).catch(() => {});
                }
                if (!settled) {
                  settled = true;
                  clearTimeout(timeout);
                  this.conn.status = "connected";
                  this.conn.error = undefined;
                  this.emit("status", this.conn);
                  resolve();
                }
              })
              .catch((err) => {
                if (!settled) {
                  settled = true;
                  clearTimeout(timeout);
                  this.conn.status = "error";
                  this.conn.error = err.message;
                  this.emit("status", this.conn);
                  reject(err);
                }
              });
            return;
          }

          // Handle RPC responses (type: "res")
          if (msg.type === "res" && msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.ok === false || msg.error) {
              p.reject(new Error(msg.error?.message || msg.payload?.message || "RPC error"));
            } else {
              p.resolve(msg.payload);
            }
          } else if (msg.type === "event") {
            this.emit("event", msg);
          }
        } catch { /* ignore non-JSON */ }
      });

      this.ws.on("close", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.conn.status = "error";
          this.conn.error = "connection closed during handshake";
          this.emit("status", this.conn);
          reject(new Error("connection closed during handshake"));
        } else if (this.conn.status !== "error") {
          this.conn.status = "disconnected";
          this.emit("status", this.conn);
        }
      });

      this.ws.on("error", (err) => {
        const wasSettled = settled;
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
        }
        this.conn.status = "error";
        this.conn.error = err.message;
        this.emit("status", this.conn);
        if (!wasSettled) reject(err);
      });
    });
  }

  async rpc(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Not connected to ${this.conn.id}`);
    }
    const id = String(++this.requestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 30_000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      // Gateway frame format: { type: "req", id: string, method, params }
      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  async fetchHealth(): Promise<HealthStatus> {
    // Health is derived from the hello-ok connect response
    return {
      status: this.conn.status === "connected" ? "ok" : "degraded",
      version: this.helloOk?.server?.version,
    };
  }

  async fetchAgents(): Promise<AgentInfo[]> {
    const r = await this.rpc("agents.list", {});
    const defaultId = r?.defaultId;
    // agents.list only returns { id, name, identity } — workspace/model/tools
    // come from config in fetchFullInstance()
    return (r?.agents || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      isDefault: a.id === defaultId,
    }));
  }

  async fetchChannels(): Promise<ChannelInfo[]> {
    const r = await this.rpc("channels.status", {});
    const channelOrder: string[] = r?.channelOrder || [];
    const channelAccounts: Record<string, any[]> = r?.channelAccounts || {};
    const result: ChannelInfo[] = [];
    for (const type of channelOrder) {
      for (const a of channelAccounts[type] || []) {
        result.push({
          type,
          accountId: a.accountId || "default",
          enabled: a.enabled ?? true,
          running: a.running ?? false,
          configured: a.configured ?? false,
        });
      }
    }
    return result;
  }

  async fetchChannelDetails(probe = false): Promise<ChannelStatusResponse> {
    const r = await this.rpc("channels.status", probe ? { probe: true, timeoutMs: 10_000 } : {});
    const channelOrder: string[] = r?.channelOrder || [];
    const channelLabels: Record<string, string> = r?.channelLabels || {};
    const channelAccounts: Record<string, any[]> = r?.channelAccounts || {};
    const channelDefaultAccountId: Record<string, string> = r?.channelDefaultAccountId || {};

    const channels: ChannelDetail[] = channelOrder.map((type) => ({
      type,
      label: channelLabels[type] || type,
      defaultAccountId: channelDefaultAccountId[type],
      accounts: (channelAccounts[type] || []).map((a: any) => ({
        accountId: a.accountId || "default",
        name: a.name,
        enabled: a.enabled ?? true,
        configured: a.configured ?? false,
        running: a.running ?? false,
        connected: a.connected ?? false,
        restartPending: a.restartPending,
        reconnectAttempts: a.reconnectAttempts,
        lastConnectedAt: a.lastConnectedAt,
        lastError: a.lastError,
        lastStartAt: a.lastStartAt,
        lastStopAt: a.lastStopAt,
        lastInboundAt: a.lastInboundAt,
        lastOutboundAt: a.lastOutboundAt,
        busy: a.busy,
        activeRuns: a.activeRuns,
        dmPolicy: a.dmPolicy,
        groupPolicy: a.groupPolicy,
        allowFrom: a.allowFrom,
        groupAllowFrom: a.groupAllowFrom,
      })),
    })).filter((ch) => ch.accounts.length > 0);

    return { channelOrder, channelLabels, channels, defaultAccountIds: channelDefaultAccountId };
  }

  async channelLogout(channel: string, accountId?: string): Promise<any> {
    return this.rpc("channels.logout", { channel, ...(accountId ? { accountId } : {}) });
  }

  async fetchSessions(): Promise<SessionSummary[]> {
    const r = await this.rpc("sessions.list", {});
    return (r?.sessions || []).map((s: any) => ({
      key: s.key,
      kind: s.kind,
      model: s.model,
      displayName: s.displayName,
      channel: s.channel,
      updatedAt: s.updatedAt,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      totalTokens: s.totalTokens,
      cacheRead: s.cacheRead || 0,
      cacheWrite: s.cacheWrite || 0,
    }));
  }

  async fetchSkills(): Promise<SkillInfo[]> {
    const r = await this.rpc("skills.status", {});
    return (r?.skills || []).map((sk: any) => ({
      name: sk.name,
      status: sk.eligible ? "ready" : sk.disabled ? "disabled" : "missing",
      description: sk.description,
      source: sk.source,
    }));
  }

  async fetchConfig(): Promise<Record<string, unknown>> {
    const r = await this.rpc("config.get", {});
    return r || {};
  }

  /** Returns the runtime model catalog — includes env-var auto-detected providers */
  async fetchModelCatalog(): Promise<{ id: string; name: string; provider: string }[]> {
    const r = await this.rpc("models.list", {});
    return (r?.models || []).map((m: any) => ({
      id: m.id,
      name: m.name || m.id,
      provider: m.provider || "unknown",
    }));
  }

  async fetchSecurityAudit(): Promise<SecurityAuditItem[]> {
    // Gateway has no security.audit RPC — derive basic checks from config
    const items: SecurityAuditItem[] = [];
    try {
      const config = await this.fetchConfig();
      if (!(config as any)?.gateway?.auth?.token) {
        items.push({ level: "warn", title: "No auth token", detail: "Gateway has no authentication token configured" });
      }
    } catch { /* ignore */ }
    return items;
  }

  async fetchToolsForAgent(agentId: string): Promise<ToolInfo[]> {
    const r = await this.rpc("tools.catalog", { agentId });
    const groups: any[] = r?.groups || [];
    return groups.flatMap((g: any) =>
      (g.tools || []).map((t: any) => ({
        name: t.id || t.name,
        category: g.label || g.id,
        description: t.description,
        enabled: true,
        source: t.source || g.source,
      }))
    );
  }

  async fetchBindings(): Promise<Binding[]> {
    const config = await this.fetchConfig();
    return (config as any)?.bindings || [];
  }

  async fetchSessionHistory(sessionKey: string, limit?: number): Promise<any[]> {
    const r = await this.rpc("chat.history", { sessionKey, ...(limit ? { limit } : {}) });
    return r?.messages || [];
  }

  async fetchFullInstance(): Promise<InstanceInfo> {
    const [health, agents, channels, sessions, skills, config, securityAudit] =
      await Promise.all([
        this.fetchHealth().catch(() => ({ status: "down" as const })),
        this.fetchAgents().catch(() => []),
        this.fetchChannels().catch(() => []),
        this.fetchSessions().catch(() => []),
        this.fetchSkills().catch(() => []),
        this.fetchConfig().catch(() => ({})),
        this.fetchSecurityAudit().catch(() => []),
      ]);

    // Resolve "default" model, thinking level, and tools from config
    const parsed = (config as any)?.parsed;
    const agentsDefaults = parsed?.agents?.defaults || {};
    const defaultModel = agentsDefaults.model?.primary;
    const defaultThinking = agentsDefaults.thinkingDefault;
    // agents.list[] is the per-agent config array (not agents.agents{})
    const agentList: any[] = parsed?.agents?.list || [];
    const agentConfigMap = new Map(agentList.map((a: any) => [a.id?.toLowerCase(), a]));
    const resolvedAgents = agents.map((a) => {
      const perAgent = agentConfigMap.get(a.id?.toLowerCase()) || {};
      const model = (!a.model || a.model === "default")
        ? (perAgent.model?.primary || defaultModel || a.model)
        : a.model;
      const thinking = perAgent.thinkingDefault || defaultThinking;
      // Resolve toolsAllow from config if not in RPC response
      const toolsAllow = a.toolsAllow?.length ? a.toolsAllow : (perAgent.tools?.allow || []);
      const exec = perAgent.tools?.exec;
      const execSecurity = exec ? { security: exec.security, host: exec.host, ask: exec.ask, workspaceOnly: exec.applyPatch?.workspaceOnly } : undefined;
      return { ...a, model, toolsAllow, ...(thinking ? { thinking } : {}), ...(execSecurity ? { execSecurity } : {}) };
    });

    return {
      id: this.conn.id,
      connection: this.conn,
      version: this.conn.binaryVersion || ((health as any)?.version?.match(/(\d+\.\d+\.\d+)/)?.[1]) || (health as any)?.version,
      health: health as HealthStatus,
      agents: resolvedAgents,
      channels,
      sessions,
      skills,
      config,
      securityAudit,
    };
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this.conn.status = "disconnected";
  }
}
