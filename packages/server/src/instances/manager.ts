import { EventEmitter } from "events";
import type Database from "better-sqlite3";
import { GatewayClient } from "../gateway/client.js";
import { discoverLocalInstances } from "./discovery.js";
import type { GatewayConnection, InstanceInfo } from "../gateway/types.js";

export class InstanceManager extends EventEmitter {
  private clients = new Map<string, GatewayClient>();
  private instances = new Map<string, InstanceInfo>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempts = new Map<string, number>();
  private db?: Database.Database;
  onTunnelRebuild?: (id: string) => Promise<string | null>;

  constructor(db?: Database.Database) {
    super();
    this.db = db;
  }

  async init() {
    // Load persisted instances from DB
    if (this.db) {
      const rows = this.db.prepare("SELECT id, url, token, label FROM instances").all() as Array<{ id: string; url: string; token: string | null; label: string | null }>;
      for (const row of rows) {
        this.connectInstance({ id: row.id, url: row.url, token: row.token || undefined, label: row.label || undefined, status: "disconnected" });
      }
    }

    // Also discover local instances (always update to pick up fresh tokens)
    const local = discoverLocalInstances();
    for (const conn of local) {
      this.addInstance(conn);
    }
  }

  addInstance(conn: GatewayConnection): void {
    this.persistInstance(conn);
    const existing = this.clients.get(conn.id);
    if (existing) {
      // Update token/url on existing connection and reconnect if changed
      const changed = existing.conn.token !== conn.token || existing.conn.url !== conn.url;
      if (changed) {
        existing.conn.token = conn.token;
        existing.conn.url = conn.url;
        if (conn.label) existing.conn.label = conn.label;
        this.doConnect(conn.id);
      }
      return;
    }
    this.connectInstance(conn);
  }

  private persistInstance(conn: GatewayConnection) {
    if (!this.db) return;
    this.db.prepare(
      "INSERT INTO instances (id, url, token, label) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET url=excluded.url, token=excluded.token, label=excluded.label"
    ).run(conn.id, conn.url, conn.token || null, conn.label || null);
  }

  private connectInstance(conn: GatewayConnection) {
    if (this.clients.has(conn.id)) return;

    const client = new GatewayClient(conn);
    this.clients.set(conn.id, client);

    // Immediately register with empty data so it shows up in the dashboard
    this.instances.set(conn.id, {
      id: conn.id,
      connection: client.conn,
      agents: [],
      channels: [],
      sessions: [],
      skills: [],
    });
    this.emit("change");

    let prevStatus = client.conn.status;
    client.on("status", () => {
      const newStatus = client.conn.status;
      // Log transitions to disconnected/error as potential crash events
      if (prevStatus === "connected" && (newStatus === "disconnected" || newStatus === "error")) {
        this.logSystemEvent(conn.id, "instance.disconnected",
          `Instance ${conn.label || conn.id} went ${newStatus} (was connected)`);
      }
      prevStatus = newStatus;
      this.emit("change");
      if (newStatus === "disconnected" || newStatus === "error") {
        this.scheduleReconnect(conn.id);
      }
    });

    this.doConnect(conn.id);
  }

  private doConnect(id: string) {
    const client = this.clients.get(id);
    if (!client) return;
    client.connect()
      .then(() => client.fetchFullInstance())
      .then((info) => {
        this.instances.set(id, info);
        this.reconnectAttempts.delete(id);
        this.emit("change");
      })
      .catch(() => {});
  }

  private scheduleReconnect(id: string) {
    if (this.reconnectTimers.has(id)) return;
    const attempts = this.reconnectAttempts.get(id) || 0;
    if (attempts >= 10) return; // will be retried by periodic health check
    const delay = Math.min(5_000 * Math.pow(2, attempts), 60_000);
    this.reconnectAttempts.set(id, attempts + 1);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(id);
      this.reconnect(id);
    }, delay);
    this.reconnectTimers.set(id, timer);
  }

  private async reconnect(id: string) {
    const client = this.clients.get(id);
    if (!client) return;
    // For SSH instances, rebuild the tunnel first
    if (id.startsWith("ssh-") && this.onTunnelRebuild) {
      try {
        const newUrl = await this.onTunnelRebuild(id);
        if (newUrl) {
          client.conn.url = newUrl;
        }
      } catch { /* proceed with existing URL */ }
    }
    this.doConnect(id);
  }

  removeInstance(id: string) {
    const timer = this.reconnectTimers.get(id);
    if (timer) { clearTimeout(timer); this.reconnectTimers.delete(id); }
    this.reconnectAttempts.delete(id);
    this.clients.get(id)?.disconnect();
    this.clients.delete(id);
    this.instances.delete(id);
    if (this.db) {
      this.db.prepare("DELETE FROM instances WHERE id = ?").run(id);
    }
    this.emit("change");
  }

  async refreshInstance(id: string): Promise<InstanceInfo | null> {
    const client = this.clients.get(id);
    if (!client || client.conn.status !== "connected") return null;
    const info = await client.fetchFullInstance();
    // Preserve previous data for fields that came back empty due to transient errors
    const prev = this.instances.get(id);
    if (prev) {
      if (!info.securityAudit?.length && prev.securityAudit?.length) info.securityAudit = prev.securityAudit;
      if (!info.agents.length && prev.agents.length) info.agents = prev.agents;
      if (!info.sessions.length && prev.sessions.length) info.sessions = prev.sessions;
      if (!info.skills.length && prev.skills.length) info.skills = prev.skills;
    }
    this.instances.set(id, info);
    this.emit("change");
    return info;
  }

  async refreshAll(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.keys()].map((id) => this.refreshInstance(id))
    );
    // Also retry disconnected instances that exhausted their reconnect attempts
    this.retryDisconnected();
  }

  /** Retry all disconnected/errored instances that have no pending reconnect timer */
  private retryDisconnected() {
    for (const [id, client] of this.clients) {
      const status = client.conn.status;
      if ((status === "disconnected" || status === "error") && !this.reconnectTimers.has(id)) {
        console.log(`[manager] health check: retrying ${client.conn.label || id}`);
        this.reconnectAttempts.set(id, 0); // reset counter
        this.reconnect(id);
      }
    }
  }

  startAutoRefresh(intervalMs = 30_000) {
    this.refreshTimer = setInterval(() => this.refreshAll(), intervalMs);
  }

  stopAutoRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  getAll(): InstanceInfo[] {
    return [...this.instances.values()];
  }

  get(id: string): InstanceInfo | undefined {
    return this.instances.get(id);
  }

  getClient(id: string): GatewayClient | undefined {
    return this.clients.get(id);
  }

  listConnections(): GatewayConnection[] {
    return [...this.clients.values()].map((c) => c.conn);
  }

  private logSystemEvent(instanceId: string, type: string, detail: string) {
    if (!this.db) return;
    try {
      this.db.prepare(
        "INSERT INTO operations (instance_id, type, status, output, operator, finished_at) VALUES (?, ?, 'error', ?, 'system', datetime('now'))"
      ).run(instanceId, type, detail);
    } catch { /* DB might not be ready yet during startup */ }
  }

  shutdown() {
    this.stopAutoRefresh();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
    this.instances.clear();
  }
}
