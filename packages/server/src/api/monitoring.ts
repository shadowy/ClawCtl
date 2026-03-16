import { Hono } from "hono";
import type { HostStore } from "../hosts/store.js";
import type { InstanceManager } from "../instances/manager.js";
import { sshExec } from "../hosts/discovery.js";

interface TopProcess {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

interface HostMetrics {
  hostId: number;
  label: string;
  host: string;
  cpu: { loadAvg1m: number; loadAvg5m: number; cores: number; usageEstimate: number };
  memory: { used: number; total: number; percent: number };
  uptime: number;
  instances: { id: string; label: string; status: string; sessionCount: number }[];
  topProcesses?: TopProcess[];
  error?: string;
}

const CACHE_TTL = 30_000; // 30s — matches frontend polling interval
let cachedResults: HostMetrics[] | null = null;
let cacheTime = 0;
let fetchInFlight: Promise<HostMetrics[]> | null = null;

export function monitoringRoutes(hostStore: HostStore, manager: InstanceManager) {
  const app = new Hono();

  app.get("/hosts", async (c) => {
    const now = Date.now();

    // Return cached data if fresh enough
    if (cachedResults && now - cacheTime < CACHE_TTL) {
      return c.json(cachedResults);
    }

    // Deduplicate concurrent requests — only one SSH fetch in flight
    if (!fetchInFlight) {
      fetchInFlight = fetchAllMetrics(hostStore, manager).finally(() => {
        fetchInFlight = null;
      });
    }
    const results = await fetchInFlight;
    cachedResults = results;
    cacheTime = Date.now();
    return c.json(results);
  });

  return app;
}

async function fetchLocalMetrics(manager: InstanceManager): Promise<HostMetrics | null> {
  const allInstances = manager.getAll();
  const localInstances = allInstances
    .filter((inst) => inst.id.startsWith("local-"))
    .map((inst) => ({
      id: inst.id,
      label: inst.connection.label || inst.id,
      status: inst.connection.status,
      sessionCount: inst.sessions.length,
    }));
  if (localInstances.length === 0) return null;

  try {
    const { execSync } = await import("child_process");
    const os = await import("os");
    const cores = os.cpus().length;
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const uptime = os.uptime();

    // Top processes (Linux only)
    let topProcesses: TopProcess[] | undefined;
    try {
      const psOut = execSync("ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu --no-headers 2>/dev/null | head -8", { timeout: 3000 }).toString();
      topProcesses = psOut.split("\n").filter((l) => l.trim()).map((line) => {
        const cols = line.trim().split(/\s+/);
        return { pid: parseInt(cols[0]) || 0, user: cols[1] || "", cpu: parseFloat(cols[2]) || 0, mem: parseFloat(cols[3]) || 0, command: cols.slice(4).join(" ") };
      }).filter((p) => p.cpu >= 1 || p.mem >= 5);
      if (topProcesses.length === 0) topProcesses = undefined;
    } catch { /* non-Linux or ps not available */ }

    return {
      hostId: 0,
      label: os.hostname(),
      host: "localhost",
      cpu: { loadAvg1m: loadAvg[0], loadAvg5m: loadAvg[1], cores, usageEstimate: Math.min(Math.round((loadAvg[0] / cores) * 1000) / 10, 100) },
      memory: { used: usedMem, total: totalMem, percent: Math.round((usedMem / totalMem) * 1000) / 10 },
      uptime,
      instances: localInstances,
      topProcesses,
    };
  } catch {
    return null;
  }
}

async function fetchAllMetrics(hostStore: HostStore, manager: InstanceManager): Promise<HostMetrics[]> {
    const hosts = hostStore.list();
    const allInstances = manager.getAll();

    const results = await Promise.all(
      hosts.map(async (host): Promise<HostMetrics> => {
        // Find instances belonging to this host
        const hostInstances = allInstances
          .filter((inst) => inst.id.startsWith(`ssh-${host.id}-`))
          .map((inst) => ({
            id: inst.id,
            label: inst.connection.label || inst.id,
            status: inst.connection.status,
            sessionCount: inst.sessions.length,
          }));

        const cred = hostStore.getDecryptedCredential(host.id);
        if (!cred) {
          return {
            hostId: host.id,
            label: host.label,
            host: host.host,
            cpu: { loadAvg1m: 0, loadAvg5m: 0, cores: 0, usageEstimate: 0 },
            memory: { used: 0, total: 0, percent: 0 },
            uptime: 0,
            instances: hostInstances,
            error: "No credential",
          };
        }

        const credential = host.authMethod === "password"
          ? { password: cred }
          : { privateKey: cred };

        try {
          const stdout = await sshExec(host, credential,
            `nproc 2>/dev/null; echo "===SEP==="; cat /proc/loadavg 2>/dev/null; echo "===SEP==="; free -b 2>/dev/null; echo "===SEP==="; cat /proc/uptime 2>/dev/null; echo "===SEP==="; ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu --no-headers 2>/dev/null | head -8`
          );

          const parts = stdout.split("===SEP===").map((s) => s.trim());
          const cores = parseInt(parts[0]) || 1;

          // /proc/loadavg: "0.45 0.30 0.25 1/234 5678"
          const loadParts = (parts[1] || "").split(/\s+/);
          const loadAvg1m = parseFloat(loadParts[0]) || 0;
          const loadAvg5m = parseFloat(loadParts[1]) || 0;
          const usageEstimate = Math.min(Math.round((loadAvg1m / cores) * 1000) / 10, 100);

          // free -b output: parse "Mem:" line
          const freeLine = (parts[2] || "").split("\n").find((l) => l.startsWith("Mem:"));
          const memParts = freeLine ? freeLine.split(/\s+/) : [];
          const totalMem = parseInt(memParts[1]) || 0;
          const usedMem = parseInt(memParts[2]) || 0;
          const memPercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : 0;

          // /proc/uptime: "12345.67 98765.43"
          const uptime = parseFloat((parts[3] || "").split(/\s+/)[0]) || 0;

          // ps output: PID USER %CPU %MEM COMMAND
          const topProcesses: TopProcess[] = (parts[4] || "").split("\n")
            .filter((l) => l.trim())
            .map((line) => {
              const cols = line.trim().split(/\s+/);
              return {
                pid: parseInt(cols[0]) || 0,
                user: cols[1] || "",
                cpu: parseFloat(cols[2]) || 0,
                mem: parseFloat(cols[3]) || 0,
                command: cols.slice(4).join(" "),
              };
            })
            .filter((p) => p.cpu >= 1 || p.mem >= 5);

          return {
            hostId: host.id,
            label: host.label,
            host: host.host,
            cpu: { loadAvg1m, loadAvg5m, cores, usageEstimate },
            memory: { used: usedMem, total: totalMem, percent: memPercent },
            uptime,
            instances: hostInstances,
            topProcesses: topProcesses.length > 0 ? topProcesses : undefined,
          };
        } catch (err: any) {
          return {
            hostId: host.id,
            label: host.label,
            host: host.host,
            cpu: { loadAvg1m: 0, loadAvg5m: 0, cores: 0, usageEstimate: 0 },
            memory: { used: 0, total: 0, percent: 0 },
            uptime: 0,
            instances: hostInstances,
            error: err.message,
          };
        }
      }),
    );

    // Prepend local host metrics if there are local instances
    const local = await fetchLocalMetrics(manager);
    if (local) results.unshift(local);

    return results;
}
