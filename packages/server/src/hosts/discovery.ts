import { Client } from "ssh2";
import type { GatewayConnection } from "../gateway/types.js";
import type { RemoteHost } from "./types.js";

interface SshCredential {
  password?: string;
  privateKey?: string;
}

export async function discoverRemoteInstances(
  host: RemoteHost,
  credential: SshCredential,
): Promise<GatewayConnection[]> {
  // Single SSH command: get binary version + find all configs with a delimiter
  const DELIM = "===CLAWCTL_SEP===";
  const VER_DELIM = "===CLAWCTL_VER===";
  console.log("[discovery] running SSH command");
  const stdout = await sshExec(host, credential, `
    echo "${VER_DELIM}"
    openclaw --version 2>/dev/null || npx openclaw --version 2>/dev/null || echo ""
    for d in ~/.openclaw*; do
      if [ -f "$d/openclaw.json" ]; then
        echo "${DELIM}$d"
        cat "$d/openclaw.json"
      fi
    done; true
  `);
  console.log(`[discovery] SSH returned ${stdout.length} bytes`);

  // Extract binary version — handles "2026.3.8" and "OpenClaw 2026.3.8 (abc1234)" formats
  let binaryVersion: string | undefined;
  const verParts = stdout.split(VER_DELIM);
  if (verParts.length > 1) {
    const verLine = verParts[1].split(DELIM)[0].trim().split("\n")[0].trim();
    // Try to extract version number from the line
    const verMatch = verLine.match(/(\d+\.\d+\.\d+)/);
    if (verMatch) {
      binaryVersion = verMatch[1];
      console.log(`[discovery] binary version: ${binaryVersion}`);
    }
  }

  if (!stdout.includes(DELIM)) { console.log("[discovery] no delimiter found, returning empty"); return []; }

  const results: GatewayConnection[] = [];
  const seenPorts = new Set<number>();
  const blocks = stdout.split(DELIM).filter(Boolean);
  console.log(`[discovery] found ${blocks.length} blocks`);

  for (const block of blocks) {
    const newlineIdx = block.indexOf("\n");
    if (newlineIdx === -1) continue;
    const dirPath = block.substring(0, newlineIdx).trim();
    const jsonContent = block.substring(newlineIdx + 1).trim();

    try {
      const config = JSON.parse(jsonContent);
      const port = config?.gateway?.port || 18789;
      const dirName = dirPath.split("/").pop() || "";
      const profileName = dirName === ".openclaw" ? "default" : dirName.replace(".openclaw-", "");
      console.log(`[discovery] parsed ${profileName} -> port=${port}`);

      // Deduplicate by port — same port means same Gateway process
      if (seenPorts.has(port)) {
        console.log(`[discovery] skipping ${profileName} (port ${port} already seen)`);
        continue;
      }
      seenPorts.add(port);

      results.push({
        id: `ssh-${host.id}-${profileName}`,
        url: `ws://${host.host}:${port}`,
        token: config?.gateway?.auth?.token,
        label: `${host.label}/${profileName}`,
        status: "disconnected",
        binaryVersion,
        remotePort: port,
      });
    } catch (e: any) { console.log(`[discovery] parse error for block: ${e.message}`); }
  }

  console.log(`[discovery] returning ${results.length} instances`);
  return results;
}

export function sshExec(host: RemoteHost, credential: SshCredential, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    console.log(`[ssh] connecting to ${host.username}@${host.host}:${host.port}`);
    const timeout = setTimeout(() => {
      console.log(`[ssh] TIMEOUT after 35s for ${host.host}`);
      conn.end();
      reject(new Error(`SSH timeout connecting to ${host.host}`));
    }, 35_000);

    conn.on("ready", () => {
      console.log(`[ssh] connected to ${host.host}, executing command`);
      conn.exec(command, (err, stream) => {
        if (err) { clearTimeout(timeout); conn.end(); reject(err); return; }
        let out = "";
        let errOut = "";
        stream.on("data", (d: Buffer) => { out += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { errOut += d.toString(); });
        stream.on("close", (code: number) => {
          clearTimeout(timeout);
          conn.end();
          console.log(`[ssh] command done on ${host.host}, exit=${code}, stdout=${out.length}b`);
          if (code !== 0) reject(new Error(`SSH command failed (${code}): ${errOut.trim()}`));
          else resolve(out);
        });
      });
    });

    conn.on("error", (err) => {
      console.error(`[ssh] error for ${host.host}:`, err.message);
      clearTimeout(timeout);
      reject(err);
    });

    conn.connect({
      host: host.host,
      port: host.port,
      username: host.username,
      password: credential.password,
      privateKey: credential.privateKey,
      readyTimeout: 30_000,
    });
  });
}
