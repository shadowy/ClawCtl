import { Client } from "ssh2";
import net from "net";
import type { RemoteHost } from "./types.js";

interface TunnelInfo {
  localPort: number;
  remotePort: number;
  sshConn: Client;
  server: net.Server;
}

const activeTunnels = new Map<string, TunnelInfo>();

// Starting port for local forwards — configurable via env
const TUNNEL_PORT_START = parseInt(process.env.CLAWCTL_TUNNEL_PORT_START || "19000");
const TUNNEL_PORT_END = parseInt(process.env.CLAWCTL_TUNNEL_PORT_END || "19999");
let nextLocalPort = TUNNEL_PORT_START;

function getNextPort(): number {
  if (nextLocalPort > TUNNEL_PORT_END) {
    throw new Error("Tunnel port exhausted: exceeded range " + TUNNEL_PORT_START + "-" + TUNNEL_PORT_END);
  }
  return nextLocalPort++;
}

function tunnelKey(hostId: number, remotePort: number): string {
  return `${hostId}:${remotePort}`;
}

export function getLocalPort(hostId: number, remotePort: number): number | undefined {
  return activeTunnels.get(tunnelKey(hostId, remotePort))?.localPort;
}

export async function ensureTunnel(
  host: RemoteHost,
  remotePort: number,
  credential: { password?: string; privateKey?: string },
): Promise<number> {
  const key = tunnelKey(host.id, remotePort);

  // Already have a tunnel for this
  const existing = activeTunnels.get(key);
  if (existing) return existing.localPort;

  const localPort = getNextPort();
  console.log(`[tunnel] creating ${host.host}:${remotePort} -> 127.0.0.1:${localPort}`);

  const sshConn = new Client();

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      sshConn.end();
      reject(new Error(`SSH tunnel timeout for ${host.host}`));
    }, 15_000);

    sshConn.on("ready", () => {
      clearTimeout(timeout);
      resolve();
    });

    sshConn.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    sshConn.connect({
      host: host.host,
      port: host.port,
      username: host.username,
      password: credential.password,
      privateKey: credential.privateKey,
      readyTimeout: 10_000,
      keepaliveInterval: 30_000,
    });
  });

  // Create local TCP server that forwards through SSH
  const server = net.createServer((socket) => {
    sshConn.forwardOut(
      "127.0.0.1",
      localPort,
      "127.0.0.1",
      remotePort,
      (err, stream) => {
        if (err) {
          socket.end();
          return;
        }
        socket.pipe(stream).pipe(socket);
      },
    );
  });

  // Try binding, auto-increment port on EADDRINUSE (up to 10 retries)
  let boundPort = localPort;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(boundPort, "127.0.0.1", () => {
          server.removeAllListeners("error");
          resolve();
        });
      });
      break;
    } catch (err: any) {
      if (err.code === "EADDRINUSE" && attempt < 9) {
        boundPort = getNextPort();
        continue;
      }
      throw err;
    }
  }

  // Handle SSH disconnect — clean up tunnel so it can be recreated
  sshConn.on("close", () => {
    console.log(`[tunnel] SSH closed for ${host.host}:${remotePort} — tunnel removed, will be rebuilt on reconnect`);
    server.close();
    activeTunnels.delete(key);
  });

  sshConn.on("error", (err) => {
    console.warn(`[tunnel] SSH error for ${host.host}:${remotePort}: ${err.message}`);
  });

  activeTunnels.set(key, { localPort: boundPort, remotePort, sshConn, server });
  console.log(`[tunnel] active: ${host.host}:${remotePort} -> 127.0.0.1:${boundPort}`);
  return boundPort;
}

export function closeTunnelsForHost(hostId: number) {
  for (const [key, tunnel] of activeTunnels) {
    if (key.startsWith(`${hostId}:`)) {
      tunnel.server.close();
      tunnel.sshConn.destroy();
      activeTunnels.delete(key);
    }
  }
}

export function closeAllTunnels() {
  for (const [key, tunnel] of activeTunnels) {
    tunnel.server.close();
    tunnel.sshConn.destroy();
    activeTunnels.delete(key);
  }
}
