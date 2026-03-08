import { EventEmitter } from "events";
import type { InstanceInfo, GatewayConnection } from "../../gateway/types.js";
import type { GatewayClient } from "../../gateway/client.js";
import { makeInstanceInfo } from "./fixtures.js";

export class MockInstanceManager extends EventEmitter {
  private instances = new Map<string, InstanceInfo>();
  private mockClients = new Map<string, Partial<GatewayClient>>();

  seed(infos: InstanceInfo[]) {
    for (const info of infos) {
      this.instances.set(info.id, info);
      this.mockClients.set(info.id, {
        conn: info.connection,
        fetchSessionHistory: async () => [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
        ],
        fetchToolsForAgent: async () => [
          { name: "exec", category: "Runtime", description: "Execute commands", enabled: true, source: "core" },
        ],
        fetchChannelDetails: async () => ({
          channelOrder: ["telegram"],
          channelLabels: { telegram: "Telegram" },
          channels: [{
            type: "telegram",
            label: "Telegram",
            defaultAccountId: "default",
            accounts: [{ accountId: "default", enabled: true, configured: true, running: true, connected: true }],
          }],
          defaultAccountIds: { telegram: "default" },
        }),
        channelLogout: async () => ({ ok: true }),
      } as any);
    }
  }

  getAll(): InstanceInfo[] {
    return [...this.instances.values()];
  }

  get(id: string): InstanceInfo | undefined {
    return this.instances.get(id);
  }

  getClient(id: string): GatewayClient | undefined {
    return this.mockClients.get(id) as GatewayClient | undefined;
  }

  addInstance(conn: GatewayConnection): void {
    if (this.instances.has(conn.id)) return;
    this.instances.set(conn.id, makeInstanceInfo({ id: conn.id, connection: conn }));
  }

  removeInstance(id: string) {
    this.instances.delete(id);
    this.mockClients.delete(id);
  }

  async refreshInstance(id: string): Promise<InstanceInfo | null> {
    return this.instances.get(id) || null;
  }

  listConnections(): GatewayConnection[] {
    return [...this.instances.values()].map((i) => i.connection);
  }
}
