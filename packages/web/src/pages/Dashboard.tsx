import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { RefreshCw, Plus, X, Download, Play } from "lucide-react";
import { ReactFlow, type Node, type Edge, Background, Controls } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useInstances, type InstanceInfo } from "../hooks/useInstances";
import { useAuth } from "../hooks/useAuth";
import { get, post } from "../lib/api";


interface RemoteHost {
  id: number;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "privateKey";
  last_scan_at: string | null;
  last_scan_error: string | null;
}

function StatusDot({ status }: { status: string }) {
  const color = status === "connected" ? "bg-ok" : status === "error" ? "bg-danger" : "bg-warn";
  return (
    <span className="relative inline-flex h-2 w-2">
      {status === "connected" && (
        <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-ok/40" />
      )}
      <span className={`relative inline-block w-2 h-2 rounded-full ${color}`} />
    </span>
  );
}

function InstanceCard({ inst, onRefresh }: { inst: InstanceInfo; onRefresh: () => void | Promise<void> }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const totalTokens = inst.sessions.reduce((t, s) => t + (s.totalTokens || 0), 0);
  const criticalCount = inst.securityAudit?.filter((a) => a.level === "critical").length || 0;
  const isDown = inst.connection.status === "error" || inst.connection.status === "disconnected";

  const [startError, setStartError] = useState<string | null>(null);

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (refreshing) return;
    setRefreshing(true);
    try { await onRefresh(); } catch { /* ignore */ }
    finally { setRefreshing(false); }
  };

  const handleStart = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setStarting(true);
    setStartError(null);
    try {
      await post(`/lifecycle/${inst.id}/start`);
      // Poll status until gateway is running or timeout
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const st = await get<{ running: boolean }>(`/lifecycle/${inst.id}/status`);
          if (st.running) {
            onRefresh();
            setStarting(false);
            return;
          }
        } catch { /* keep polling */ }
      }
      // Timeout — refresh anyway
      onRefresh();
      setStartError(t("dashboard.gatewayStartingHint"));
    } catch (err: any) {
      setStartError(err.message || t("dashboard.startFailed"));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      className="bg-s1 border border-edge rounded-card p-4 hover:border-edge-hi transition-colors cursor-pointer shadow-card"
      onClick={() => navigate(`/instance/${inst.id}`)}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <StatusDot status={inst.connection.status} />
          <h3 className="font-semibold text-ink">{inst.connection.label || inst.id}</h3>
          {inst.version && <span className="font-mono text-xs text-ink-3">v{inst.version}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      {isDown && (
        <div className="mb-2">
          <button
            onClick={handleStart}
            disabled={starting}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-ok/10 hover:bg-ok/20 text-ok rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          >
            <Play size={14} /> {starting ? t("dashboard.starting") : t("dashboard.startGateway")}
          </button>
          {startError && <p className="text-xs text-danger mt-1">{startError}</p>}
        </div>
      )}
      <div className="space-y-1.5 text-sm text-ink-2">
        <div className="flex gap-2 flex-wrap">
          {inst.channels.map((ch) => (
            <span
              key={ch.type + ch.accountId}
              className={`px-2 py-0.5 rounded text-xs ${ch.running ? "bg-cyan-dim text-cyan" : "bg-s2 text-ink-3"}`}
            >
              {ch.type}
            </span>
          ))}
        </div>
        <p>
          {inst.agents.length} {t("dashboard.agent", { count: inst.agents.length })}
          {" · "}{inst.sessions.length} {t("dashboard.session", { count: inst.sessions.length })}
          {totalTokens > 0 && <>{" · "}<span className="text-cyan">{totalTokens.toLocaleString()} {t("common.tokens")}</span></>}
        </p>
        {criticalCount > 0 && (
          <p className="text-danger">{criticalCount} {t("dashboard.criticalIssue", { count: criticalCount })}</p>
        )}
      </div>
    </div>
  );
}

function TopologyView({ instances }: { instances: InstanceInfo[] }) {
  const { t } = useTranslation();
  const nodes: Node[] = [
    {
      id: "hub",
      position: { x: 300, y: 250 },
      data: { label: t("dashboard.clawctlHub") },
      style: {
        background: "#818cf8",
        color: "#fff",
        border: "2px solid #6366f1",
        borderRadius: "50%",
        width: 90,
        height: 90,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "13px",
        fontWeight: 700,
      },
    },
  ];

  const edges: Edge[] = [];
  const radius = 200;
  const cx = 300, cy = 250;

  instances.forEach((inst, i) => {
    const angle = (2 * Math.PI * i) / instances.length - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    const statusColor = inst.connection.status === "connected" ? "#22d3ee"
      : inst.connection.status === "error" ? "#f87171" : "#fbbf24";

    nodes.push({
      id: inst.id,
      position: { x: x - 60, y: y - 30 },
      data: {
        label: (
          <div style={{ textAlign: "center" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 4, marginBottom: 2 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor, display: "inline-block" }} />
              <span style={{ fontWeight: 600, fontSize: 11 }}>{inst.connection.label || inst.id}</span>
            </div>
            <div style={{ fontSize: 10, color: "#94a3b8" }}>
              {inst.agents.length}A · {inst.sessions.length}S
              {inst.version ? ` · v${inst.version}` : ""}
            </div>
          </div>
        ),
      },
      style: {
        background: "#111827",
        border: `1px solid ${statusColor}`,
        borderRadius: "8px",
        padding: "8px 12px",
        fontSize: "12px",
        color: "#e2e8f0",
        minWidth: 120,
      },
    });

    edges.push({
      id: `hub-${inst.id}`,
      source: "hub",
      target: inst.id,
      animated: inst.connection.status === "connected",
      style: { stroke: statusColor, strokeWidth: 1.5 },
    });
  });

  return (
    <div className="bg-s1 border border-edge rounded-card shadow-card overflow-hidden" style={{ height: 500 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ background: "#0a0f1a" }}
      >
        <Background color="#1e293b" gap={20} />
        <Controls
          style={{ background: "#1e293b", borderColor: "#334155", color: "#94a3b8" }}
        />
      </ReactFlow>
    </div>
  );
}

function AddInstanceDialog({ onClose, onAdd, isAdmin }: { onClose: () => void; onAdd: (url: string, token?: string, label?: string) => void; isAdmin: boolean }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"instance" | "host">("instance");
  // Instance tab
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  // Host tab
  const [hostLabel, setHostLabel] = useState("");
  const [hostAddr, setHostAddr] = useState("");
  const [hostPort, setHostPort] = useState("22");
  const [hostUser, setHostUser] = useState("ubuntu");
  const [hostAuth, setHostAuth] = useState<"password" | "privateKey">("password");
  const [hostCred, setHostCred] = useState("");
  const [hostBusy, setHostBusy] = useState(false);
  const [hostMsg, setHostMsg] = useState<string | null>(null);

  const inputCls = "w-full bg-s4 border border-edge-modal rounded-lg px-3 py-2.5 text-sm text-ink placeholder:text-ink-3 focus:border-brand transition-colors";

  const [hostDone, setHostDone] = useState(false);

  const addHost = async () => {
    setHostBusy(true); setHostMsg(null);
    try {
      const created = await post<{ id: number }>("/hosts", {
        label: hostLabel || hostAddr, host: hostAddr,
        port: parseInt(hostPort) || 22, username: hostUser,
        authMethod: hostAuth, credential: hostCred,
      });
      // Auto-scan after adding
      const scan = await post<{ discovered: number; added: number }>(`/hosts/${created.id}/scan`, {});
      if (scan.discovered > 0) {
        setHostMsg(t("dashboard.addDialog.hostAddedSuccess", { n: scan.discovered }));
      } else {
        setHostMsg(t("dashboard.addDialog.hostAddedNoInstances"));
      }
      setHostDone(true);
    } catch (e: any) {
      if (e.message === "duplicate") {
        setHostMsg(t("dashboard.addDialog.hostDuplicate"));
      } else {
        setHostMsg(`Error: ${e.message}`);
      }
    }
    finally { setHostBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-deep/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-s3 border border-edge-modal rounded-card p-6 w-[28rem] shadow-[0_8px_32px_rgba(0,0,0,0.5)] relative" onClick={(e) => e.stopPropagation()}>
        {/* Close X */}
        <button onClick={onClose} className="absolute top-4 right-4 text-ink-3 hover:text-ink transition-colors" aria-label="Close">
          <X size={18} />
        </button>
        {/* Tabs */}
        <div className="flex gap-1 mb-4 bg-s4 rounded-lg p-0.5 mr-6">
          <button
            onClick={() => setTab("instance")}
            className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${tab === "instance" ? "bg-s3 text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}
          >
            {t("dashboard.addDialog.remoteInstance")}
          </button>
          {isAdmin && (
            <button
              onClick={() => setTab("host")}
              className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${tab === "host" ? "bg-s3 text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}
            >
              {t("dashboard.addDialog.sshHost")}
            </button>
          )}
        </div>

        {tab === "instance" ? (
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-ink-2 mb-1">{t("dashboard.addDialog.wsUrlLabel")}</label>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("dashboard.addDialog.wsUrlPlaceholder")} className={inputCls} />
            </div>
            <div>
              <label className="block text-sm text-ink-2 mb-1">{t("dashboard.addDialog.tokenLabel")}</label>
              <input value={token} onChange={(e) => setToken(e.target.value)} type="password" className={inputCls} />
            </div>
            <div>
              <label className="block text-sm text-ink-2 mb-1">{t("dashboard.addDialog.labelLabel")}</label>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("dashboard.addDialog.labelPlaceholder")} className={inputCls} />
            </div>
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={onClose} className="px-4 py-2 text-sm text-ink-2 hover:text-ink transition-colors">{t("common.cancel")}</button>
              <button
                onClick={() => { onAdd(url, token || undefined, label || undefined); onClose(); }}
                className="px-4 py-2 text-sm bg-brand hover:bg-brand-light rounded-card text-white font-semibold shadow-glow-brand transition-colors"
                disabled={!url}
              >
                {t("common.add")}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-ink-3">{t("dashboard.addDialog.sshHostHint")}</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-ink-2 mb-1">{t("dashboard.addDialog.labelHostLabel")}</label>
                <input value={hostLabel} onChange={(e) => setHostLabel(e.target.value)} placeholder="Production Server" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-ink-2 mb-1">{t("dashboard.addDialog.hostLabel")}</label>
                <input value={hostAddr} onChange={(e) => setHostAddr(e.target.value)} placeholder="192.168.1.100" className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-ink-2 mb-1">{t("dashboard.addDialog.portLabel")}</label>
                <input value={hostPort} onChange={(e) => setHostPort(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs text-ink-2 mb-1">{t("dashboard.addDialog.usernameLabel")}</label>
                <input value={hostUser} onChange={(e) => setHostUser(e.target.value)} placeholder="ubuntu" className={inputCls} />
              </div>
            </div>
            <div>
              <label className="block text-xs text-ink-2 mb-1">{t("dashboard.addDialog.authMethodLabel")}</label>
              <select value={hostAuth} onChange={(e) => setHostAuth(e.target.value as "password" | "privateKey")} className={inputCls}>
                <option value="password">{t("dashboard.addDialog.passwordOption")}</option>
                <option value="privateKey">{t("dashboard.addDialog.privateKeyOption")}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-ink-2 mb-1">{hostAuth === "password" ? t("dashboard.addDialog.passwordLabel") : t("dashboard.addDialog.privateKeyLabel")}</label>
              {hostAuth === "password"
                ? <input type="password" value={hostCred} onChange={(e) => setHostCred(e.target.value)} className={inputCls} />
                : <textarea value={hostCred} onChange={(e) => setHostCred(e.target.value)} rows={3} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" className={`${inputCls} font-mono`} />
              }
            </div>
            {hostMsg && (
              <div className={`p-3 rounded-lg border text-sm ${
                hostMsg.startsWith("Error")
                  ? "bg-danger/10 border-danger/30 text-danger"
                  : hostMsg.includes("No OpenClaw")
                    ? "bg-warn/10 border-warn/30 text-warn"
                    : "bg-ok/10 border-ok/30 text-ok"
              }`}>
                {hostMsg}
              </div>
            )}
            <div className="flex gap-2 justify-end pt-2">
              {hostDone ? (
                <button onClick={onClose} className="px-4 py-2 text-sm bg-brand hover:bg-brand-light rounded-card text-white font-semibold shadow-glow-brand transition-colors">
                  {t("common.close")}
                </button>
              ) : (
                <>
                  <button onClick={onClose} className="px-4 py-2 text-sm text-ink-2 hover:text-ink transition-colors">{t("common.cancel")}</button>
                  <button
                    onClick={addHost}
                    className="px-4 py-2 text-sm bg-brand hover:bg-brand-light rounded-card text-white font-semibold shadow-glow-brand transition-colors"
                    disabled={!hostAddr || !hostUser || !hostCred || hostBusy}
                  >
                    {hostBusy ? t("dashboard.addDialog.adding") : t("dashboard.addDialog.addAndScan")}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function groupByHost(instances: InstanceInfo[]): { hostKey: string; hostLabel: string; instances: InstanceInfo[] }[] {
  const groups = new Map<string, InstanceInfo[]>();
  for (const inst of instances) {
    // Instance IDs: "ssh-{hostId}-{profile}" or other formats
    const match = inst.id.match(/^ssh-(\d+)-/);
    const hostKey = match ? `ssh-${match[1]}` : "local";
    if (!groups.has(hostKey)) groups.set(hostKey, []);
    groups.get(hostKey)!.push(inst);
  }
  return [...groups.entries()].map(([hostKey, insts]) => {
    // Connection labels are "hostLabel/profile" — extract host part
    const connLabel = insts[0]?.connection.label || "";
    const slashIdx = connLabel.indexOf("/");
    const hostLabel = hostKey === "local" ? "_local_" : (slashIdx > 0 ? connLabel.slice(0, slashIdx) : hostKey);
    return { hostKey, hostLabel, instances: insts };
  });
}

interface InstallStep {
  step: string;
  status: "running" | "done" | "error" | "skipped";
  detail?: string;
}

/** @returns "completed" if server sent done event, "disconnected" if stream broke mid-install */
async function streamInstallSSE(
  hostId: number | string,
  version: string | undefined,
  onStep: (step: InstallStep) => void,
  onDone: (success: boolean) => void,
): Promise<"completed" | "disconnected"> {
  const body = JSON.stringify({ version });
  let receivedSteps = false;
  try {
    const res = await fetch(`/api/lifecycle/host/${hostId}/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body,
    });
    const reader = res.body?.getReader();
    if (!reader) { onDone(false); return "completed"; }
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const msg = JSON.parse(line.slice(6));
          if (msg.done !== undefined) { onDone(msg.success); return "completed"; }
          receivedSteps = true;
          onStep(msg as InstallStep);
        } catch { /* ignore */ }
      }
    }
  } catch { /* fetch/network error */ }
  // Stream ended without a done event
  if (receivedSteps) return "disconnected";
  onDone(false);
  return "completed";
}

const STEP_ICON: Record<string, string> = {
  running: "\u23F3",
  done: "\u2705",
  error: "\u274C",
  skipped: "\u23ED\uFE0F",
};

function EmptyHostCard({ host, onInstalled }: { host: RemoteHost; onInstalled: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<InstallStep[]>([]);
  const [result, setResult] = useState<"success" | "error" | null>(null);
  const [versionOptions, setVersionOptions] = useState<Array<{ label: string; value: string }>>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  // "checking" -> loading, "not_installed" -> show install, "installed" -> show init gateway
  const [hostStatus, setHostStatus] = useState<"checking" | "not_installed" | "installed">("checking");
  const [installedVersion, setInstalledVersion] = useState<string>("");
  // Init gateway form
  const [gwPort, setGwPort] = useState("18789");
  const [gwToken, setGwToken] = useState("");
  const [gwProfile, setGwProfile] = useState("");
  const [initMsg, setInitMsg] = useState<string | null>(null);

  useEffect(() => {
    // Check if openclaw is already installed on this host
    get<{ status: string; version?: string }>(`/lifecycle/host/${host.id}/install-status`)
      .then((st) => {
        if (st.status === "installed" && st.version) {
          setHostStatus("installed");
          setInstalledVersion(st.version);
        } else {
          setHostStatus("not_installed");
        }
      })
      .catch(() => setHostStatus("not_installed"));

    get<{ distTags: Record<string, string>; versions: string[] }>("/lifecycle/available-versions")
      .then(({ distTags, versions }) => {
        const opts: Array<{ label: string; value: string }> = [];
        if (distTags) {
          const sorted = Object.entries(distTags).sort(([a], [b]) => a === "latest" ? -1 : b === "latest" ? 1 : a.localeCompare(b));
          for (const [tag, ver] of sorted) {
            opts.push({ label: tag === "latest" ? `${ver} (stable)` : `${ver} (${tag})`, value: ver });
          }
        }
        const tagVersions = new Set(Object.values(distTags || {}));
        for (const ver of (versions || [])) {
          if (!tagVersions.has(ver)) {
            opts.push({ label: ver, value: ver });
          }
        }
        setVersionOptions(opts);
        if (distTags?.latest) setSelectedVersion(distTags.latest);
        else if (opts.length) setSelectedVersion(opts[0].value);
      })
      .catch(() => {});
  }, []);

  const pollInstallStatus = async () => {
    const connLostMsg = t("dashboard.emptyHost.connectionLostChecking");
    setSteps((prev) => [...prev, { step: connLostMsg, status: "running" }]);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const st = await get<{ status: string; version?: string }>(`/lifecycle/host/${host.id}/install-status`);
        if (st.status === "installed") {
          setSteps((prev) => {
            const next = prev.filter((s) => s.step !== connLostMsg);
            return [...next, { step: t("dashboard.emptyHost.installCompletedOnRemote"), status: "done", detail: st.version ? `v${st.version}` : undefined }];
          });
          setHostStatus("installed");
          setInstalledVersion(st.version || "");
          setResult(null); setBusy(false);
          return;
        }
        if (st.status === "not_installed") {
          setSteps((prev) => prev.map((s) =>
            s.step === connLostMsg ? { ...s, status: "error" as const, detail: t("dashboard.emptyHost.installEndedWithoutSuccess") } : s
          ));
          setResult("error"); setBusy(false);
          return;
        }
      } catch { /* keep trying */ }
    }
    setSteps((prev) => prev.map((s) =>
      s.step === connLostMsg ? { ...s, status: "error" as const, detail: t("dashboard.emptyHost.timedOutCheckManually") } : s
    ));
    setResult("error"); setBusy(false);
  };

  const install = async () => {
    setBusy(true); setSteps([]); setResult(null);
    const outcome = await streamInstallSSE(
      host.id,
      selectedVersion || undefined,
      (step) => setSteps((prev) => {
        const idx = prev.findIndex((s) => s.step === step.step);
        if (idx >= 0) { const next = [...prev]; next[idx] = step; return next; }
        return [...prev, step];
      }),
      async (success) => {
        if (success) {
          const scanMsg = t("dashboard.emptyHost.scanningInstances");
          setSteps((prev) => [...prev, { step: scanMsg, status: "running" }]);
          // After install, check if gateway is already running (might auto-start)
          try {
            const scan = await post<{ discovered: number }>(`/hosts/${host.id}/scan`, {});
            setSteps((prev) => {
              const next = [...prev];
              const idx = next.findIndex((s) => s.step === scanMsg);
              if (idx >= 0) next[idx] = { step: scanMsg, status: "done" };
              return next;
            });
            if (scan.discovered > 0) {
              setResult("success"); setBusy(false);
              onInstalled();
              return;
            }
          } catch { /* ignore */ }
          // Installed but no running gateway -> switch to init form
          setHostStatus("installed");
          setInstalledVersion(selectedVersion);
          setResult(null); setBusy(false);
          setSteps([]);
        } else {
          setResult("error"); setBusy(false);
        }
      },
    );
    if (outcome === "disconnected") {
      await pollInstallStatus();
    }
  };

  const initGateway = async () => {
    setBusy(true); setInitMsg(null);
    try {
      await post(`/lifecycle/host/${host.id}/init-gateway`, {
        port: parseInt(gwPort) || 18789,
        token: gwToken || undefined,
        profile: gwProfile || undefined,
      });
      setInitMsg(t("dashboard.emptyHost.gatewayStartedScanning"));
      await post(`/hosts/${host.id}/scan`, {});
      onInstalled();
    } catch (e: any) {
      setInitMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const [rescanning, setRescanning] = useState(false);

  const rescan = async () => {
    setRescanning(true);
    try {
      const scan = await post<{ discovered: number }>(`/hosts/${host.id}/scan`, {});
      if (scan.discovered > 0) {
        onInstalled();
        return;
      }
      // No instances found — re-check install status
      const st = await get<{ status: string; version?: string }>(`/lifecycle/host/${host.id}/install-status`);
      if (st.status === "installed" && st.version) {
        setHostStatus("installed");
        setInstalledVersion(st.version);
      } else {
        setHostStatus("not_installed");
      }
    } catch { /* ignore */ }
    finally { setRescanning(false); }
  };

  const inputCls = "w-full bg-s2 border border-edge rounded px-2 py-1.5 text-xs text-ink placeholder:text-ink-3";

  return (
    <div className="bg-s1 border border-edge rounded-card p-4 shadow-card border-dashed">
      <div className="flex items-center gap-2 mb-2">
        <span className="relative inline-flex h-2 w-2">
          <span className={`relative inline-block w-2 h-2 rounded-full ${hostStatus === "installed" ? "bg-cyan" : "bg-warn"}`} />
        </span>
        <span className="font-medium text-ink truncate">{host.label}</span>
        {installedVersion && <span className="font-mono text-xs text-ink-3">v{installedVersion}</span>}
        <button
          onClick={rescan}
          disabled={rescanning}
          className="ml-auto text-ink-3 hover:text-ink transition-colors disabled:opacity-50"
          title={t("dashboard.emptyHost.rescanHost")}
        >
          <RefreshCw size={14} className={rescanning ? "animate-spin" : ""} />
        </button>
      </div>
      <p className="text-xs text-ink-3 mb-1">{host.username}@{host.host}:{host.port}</p>

      {/* Step progress */}
      {steps.length > 0 && (
        <div className="mb-3 space-y-1">
          {steps.map((s, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs">
              <span className="shrink-0">{STEP_ICON[s.status]}</span>
              <span className={s.status === "error" ? "text-danger" : s.status === "done" ? "text-ok" : "text-ink-2"}>
                {s.step}{s.detail ? ` \u2014 ${s.detail}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {result === "error" && (
        <p className="text-xs text-danger mb-2">{t("dashboard.emptyHost.installFailed")}</p>
      )}

      {hostStatus === "checking" && (
        <p className="text-xs text-ink-3 mb-3">{t("dashboard.emptyHost.checkingHostStatus")}</p>
      )}

      {/* State: Not installed -> show install UI */}
      {hostStatus === "not_installed" && !busy && result !== "success" && (
        <div className="space-y-2">
          <p className="text-xs text-warn">{t("dashboard.emptyHost.openclawNotInstalled")}</p>
          {versionOptions.length > 0 && (
            <select value={selectedVersion} onChange={(e) => setSelectedVersion(e.target.value)} className={inputCls}>
              {versionOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}
          <button onClick={install} disabled={busy}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-brand/10 hover:bg-brand/20 text-brand rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
            <Download size={14} /> {t("dashboard.emptyHost.installOpenclaw")}
          </button>
        </div>
      )}

      {/* State: Installed but no gateway -> show init form */}
      {hostStatus === "installed" && !busy && result !== "success" && (
        <div className="space-y-2">
          <p className="text-xs text-cyan">{t("dashboard.emptyHost.openclawInstalledNoGateway")}</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-ink-3 mb-0.5">{t("dashboard.emptyHost.portLabel")}</label>
              <input value={gwPort} onChange={(e) => setGwPort(e.target.value)} placeholder="18789" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs text-ink-3 mb-0.5">{t("dashboard.emptyHost.profileLabel")}</label>
              <input value={gwProfile} onChange={(e) => setGwProfile(e.target.value)} placeholder="default" className={inputCls} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-ink-3 mb-0.5">{t("dashboard.emptyHost.tokenOptionalLabel")}</label>
            <input value={gwToken} onChange={(e) => setGwToken(e.target.value)} type="password" placeholder={t("dashboard.emptyHost.gatewayAuthTokenPlaceholder")} className={inputCls} />
          </div>
          {initMsg && (
            <p className={`text-xs ${initMsg.startsWith("Error") ? "text-danger" : "text-ok"}`}>{initMsg}</p>
          )}
          <button onClick={initGateway} disabled={busy}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-ok/10 hover:bg-ok/20 text-ok rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
            {busy ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
            {busy ? t("dashboard.emptyHost.initializingGateway") : t("dashboard.emptyHost.initializeGateway")}
          </button>
        </div>
      )}
    </div>
  );
}

function InstancesByHost({ instances, emptyHosts, refresh }: { instances: InstanceInfo[]; emptyHosts: RemoteHost[]; refresh: () => void }) {
  const { t } = useTranslation();
  const groups = groupByHost(instances);
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  const filtered = selectedHost ? groups.filter((g) => g.hostKey === selectedHost) : groups;
  const showEmptyHosts = !selectedHost || selectedHost === "empty-hosts";

  const displayHostLabel = (label: string) => label === "_local_" ? t("dashboard.local") : label;

  return (
    <div>
      {(groups.length > 1 || emptyHosts.length > 0) && (
        <div className="flex gap-2 mb-4 flex-wrap">
          <button
            onClick={() => setSelectedHost(null)}
            className={`px-3 py-1 rounded text-xs font-medium ${!selectedHost ? "bg-s3 text-ink" : "bg-s2 text-ink-3 hover:text-ink"}`}
          >
            {t("dashboard.allCount", { n: instances.length + emptyHosts.length })}
          </button>
          {groups.map((g) => (
            <button
              key={g.hostKey}
              onClick={() => setSelectedHost(g.hostKey)}
              className={`px-3 py-1 rounded text-xs font-medium ${selectedHost === g.hostKey ? "bg-s3 text-ink" : "bg-s2 text-ink-3 hover:text-ink"}`}
            >
              {displayHostLabel(g.hostLabel)} ({g.instances.length})
            </button>
          ))}
          {emptyHosts.length > 0 && (
            <button
              onClick={() => setSelectedHost("empty-hosts")}
              className={`px-3 py-1 rounded text-xs font-medium ${selectedHost === "empty-hosts" ? "bg-s3 text-ink" : "bg-warn/20 text-warn hover:bg-warn/30"}`}
            >
              {t("dashboard.notInstalled")} ({emptyHosts.length})
            </button>
          )}
        </div>
      )}
      <div className="space-y-6">
        {filtered.map((g) => (
          <div key={g.hostKey}>
            <h2 className="text-sm text-ink-3 uppercase tracking-wide mb-3">{displayHostLabel(g.hostLabel)} — {g.instances.length} {t("dashboard.instance", { count: g.instances.length })}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {g.instances.map((inst) => (
                <InstanceCard key={inst.id} inst={inst} onRefresh={() => post(`/instances/${inst.id}/refresh`).then(refresh)} />
              ))}
            </div>
          </div>
        ))}
        {showEmptyHosts && emptyHosts.length > 0 && (
          <div>
            <h2 className="text-sm text-warn uppercase tracking-wide mb-3">{t("dashboard.awaitingInstallation")} — {emptyHosts.length} {t("dashboard.host", { count: emptyHosts.length })}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {emptyHosts.map((h) => (
                <EmptyHostCard key={h.id} host={h} onInstalled={refresh} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Dashboard() {
  const { t } = useTranslation();
  const { instances, loading, refresh, addInstance } = useInstances();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [showAdd, setShowAdd] = useState(false);
  const [showTopo, setShowTopo] = useState(false);
  const [hosts, setHosts] = useState<RemoteHost[]>([]);

  useEffect(() => {
    if (isAdmin) {
      get<RemoteHost[]>("/hosts").then(setHosts).catch(() => {});
    }
  }, [isAdmin, instances]);

  // Hosts that have no discovered instances
  const hostIdsWithInstances = new Set<number>();
  for (const inst of instances) {
    const m = inst.id.match(/^ssh-(\d+)-/);
    if (m) hostIdsWithInstances.add(parseInt(m[1]));
  }
  const emptyHosts = hosts.filter((h) => !hostIdsWithInstances.has(h.id));

  const totalSessions = instances.reduce((s, i) => s + i.sessions.length, 0);
  const totalAgents = instances.reduce((s, i) => s + i.agents.length, 0);
  const criticalIssues = instances.reduce((s, i) => s + (i.securityAudit?.filter((a) => a.level === "critical").length || 0), 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-ink">{t("dashboard.title")}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTopo(!showTopo)}
            className={`px-4 py-2 rounded-card text-sm font-semibold transition-colors ${
              showTopo ? "bg-brand text-white" : "bg-s2 text-ink-2 hover:text-ink border border-edge"
            }`}
          >
            {t("dashboard.topology")}
          </button>
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-brand hover:bg-brand-light rounded-card text-sm text-white font-semibold shadow-glow-brand transition-colors"
          >
            <Plus size={16} className="inline" /> {t("dashboard.addInstance")}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: t("dashboard.instances"), value: instances.length },
          { label: t("dashboard.activeSessions"), value: totalSessions },
          { label: t("dashboard.agents"), value: totalAgents },
          { label: t("dashboard.criticalIssues"), value: criticalIssues, color: criticalIssues > 0 ? "text-danger" : undefined },
        ].map((stat) => (
          <div key={stat.label} className="bg-s1 border border-edge rounded-card p-4 shadow-card">
            <p className="text-sm text-ink-2">{stat.label}</p>
            <p className={`text-2xl font-bold text-ink ${stat.color || ""}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {showTopo && <div className="mb-6"><TopologyView instances={instances} /></div>}

      {loading ? (
        <p className="text-ink-3">{t("dashboard.loadingInstances")}</p>
      ) : instances.length === 0 && emptyHosts.length === 0 ? (
        <div className="text-center py-12 text-ink-3">
          <p className="text-lg mb-2">{t("dashboard.noInstancesFound")}</p>
          <p className="text-sm">{t("dashboard.noInstancesHint")}</p>
        </div>
      ) : (
        <InstancesByHost instances={instances} emptyHosts={emptyHosts} refresh={refresh} />
      )}

      {showAdd && <AddInstanceDialog onClose={() => { setShowAdd(false); refresh(); }} onAdd={addInstance} isAdmin={isAdmin ?? false} />}
    </div>
  );
}
