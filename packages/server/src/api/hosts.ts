import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { HostStore } from "../hosts/store.js";
import type { InstanceManager } from "../instances/manager.js";
import { discoverRemoteInstances } from "../hosts/discovery.js";
import { ensureTunnel, closeTunnelsForHost } from "../hosts/tunnel.js";
import { requireRole } from "../auth/middleware.js";
import { auditLog } from "../audit.js";

export function hostRoutes(hostStore: HostStore, manager: InstanceManager, db: Database.Database) {
  const app = new Hono();

  // All host management requires admin
  app.use("/*", requireRole("admin"));

  // List all remote hosts (credentials masked)
  app.get("/", (c) => {
    return c.json(hostStore.list());
  });

  // Add a remote host
  app.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.host || !body.username || !body.credential) {
      return c.json({ error: "host, username, and credential are required" }, 400);
    }
    const port = body.port || 22;
    const existing = hostStore.findByConnection(body.host, port, body.username);
    if (existing) {
      return c.json({ error: "duplicate", existingId: existing.id, label: existing.label }, 409);
    }
    const host = hostStore.create({
      label: body.label || body.host,
      host: body.host,
      port: body.port || 22,
      username: body.username,
      authMethod: body.authMethod || "password",
      credential: body.credential,
    });
    auditLog(db, c, "host.create", `Added remote host: ${host.label} (${body.host})`);
    return c.json(host, 201);
  });

  // Update a remote host
  app.put("/:id", async (c) => {
    const id = parseInt(c.req.param("id"));
    const body = await c.req.json();
    const host = hostStore.update(id, body);
    if (!host) return c.json({ error: "host not found" }, 404);
    auditLog(db, c, "host.update", `Updated host #${id}: ${host.label}`);
    return c.json(host);
  });

  // Delete a remote host
  app.delete("/:id", (c) => {
    const id = parseInt(c.req.param("id"));
    if (!hostStore.delete(id)) return c.json({ error: "host not found" }, 404);
    closeTunnelsForHost(id);
    auditLog(db, c, "host.delete", `Deleted host #${id}`);
    return c.json({ ok: true });
  });

  // Remove duplicate hosts (keep the one with lowest id per host+port+username)
  app.post("/dedup", (c) => {
    const all = hostStore.list();
    const seen = new Map<string, number>();
    const removed: number[] = [];
    for (const h of all) {
      const key = `${h.host}:${h.port}:${h.username}`;
      if (seen.has(key)) {
        hostStore.delete(h.id);
        closeTunnelsForHost(h.id);
        removed.push(h.id);
      } else {
        seen.set(key, h.id);
      }
    }
    if (removed.length) {
      auditLog(db, c, "host.dedup", `Removed ${removed.length} duplicate host(s): ${removed.join(", ")}`);
    }
    return c.json({ ok: true, removed: removed.length, removedIds: removed });
  });

  // Scan a remote host for OpenClaw instances
  app.post("/:id/scan", async (c) => {
    const id = parseInt(c.req.param("id"));
    console.log(`[hosts] scan request for host ${id}`);
    const host = hostStore.list().find((h) => h.id === id);
    if (!host) { console.log("[hosts] host not found"); return c.json({ error: "host not found" }, 404); }

    console.log(`[hosts] decrypting credential for ${host.label}`);
    const cred = hostStore.getDecryptedCredential(id);
    if (!cred) { console.log("[hosts] credential not found"); return c.json({ error: "credential not found" }, 500); }
    console.log(`[hosts] credential decrypted, length=${cred.length}, auth=${host.authMethod}`);

    const credential = host.authMethod === "password"
      ? { password: cred }
      : { privateKey: cred };

    let connections;
    try {
      connections = await discoverRemoteInstances(host, credential);
      console.log(`[hosts] discovered ${connections.length} instances`);
    } catch (err: any) {
      console.error(`[hosts] SSH error:`, err);
      const errMsg = err.message || String(err);
      hostStore.updateScanResult(id, errMsg);
      return c.json({ error: errMsg }, 502);
    }

    hostStore.updateScanResult(id, null);

    // Create SSH tunnels and rewrite URLs to go through local port forwards
    for (const conn of connections) {
      try {
        const remotePort = parseInt(new URL(conn.url.replace("ws://", "http://")).port) || 18789;
        const localPort = await ensureTunnel(host, remotePort, credential);
        conn.url = `ws://127.0.0.1:${localPort}`;
      } catch (err: any) {
        console.error(`[hosts] tunnel error for ${conn.id}:`, err.message);
      }
      manager.addInstance(conn);
    }

    const instances = connections.map((cn) => ({ id: cn.id, url: cn.url, label: cn.label }));
    return c.json({ discovered: connections.length, added: connections.length, instances });
  });

  // Scan all hosts
  app.post("/scan-all", async (c) => {
    const hosts = hostStore.list();
    const results: Array<{ hostId: number; label: string; discovered: number; error?: string }> = [];

    for (const host of hosts) {
      const cred = hostStore.getDecryptedCredential(host.id);
      if (!cred) {
        results.push({ hostId: host.id, label: host.label, discovered: 0, error: "credential error" });
        continue;
      }

      const credential = host.authMethod === "password"
        ? { password: cred }
        : { privateKey: cred };

      try {
        const connections = await discoverRemoteInstances(host, credential);
        hostStore.updateScanResult(host.id, null);
        for (const conn of connections) {
          try {
            const remotePort = parseInt(new URL(conn.url.replace("ws://", "http://")).port) || 18789;
            const localPort = await ensureTunnel(host, remotePort, credential);
            conn.url = `ws://127.0.0.1:${localPort}`;
          } catch { /* tunnel failed, keep original url */ }
          manager.addInstance(conn);
        }
        results.push({ hostId: host.id, label: host.label, discovered: connections.length });
      } catch (err: any) {
        const errMsg = err.message || String(err);
        hostStore.updateScanResult(host.id, errMsg);
        results.push({ hostId: host.id, label: host.label, discovered: 0, error: errMsg });
      }
    }

    return c.json(results);
  });

  return app;
}
