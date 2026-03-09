import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, RefreshCw, ArrowUpDown, Play, Square, RotateCcw, Download, ArrowUpCircle, Save, Terminal, Camera, GitCompare, Trash2, Users, Plus, Radio, LogOut, Search } from "lucide-react";
import { useInstances, type InstanceInfo } from "../hooks/useInstances";
import { get, post, put } from "../lib/api";
import { del } from "../lib/api";
import { AgentForm, type AgentFormValues } from "../components/AgentForm";
import { ChannelForm, type ChannelFormValues } from "../components/ChannelForm";
import { TemplateApplyModal } from "../components/TemplateApplyModal";
import { RestartDialog } from "../components/RestartDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

function StatusDot({ status }: { status: string }) {
  const color = status === "connected" ? "bg-ok" : status === "error" ? "bg-danger" : "bg-warn";
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

type Tab = "overview" | "sessions" | "config" | "security" | "agents" | "channels" | "llm" | "control";

function OverviewTab({ inst, onSwitchTab }: { inst: InstanceInfo; onSwitchTab: (tab: Tab) => void }) {
  const { t } = useTranslation();
  const totalTokens = inst.sessions.reduce((acc, s) => acc + (s.totalTokens || 0), 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: t("instance.overview.agents"), value: inst.agents.length },
          { label: t("instance.overview.sessions"), value: inst.sessions.length },
          { label: t("instance.overview.totalTokens"), value: totalTokens.toLocaleString() },
          { label: t("instance.overview.channels"), value: inst.channels.length },
        ].map((s) => (
          <div key={s.label} className="bg-s1 border border-edge rounded-card p-4 shadow-card">
            <p className="text-sm text-ink-2">{s.label}</p>
            <p className="text-xl font-bold text-ink">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="bg-s1 border border-edge rounded-card overflow-hidden shadow-card">
        <h3 className="text-lg font-semibold p-4 border-b border-edge text-ink">{t("instance.overview.agents")}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge text-ink-2">
              <th className="text-left p-3">{t("instance.overview.agentsTable.idHeader")}</th>
              <th className="text-left p-3">{t("instance.overview.agentsTable.nameHeader")}</th>
              <th className="text-left p-3">{t("instance.overview.agentsTable.modelHeader")}</th>
              <th className="text-left p-3">{t("instance.overview.agentsTable.thinkingHeader")}</th>
              <th className="text-left p-3">{t("instance.overview.agentsTable.defaultHeader")}</th>
            </tr>
          </thead>
          <tbody>
            {inst.agents.map((a) => (
              <tr key={a.id} className="border-b border-edge/50">
                <td className="p-3 font-mono">{a.id}</td>
                <td className="p-3">{a.name || "—"}</td>
                <td className="p-3"><code className="text-cyan">{a.model || "default"}</code></td>
                <td className="p-3">{a.thinking ? <span className="text-warn">{a.thinking}</span> : <span className="text-ink-3">—</span>}</td>
                <td className="p-3">{a.isDefault ? "✓" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Channels summary card */}
      <div className="bg-s1 border border-edge rounded-card overflow-hidden shadow-card">
        <h3 className="text-lg font-semibold p-4 border-b border-edge text-ink">{t("instance.overview.channels")}</h3>
        <button
          onClick={() => onSwitchTab("channels")}
          className="w-full text-left p-4 hover:bg-s2/50 transition-colors"
        >
          <div className="text-sm text-ink">
            {inst.channels.length} channel{inst.channels.length !== 1 ? "s" : ""},{" "}
            <span className="text-ok">{inst.channels.filter((c) => c.running).length} {t("channels.running")}</span>
          </div>
          <div className="text-xs text-ink-3 mt-1">{t("channels.clickToManage")}</div>
        </button>
      </div>
    </div>
  );
}

function SessionsTab({ inst }: { inst: InstanceInfo }) {
  const { t } = useTranslation();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [msgReverse, setMsgReverse] = useState(false);
  const [sortAsc, setSortAsc] = useState(false);
  const [msgLimit, setMsgLimit] = useState(50);
  const [hasMore, setHasMore] = useState(false);

  const sessions = [...inst.sessions].sort((a, b) =>
    sortAsc ? (a.updatedAt || 0) - (b.updatedAt || 0) : (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  const loadSession = async (key: string, limit = 50) => {
    setSelectedKey(key);
    setMsgLimit(limit);
    setLoadingMsgs(true);
    try {
      const msgs = await get<any[]>(`/instances/${inst.id}/sessions/${key}?limit=${limit}`);
      setMessages(msgs);
      setHasMore(msgs.length >= limit);
    } finally {
      setLoadingMsgs(false);
    }
  };

  const loadMore = () => {
    if (!selectedKey) return;
    const next = Math.min(msgLimit * 4, 1000);
    loadSession(selectedKey, next);
  };

  return (
    <div className="flex gap-4 h-[calc(100vh-220px)]">
      <div className="w-1/3 flex flex-col min-w-0">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-ink-3">{sessions.length} {t("common.sessions")}</span>
          <button
            onClick={() => setSortAsc(!sortAsc)}
            className="flex items-center gap-1 text-xs text-ink-3 hover:text-ink px-1.5 py-0.5 rounded bg-s2"
            title={sortAsc ? t("sessions.oldestFirst") : t("sessions.newestFirst")}
          >
            <ArrowUpDown size={12} />
            {sortAsc ? t("common.old") : t("common.new")}
          </button>
        </div>
        <div className="flex-1 overflow-auto space-y-1">
          {sessions.map((s) => (
            <button
              key={s.key}
              onClick={() => loadSession(s.key)}
              className={`w-full text-left px-3 py-2 rounded text-sm ${selectedKey === s.key ? "bg-s2 text-ink border-l-2 border-brand" : "text-ink-2 hover:bg-s1/50"}`}
            >
              <div className="flex justify-between">
                <span className="truncate">{s.displayName || s.key.split(":").pop() || s.key}</span>
                <span className="text-xs text-ink-3 shrink-0 ml-2">{timeAgo(s.updatedAt)}</span>
              </div>
              <div className="text-xs text-ink-3">
                {s.kind}{s.channel ? ` · ${s.channel}` : ""}{s.model ? ` · ${s.model}` : ""}
                {(s.totalTokens || 0) > 0 && ` · ${s.totalTokens!.toLocaleString()} tok`}
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            inst.connection.status !== "connected" ? (
              <div className="flex items-center justify-center py-8 text-ink-3 text-sm">
                <RefreshCw size={14} className="animate-spin mr-2" /> {t("instance.sessionsList.waitingForConnection")}
              </div>
            ) : (
              <p className="text-center py-8 text-ink-3 text-sm">{t("instance.sessionsList.noSessions")}</p>
            )
          )}
        </div>
      </div>
      <div className="flex-1 flex flex-col min-w-0">
        {selectedKey ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-ink-3">{messages.length} {t("instance.sessionsList.message")}{messages.length !== 1 ? "s" : ""}</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setMsgReverse(!msgReverse)}
                  className="flex items-center gap-1 text-xs text-ink-3 hover:text-ink px-1.5 py-0.5 rounded bg-s2"
                >
                  <ArrowUpDown size={12} />
                  {msgReverse ? t("common.new") : t("common.old")}
                </button>
                {hasMore && (
                  <button onClick={loadMore} className="px-2 py-1 text-xs bg-s3 hover:bg-edge-hi rounded">
                    {t("common.loadMore")}
                  </button>
                )}
              </div>
            </div>
            {loadingMsgs ? (
              <div className="flex-1 flex items-center justify-center text-ink-3">{t("sessions.loadingMessages")}</div>
            ) : (
            <div className="flex-1 overflow-auto space-y-3">
              {(msgReverse ? [...messages].reverse() : messages).map((msg, i) => (
                <div key={i} className={`p-3 rounded text-sm ${msg.role === "user" ? "bg-s2" : "bg-s1 border border-edge"}`}>
                  <span className="text-xs text-ink-3 uppercase">{msg.role}</span>
                  <p className="mt-1 whitespace-pre-wrap">{typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2)}</p>
                </div>
              ))}
            </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-ink-3">{t("instance.sessionsList.selectSession")}</div>
        )}
      </div>
    </div>
  );
}

function ConfigTab({ inst }: { inst: InstanceInfo }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div className="bg-s1 border border-edge rounded-card shadow-card">
        <h3 className="text-lg font-semibold p-4 border-b border-edge text-ink">{t("instance.configView.configuration")}</h3>
        <pre className="p-4 text-xs overflow-auto max-h-[600px] bg-s2 rounded-card m-4">{JSON.stringify(inst.config, null, 2)}</pre>
      </div>

      {inst.skills.length > 0 && (
        <div className="bg-s1 border border-edge rounded-card overflow-hidden shadow-card">
          <h3 className="text-lg font-semibold p-4 border-b border-edge text-ink">{t("instance.configView.skills")} ({inst.skills.length})</h3>
          <div className="p-4 flex gap-2 flex-wrap">
            {[...inst.skills].sort((a, b) => (a.status === "ready" ? 0 : 1) - (b.status === "ready" ? 0 : 1) || a.name.localeCompare(b.name)).map((sk) => (
              <span key={sk.name} className={`px-2 py-1 rounded text-xs ${sk.status === "ready" ? "bg-ok-dim text-ok" : "bg-s2 text-ink-3"}`}>
                {sk.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SecurityTab({ inst }: { inst: InstanceInfo }) {
  const { t } = useTranslation();
  const issues = inst.securityAudit || [];
  const config = (inst.config as any)?.parsed || inst.config as any;

  const channelPolicies: { channel: string; account: string; key: string; value: string }[] = [];
  const channels = config?.channels || {};
  for (const [chType, chConf] of Object.entries(channels) as [string, any][]) {
    if (chConf.dmPolicy) channelPolicies.push({ channel: chType, account: "default", key: "dmPolicy", value: chConf.dmPolicy });
    if (chConf.groupPolicy) channelPolicies.push({ channel: chType, account: "default", key: "groupPolicy", value: chConf.groupPolicy });
    if (chConf.enabled !== undefined) channelPolicies.push({ channel: chType, account: "default", key: "enabled", value: String(chConf.enabled) });
    const accounts = chConf.accounts || {};
    for (const [accId, accConf] of Object.entries(accounts) as [string, any][]) {
      if (accConf.dmPolicy) channelPolicies.push({ channel: chType, account: accId, key: "dmPolicy", value: accConf.dmPolicy });
      if (accConf.groupPolicy) channelPolicies.push({ channel: chType, account: accId, key: "groupPolicy", value: accConf.groupPolicy });
      if (accConf.enabled !== undefined) channelPolicies.push({ channel: chType, account: accId, key: "enabled", value: String(accConf.enabled) });
      if (accConf.groupAllowFrom) channelPolicies.push({ channel: chType, account: accId, key: "groupAllowFrom", value: accConf.groupAllowFrom.join(", ") });
      if (accConf.allowFrom) channelPolicies.push({ channel: chType, account: accId, key: "allowFrom", value: accConf.allowFrom.join(", ") });
      if (accConf.requireMemberOpenIds?.length) channelPolicies.push({ channel: chType, account: accId, key: "requireMemberOpenIds", value: `${accConf.requireMemberOpenIds.length} IDs` });
    }
  }

  const bindings = config?.bindings || [];

  return (
    <div className="space-y-6">
      {issues.length > 0 ? (
        <div className="bg-s1 border border-edge rounded-card shadow-card">
          <h3 className="text-lg font-semibold p-4 border-b border-edge text-ink">{t("instance.securityView.auditItems")}</h3>
          <div className="divide-y divide-edge">
            {issues.map((item, i) => (
              <div key={i} className="p-4 flex items-start gap-2">
                <span className={`px-2 py-0.5 rounded text-xs shrink-0 ${
                  item.level === "critical" ? "bg-danger-dim text-danger" :
                  item.level === "warn" ? "bg-warn-dim text-warn" : "bg-cyan-dim text-cyan"
                }`}>{item.level.toUpperCase()}</span>
                <div>
                  <p className="text-sm font-medium text-ink">{item.title}</p>
                  <p className="text-sm text-ink-2">{item.detail}</p>
                  {item.fix && <p className="text-sm text-cyan mt-1">Fix: {item.fix}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-ok-dim border border-ok/30 rounded-card p-4 text-ok text-sm">
          {t("instance.securityView.noAuditIssues")}
        </div>
      )}

      <div className="bg-s1 border border-edge rounded-card overflow-hidden shadow-card">
        <h3 className="text-lg font-semibold p-4 border-b border-edge text-ink">{t("instance.securityView.agentPermissions")}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge text-ink-2">
              <th className="text-left p-3">{t("security.agentHeader")}</th>
              <th className="text-left p-3">{t("security.allowedTools")}</th>
              <th className="text-left p-3">{t("security.execSecurity")}</th>
              <th className="text-left p-3">{t("security.riskHeader")}</th>
            </tr>
          </thead>
          <tbody>
            {inst.agents.map((a) => {
              const tools = a.toolsAllow || [];
              const exec = a.execSecurity;
              const hasAll = tools.includes("*") || tools.length === 0;
              const hasExec = hasAll || tools.some((tool) => ["exec", "shell", "bash"].includes(tool));
              const isFullExec = hasExec && (!exec || exec.security === "full");
              const risk = isFullExec ? "high" : hasExec ? "medium" : tools.length > 10 ? "medium" : "low";
              return (
                <tr key={a.id} className="border-b border-edge/50">
                  <td className="p-3">{a.id}{a.isDefault ? " (default)" : ""}</td>
                  <td className="p-3">{tools.length === 0 || (tools.length === 1 && tools[0] === "*") ? <span className="px-2 py-0.5 rounded text-xs bg-danger-dim text-danger">all</span> : tools.join(", ")}</td>
                  <td className="p-3">
                    {exec ? (
                      <div className="space-y-0.5">
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          exec.security === "allowlist" ? "bg-ok-dim text-ok" :
                          exec.security === "full" ? "bg-danger-dim text-danger" : "bg-s2 text-ink-2"
                        }`}>{exec.security || "—"}</span>
                        {exec.workspaceOnly && <span className="ml-1 px-1.5 py-0.5 rounded text-xs bg-cyan-dim text-cyan">workspace-only</span>}
                      </div>
                    ) : <span className="text-ink-3">—</span>}
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      risk === "high" ? "bg-danger-dim text-danger" :
                      risk === "medium" ? "bg-warn-dim text-warn" : "bg-ok-dim text-ok"
                    }`}>{risk}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {channelPolicies.length > 0 && (
        <div className="bg-s1 border border-edge rounded-card overflow-hidden shadow-card">
          <h3 className="text-lg font-semibold p-4 border-b border-edge text-ink">{t("instance.securityView.channelPolicies")}</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-ink-2">
                <th className="text-left p-3">{t("security.channelHeader")}</th>
                <th className="text-left p-3">{t("security.accountHeader")}</th>
                <th className="text-left p-3">{t("security.policyHeader")}</th>
                <th className="text-left p-3">{t("security.valueHeader")}</th>
              </tr>
            </thead>
            <tbody>
              {channelPolicies.map((p, i) => (
                <tr key={i} className="border-b border-edge/50">
                  <td className="p-3">{p.channel}</td>
                  <td className="p-3">{p.account}</td>
                  <td className="p-3 font-mono text-xs">{p.key}</td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      p.value === "open" ? "bg-danger-dim text-danger" :
                      p.value === "pairing" ? "bg-warn-dim text-warn" :
                      p.value === "allowlist" ? "bg-ok-dim text-ok" :
                      p.value === "true" ? "bg-ok-dim text-ok" :
                      p.value === "false" ? "bg-s2 text-ink-3" :
                      "bg-s2 text-ink-2"
                    }`}>{p.value}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bindings.length > 0 && (
        <div className="bg-s1 border border-edge rounded-card overflow-hidden shadow-card">
          <h3 className="text-lg font-semibold p-4 border-b border-edge text-ink">{t("instance.securityView.agentBindings")}</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-ink-2">
                <th className="text-left p-3">{t("security.agentHeader")}</th>
                <th className="text-left p-3">{t("security.channelHeader")}</th>
                <th className="text-left p-3">{t("security.accountHeader")}</th>
                <th className="text-left p-3">{t("security.matchHeader")}</th>
              </tr>
            </thead>
            <tbody>
              {bindings.map((b: any, i: number) => (
                <tr key={i} className="border-b border-edge/50">
                  <td className="p-3 font-mono">{b.agentId}</td>
                  <td className="p-3">{b.match?.channel || "*"}</td>
                  <td className="p-3">{b.match?.accountId || "*"}</td>
                  <td className="p-3 text-xs text-ink-2">
                    {b.match?.peer ? `${b.match.peer.kind}:${b.match.peer.id}` : "all"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AgentsTab({ inst, initialAgentId, onSwitchTab }: { inst: InstanceInfo; initialAgentId?: string; onSwitchTab?: (tab: Tab) => void }) {
  const { t } = useTranslation();
  const [models, setModels] = useState<string[]>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [defaultModel, setDefaultModel] = useState("");
  const [defaultThinking, setDefaultThinking] = useState("");
  const [agents, setAgents] = useState<AgentFormValues[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [cfg, modelData] = await Promise.all([
        get<any>(`/lifecycle/${inst.id}/config-file`),
        get<{ models: string[]; modelsByProvider: Record<string, string[]>; defaultModel: string }>(`/lifecycle/${inst.id}/models`),
      ]);
      setModels(modelData.models);
      setModelsByProvider(modelData.modelsByProvider || {});

      const agentsSection = cfg?.agents || {};
      const defaults = agentsSection.defaults || {};
      setDefaultThinking(defaults.thinkingDefault || "");
      setDefaultModel(defaults.model?.primary || modelData.defaultModel || "");

      const list: any[] = agentsSection.list || [];
      const mapped = list.map((a: any) => ({
        id: a.id,
        model: a.model?.primary || "",
        thinkingDefault: a.thinkingDefault || "",
        toolsAllow: a.tools?.allow || [],
        execSecurity: a.tools?.exec?.security || "",
        workspace: a.workspace || "",
        workspaceOnly: a.tools?.exec?.applyPatch?.workspaceOnly || false,
        fsWorkspaceOnly: a.tools?.fs?.workspaceOnly || false,
      }));
      setAgents(mapped);
      if (mapped.length > 0 && !selectedId) {
        const target = initialAgentId && mapped.find((a) => a.id === initialAgentId);
        setSelectedId(target ? target.id : mapped[0].id);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [inst.id]);

  const selected = agents.find((a) => a.id === selectedId) || null;

  const updateAgent = (values: AgentFormValues) => {
    setAgents((prev) => prev.map((a) => a.id === selectedId ? values : a));
    if (values.id !== selectedId) setSelectedId(values.id);
  };

  const noLlm = models.length === 0 && Object.keys(modelsByProvider).length === 0;

  const addNewAgent = () => {
    if (noLlm) {
      setError(t("instance.agents.noLlmConfigured"));
      return;
    }
    const newAgent: AgentFormValues = {
      id: "",
      model: "",
      thinkingDefault: "",
      toolsAllow: [],
      execSecurity: "",
      workspace: "",
      workspaceOnly: false,
      fsWorkspaceOnly: false,
    };
    setAgents((prev) => [...prev, newAgent]);
    setSelectedId("");
    setIsNew(true);
  };

  const saveAll = async () => {
    if (isNew && agents.some((a) => !a.id)) {
      setError(t("instance.agents.agentIdRequired"));
      return;
    }
    const ids = agents.map((a) => a.id);
    if (new Set(ids).size !== ids.length) {
      setError(t("instance.agents.duplicateIds"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await put(`/lifecycle/${inst.id}/agents`, {
        defaults: { model: defaultModel, thinkingDefault: defaultThinking },
        agents,
      });
      setIsNew(false);
      setShowRestartDialog(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async (agentId: string) => {
    setBusy(true);
    setError("");
    try {
      await del(`/lifecycle/${inst.id}/agents/${agentId}`);
      setShowDeleteConfirm(null);
      if (selectedId === agentId) setSelectedId(null);
      await fetchData();
      setShowRestartDialog(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const applyTemplate = (templateConfig: { toolsAllow: string[]; execSecurity: string; workspaceOnly: boolean }) => {
    if (!selected) return;
    updateAgent({
      ...selected,
      toolsAllow: templateConfig.toolsAllow,
      execSecurity: templateConfig.execSecurity,
      workspaceOnly: templateConfig.workspaceOnly,
      fsWorkspaceOnly: templateConfig.workspaceOnly,
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-ink-3 text-sm">
        <RefreshCw size={16} className="animate-spin mr-2" /> {t("instance.agents.loadingAgentConfig")}
      </div>
    );
  }

  // Guide user to configure LLM first if no agents and no models available
  if (agents.length === 0 && noLlm) {
    return (
      <div className="flex flex-col items-center py-16 text-ink-3">
        <Users size={32} className="mb-3 opacity-40" />
        <p className="text-sm mb-1">{t("instance.agents.noLlmConfigured")}</p>
        <p className="text-xs mb-4 text-ink-3">{t("instance.agents.noLlmHint")}</p>
        {onSwitchTab && (
          <button
            onClick={() => onSwitchTab("llm")}
            className="px-4 py-2 bg-brand text-white rounded text-sm hover:bg-brand/90 transition-colors"
          >
            {t("instance.agents.goToLlm")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Global Defaults */}
      <div className="bg-s1 border border-edge rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold text-ink-2 mb-3 flex items-center gap-2">
          <Users size={16} /> {t("instance.agents.globalDefaults")}
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-ink-3 mb-1">{t("instance.agents.defaultModel")}</label>
            <input
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-s2 border border-edge rounded text-ink focus:outline-none focus:border-cyan"
            />
          </div>
          <div>
            <label className="block text-xs text-ink-3 mb-1">{t("instance.agents.defaultThinking")}</label>
            <input
              value={defaultThinking}
              onChange={(e) => setDefaultThinking(e.target.value)}
              placeholder={t("agents.thinkingPlaceholder")}
              className="w-full px-3 py-2 text-sm bg-s2 border border-edge rounded text-ink placeholder:text-ink-3 focus:outline-none focus:border-cyan"
            />
          </div>
        </div>
      </div>

      {/* Agent list + form */}
      <div className="bg-s1 border border-edge rounded-card shadow-card flex min-h-[400px]">
        {/* Sidebar */}
        <div className="w-48 border-r border-edge">
          <div className="p-3 border-b border-edge flex items-center justify-between">
            <span className="text-sm font-semibold text-ink-2">{t("instance.agents.agentsLabel")}</span>
            <button onClick={addNewAgent} className="text-brand hover:text-brand-light"><Plus size={16} /></button>
          </div>
          <div className="divide-y divide-edge">
            {agents.map((a) => (
              <button
                key={a.id || "__new__"}
                onClick={() => { setSelectedId(a.id); setIsNew(!a.id); }}
                className={`w-full text-left px-3 py-2 text-sm ${
                  selectedId === a.id ? "bg-brand/10 text-brand" : "text-ink hover:bg-s2"
                }`}
              >
                {a.id || t("instance.agents.newAgent")}
              </button>
            ))}
          </div>
        </div>

        {/* Form */}
        <div className="flex-1 p-4">
          {selected ? (
            <>
              <AgentForm
                values={selected}
                onChange={updateAgent}
                models={models}
                modelsByProvider={modelsByProvider}
                defaultModel={defaultModel}
                defaultThinking={defaultThinking}
                isNew={isNew}
                onApplyTemplate={() => setShowTemplateModal(true)}
              />
              <div className="flex items-center gap-3 mt-6 pt-4 border-t border-edge">
                <button
                  onClick={saveAll}
                  disabled={busy}
                  className="px-4 py-2 text-sm rounded bg-brand text-white hover:bg-brand-light disabled:opacity-40"
                >
                  {busy ? t("common.saving") : t("instance.agents.saveAll")}
                </button>
                {!isNew && (
                  <button
                    onClick={() => setShowDeleteConfirm(selected.id)}
                    className="flex items-center gap-1 px-3 py-2 text-sm text-danger hover:text-danger/80"
                  >
                    <Trash2 size={14} /> {t("common.delete")}
                  </button>
                )}
                {error && <span className="text-sm text-danger">{error}</span>}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-ink-3 text-sm">
              {t("instance.agents.selectOrCreate")}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirm */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-s1 border border-edge rounded-card p-6 shadow-card max-w-sm w-full">
            <h3 className="text-lg font-semibold text-ink mb-2">{t("instance.agents.deleteAgent")}</h3>
            <p className="text-sm text-ink-2 mb-4">
              {t("instance.agents.deleteAgentConfirm", { id: showDeleteConfirm })}
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setShowDeleteConfirm(null)} className="px-4 py-2 text-sm text-ink-3 hover:text-ink">{t("common.cancel")}</button>
              <button
                onClick={() => deleteAgent(showDeleteConfirm)}
                disabled={busy}
                className="px-4 py-2 text-sm rounded bg-danger text-white hover:bg-danger/80 disabled:opacity-40"
              >
                {busy ? t("common.deleting") : t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      <TemplateApplyModal
        open={showTemplateModal}
        onClose={() => setShowTemplateModal(false)}
        onApply={applyTemplate}
        currentValues={{
          toolsAllow: selected?.toolsAllow || [],
          execSecurity: selected?.execSecurity || "",
          workspaceOnly: selected?.workspaceOnly || false,
        }}
      />

      <RestartDialog
        instanceId={inst.id}
        open={showRestartDialog}
        onClose={() => setShowRestartDialog(false)}
      />
    </div>
  );
}

const PROVIDER_PRESETS: Record<string, { label: string; baseUrl: string; api: string; keyPlaceholder: string }> = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", api: "openai-responses", keyPlaceholder: "sk-..." },
  anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages", keyPlaceholder: "sk-ant-..." },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", api: "openai-completions", keyPlaceholder: "sk-..." },
  google: { label: "Google AI", baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai", keyPlaceholder: "AIza..." },
  azure: { label: "Azure OpenAI", baseUrl: "https://{resource}.openai.azure.com/openai", api: "openai-completions", keyPlaceholder: "API key" },
  ollama: { label: "Ollama (local)", baseUrl: "http://localhost:11434", api: "ollama", keyPlaceholder: "" },
  custom: { label: "Custom / Other", baseUrl: "", api: "", keyPlaceholder: "API key" },
};
const AUTH_MODES = ["api-key", "oauth", "aws-sdk", "token"] as const;
const API_TYPES = ["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "ollama", "google-generative-ai", "bedrock-converse-stream"] as const;

interface ProviderEntry {
  preset: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  auth: string;
  api: string;
  models: any[];
}

function detectPreset(name: string, baseUrl: string): string {
  for (const [key, p] of Object.entries(PROVIDER_PRESETS)) {
    if (key === "custom") continue;
    if (name === key) return key;
    try { if (baseUrl && p.baseUrl && baseUrl.includes(new URL(p.baseUrl).hostname)) return key; } catch { /* ignore */ }
  }
  return "custom";
}

function LlmTab({ inst }: { inst: InstanceInfo }) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<Record<string, any>>({});
  const [detectedProviders, setDetectedProviders] = useState<{ name: string; source: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderEntry | null>(null);
  const [editOrigName, setEditOrigName] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // OpenAI OAuth state
  const [openaiAuthMode, setOpenaiAuthMode] = useState<"apikey" | "oauth">("apikey");
  const [oauthStatus, setOauthStatus] = useState<"idle" | "starting" | "waiting" | "authenticating" | "complete" | "error">("idle");
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oauthManualUrl, setOauthManualUrl] = useState("");
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string | null>(null);
  const [hasOAuthToken, setHasOAuthToken] = useState(false);
  const [oauthExpiry, setOauthExpiry] = useState<number | null>(null);

  const fetchProviders = async () => {
    setLoading(true);
    try {
      const r = await get<{ providers: Record<string, any>; detectedProviders?: { name: string; source: string }[] }>(`/lifecycle/${inst.id}/providers`);
      setProviders(r.providers || {});
      setDetectedProviders(r.detectedProviders || []);
    } catch (err: any) {
      setMessage(`${t("common.error")}: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProviders(); }, [inst.id]);

  const saveProviders = async (next: Record<string, any>) => {
    setSaving(true);
    setMessage(null);
    try {
      await put(`/lifecycle/${inst.id}/providers`, { providers: next });
      setProviders(next);
      setMessage(t("instance.llm.saved"));
      setTimeout(() => setMessage(null), 2000);
    } catch (err: any) {
      setMessage(`${t("common.error")}: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const startAdd = () => {
    setEditOrigName(null);
    setShowAdvanced(false);
    setOpenaiAuthMode("apikey");
    setOauthStatus("idle");
    setOauthError(null);
    setOauthManualUrl("");
    setOauthAuthUrl(null);
    setHasOAuthToken(false);
    setOauthExpiry(null);
    const p = PROVIDER_PRESETS.openai;
    setEditing({ preset: "openai", name: "openai", baseUrl: p.baseUrl, apiKey: "", auth: "api-key", api: p.api, models: [] });
  };

  const applyPreset = (preset: string) => {
    if (!editing) return;
    const p = PROVIDER_PRESETS[preset];
    setEditing({
      ...editing,
      preset,
      name: preset === "custom" ? editing.name : preset,
      baseUrl: p.baseUrl,
      api: p.api,
      auth: "api-key",
    });
  };

  const startEdit = (name: string) => {
    const p = providers[name];
    const preset = detectPreset(name, p.baseUrl || "");
    setEditOrigName(name);
    setShowAdvanced(p.auth ? (p.auth !== "api-key" && p.auth !== "oauth") : false);
    const isOAuth = p.auth === "oauth" || !!p._oauthRefreshToken;
    setOpenaiAuthMode(preset === "openai" && isOAuth ? "oauth" : "apikey");
    setHasOAuthToken(isOAuth && !!p.apiKey);
    setOauthExpiry(p._oauthExpiresAt || null);
    setOauthStatus("idle");
    setOauthError(null);
    setOauthManualUrl("");
    setOauthAuthUrl(null);
    setEditing({
      preset,
      name,
      baseUrl: p.baseUrl || "",
      apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
      auth: p.auth || "api-key",
      api: p.api || "",
      models: p.models || [],
    });
  };

  const saveEntry = async () => {
    if (!editing || !editing.name.trim()) return;
    const next = { ...providers };
    if (editOrigName && editOrigName !== editing.name) {
      delete next[editOrigName];
    }
    const entry: any = { baseUrl: editing.baseUrl };
    if (editing.apiKey) entry.apiKey = editing.apiKey;
    if (editing.auth && editing.auth !== "api-key") entry.auth = editing.auth;
    if (editing.api) entry.api = editing.api;
    if (editing.models.length > 0) entry.models = editing.models;
    next[editing.name] = entry;
    await saveProviders(next);
    setEditing(null);
    setEditOrigName(null);
  };

  const deleteProvider = async (name: string) => {
    const next = { ...providers };
    delete next[name];
    await saveProviders(next);
  };

  if (loading) return <div className="text-ink-3 py-8 text-center">{t("instance.llm.loadingProviders")}</div>;

  const providerNames = Object.keys(providers);

  return (
    <div className="space-y-6">
      <div className="bg-s1 border border-edge rounded-card shadow-card">
        <div className="flex items-center justify-between p-4 border-b border-edge">
          <h3 className="text-lg font-semibold text-ink">{t("instance.llm.llmProviders")}</h3>
          <button onClick={startAdd} className="flex items-center gap-1 px-3 py-1.5 bg-brand hover:bg-brand-light rounded-lg text-sm">
            <Plus size={14} /> {t("instance.llm.addProvider")}
          </button>
        </div>

        {providerNames.length === 0 && detectedProviders.length === 0 && !editing && (
          <div className="p-8 text-center text-ink-3 text-sm">
            {t("instance.llm.noProviders")}
          </div>
        )}

        {(providerNames.length > 0 || detectedProviders.length > 0) && (
          <div className="divide-y divide-edge">
            {providerNames.map((name) => {
              const p = providers[name];
              const preset = PROVIDER_PRESETS[name];
              const displayName = preset ? preset.label : name;
              const maskedKey = p.auth === "oauth"
                ? (p._oauthExpiresAt && p._oauthExpiresAt < Date.now() ? "OAuth (expired)" : "OAuth")
                : typeof p.apiKey === "string" && p.apiKey
                  ? p.apiKey.slice(0, 6) + "..." + p.apiKey.slice(-4)
                  : typeof p.apiKey === "object" ? `(${p.apiKey?.source || "secret"})` : "—";
              return (
                <div key={name} className="p-4 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{displayName}</span>
                      {!preset && <span className="font-mono text-xs text-ink-3">({name})</span>}
                      {p.auth && p.auth !== "api-key" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-dim text-cyan">{p.auth}</span>
                      )}
                    </div>
                    <div className="text-xs text-ink-3 mt-1 flex gap-4">
                      <span className="truncate">{p.baseUrl || "—"}</span>
                      <span>{t("instance.llm.key")} {maskedKey}</span>
                      <span>{(p.models || []).length} {t("instance.llm.model")}{(p.models || []).length !== 1 ? "s" : ""}</span>
                    </div>
                  </div>
                  <button onClick={() => startEdit(name)} className="text-xs text-cyan hover:text-cyan/80 px-2 py-1">{t("common.edit")}</button>
                  <button onClick={() => deleteProvider(name)} className="text-xs text-danger hover:text-danger/80 px-2 py-1">
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
            {detectedProviders.map((dp) => {
              const preset = PROVIDER_PRESETS[dp.name];
              const displayName = preset ? preset.label : dp.name;
              return (
                <div key={`det-${dp.name}`} className="p-4 flex items-center gap-4 opacity-70">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{displayName}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-ok/20 text-ok">{t("instance.llm.auto")}</span>
                    </div>
                    <div className="text-xs text-ink-3 mt-1">
                      <code className="bg-s2 px-1 rounded">{dp.source}</code> — {t("instance.llm.managedOnServer")}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {message && (
          <div className={`px-4 py-2 text-sm ${message.startsWith("Error") ? "text-danger" : "text-ok"}`}>{message}</div>
        )}
      </div>

      {/* Edit/Add form */}
      {editing && (
        <div className="bg-s1 border border-edge rounded-card shadow-card p-5">
          <h3 className="text-lg font-semibold text-ink mb-4">
            {editOrigName ? `${t("instance.llm.editPrefix")} ${PROVIDER_PRESETS[editOrigName]?.label || editOrigName}` : t("instance.llm.addProvider")}
          </h3>
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-ink-2 mb-1">{t("instance.llm.providerLabel")}</label>
              <select
                value={editing.preset}
                onChange={(e) => applyPreset(e.target.value)}
                disabled={!!editOrigName}
                className="w-full bg-s2 border border-edge rounded-lg px-3 py-2.5 text-sm text-ink disabled:opacity-50"
              >
                {Object.entries(PROVIDER_PRESETS).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>

            {editing.preset === "custom" && (
              <div>
                <label className="block text-sm text-ink-2 mb-1">{t("instance.llm.configKeyLabel")}</label>
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="my-provider"
                  className="w-full bg-s2 border border-edge rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand"
                />
                <p className="text-[10px] text-ink-3 mt-1">{t("instance.llm.configKeyHint")}</p>
              </div>
            )}

            <div>
              <label className="block text-sm text-ink-2 mb-1">{t("instance.llm.baseUrlLabel")}</label>
              <input
                value={editing.baseUrl}
                onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                placeholder={PROVIDER_PRESETS[editing.preset]?.baseUrl || "https://..."}
                className="w-full bg-s2 border border-edge rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand"
              />
            </div>

            {editing.preset === "openai" && (
              <div>
                <label className="block text-sm text-ink-2 mb-1">{t("instance.llm.authenticationLabel")}</label>
                <select
                  value={openaiAuthMode}
                  onChange={(e) => setOpenaiAuthMode(e.target.value as "apikey" | "oauth")}
                  className="w-full bg-s2 border border-edge rounded-lg px-3 py-2.5 text-sm text-ink"
                >
                  <option value="apikey">{t("instance.llm.apiKeyOption")}</option>
                  <option value="oauth">{t("instance.llm.oauthOption")}</option>
                </select>
              </div>
            )}

            {editing.preset !== "ollama" && (editing.preset !== "openai" || openaiAuthMode === "apikey") && (
              <div>
                <label className="block text-sm text-ink-2 mb-1">{t("instance.llm.apiKeyLabel")}</label>
                <input
                  value={editing.apiKey}
                  onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                  type="password"
                  placeholder={PROVIDER_PRESETS[editing.preset]?.keyPlaceholder || "API key"}
                  className="w-full bg-s2 border border-edge rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:border-brand"
                />
              </div>
            )}

            {editing.preset === "openai" && openaiAuthMode === "oauth" && (
              <div className="p-3 bg-s2/50 border border-edge rounded-lg space-y-3">
                {hasOAuthToken && (
                  <div className="flex items-center gap-2">
                    <span className={`inline-block w-2 h-2 rounded-full ${oauthExpiry && oauthExpiry < Date.now() ? "bg-warn" : "bg-ok"}`} />
                    <span className="text-sm text-ink-2">
                      {oauthExpiry && oauthExpiry < Date.now() ? t("instance.llm.tokenExpired") : t("instance.llm.oauthConnected")}
                    </span>
                    {oauthExpiry && (
                      <span className="text-[10px] text-ink-3 ml-auto">
                        {oauthExpiry < Date.now() ? t("instance.llm.expired") : t("instance.llm.expires")}: {new Date(oauthExpiry).toLocaleString()}
                      </span>
                    )}
                  </div>
                )}

                {(oauthStatus === "idle" || oauthStatus === "error") && (
                  <button
                    onClick={async () => {
                      setOauthStatus("starting");
                      setOauthError(null);
                      setOauthAuthUrl(null);
                      try {
                        const r = await post<{ authUrl: string }>("/settings/oauth/openai/start", {});
                        setOauthAuthUrl(r.authUrl);
                        setOauthStatus("waiting");
                        // Poll for completion
                        const poll = setInterval(async () => {
                          try {
                            const s = await get<{ status: string; credentials?: any; error?: string }>("/settings/oauth/openai/status");
                            if (s.status === "complete") {
                              clearInterval(poll);
                              setOauthStatus("authenticating");
                              const saveR = await post<{ ok: boolean; expiresAt?: number }>(`/lifecycle/${inst.id}/providers/oauth/save`, {});
                              if (saveR.ok) {
                                setOauthStatus("complete");
                                setHasOAuthToken(true);
                                setOauthExpiry(saveR.expiresAt || null);
                                setOauthAuthUrl(null);
                                setMessage(t("instance.llm.openaiOauthConfigured"));
                                await fetchProviders();
                              }
                            } else if (s.status === "error") {
                              clearInterval(poll);
                              setOauthStatus("error");
                              setOauthError(s.error || "OAuth failed");
                            }
                          } catch { /* ignore poll errors */ }
                        }, 2000);
                        setTimeout(() => clearInterval(poll), 150_000);
                      } catch (e: any) {
                        setOauthStatus("error");
                        setOauthError(e.message);
                      }
                    }}
                    className="w-full px-4 py-2.5 bg-brand hover:bg-brand-light rounded-lg text-sm font-medium transition-colors"
                  >
                    {hasOAuthToken ? t("instance.llm.reAuthOpenai") : t("instance.llm.loginWithOpenai")}
                  </button>
                )}

                {oauthStatus === "starting" && (
                  <p className="text-sm text-ink-2 animate-pulse">{t("instance.llm.startingOauth")}</p>
                )}

                {oauthStatus === "waiting" && (
                  <div className="space-y-3">
                    <p className="text-sm text-ink-2">{t("instance.llm.openAuthUrl")}</p>
                    {oauthAuthUrl && (
                      <div className="bg-s2 border border-edge rounded-lg p-2.5">
                        <p className="text-xs text-ink-3 font-mono break-all mb-2 select-all">{oauthAuthUrl}</p>
                        <div className="flex gap-2">
                          <button
                            onClick={() => { navigator.clipboard.writeText(oauthAuthUrl); setMessage("URL copied"); }}
                            className="flex-1 px-3 py-1.5 bg-s1 border border-edge hover:border-brand rounded-lg text-xs text-ink-2 hover:text-ink transition-colors"
                          >
                            {t("instance.llm.copyUrl")}
                          </button>
                          <button
                            onClick={() => window.open(oauthAuthUrl, "_blank", "width=600,height=700")}
                            className="flex-1 px-3 py-1.5 bg-brand hover:bg-brand-light rounded-lg text-xs font-medium transition-colors"
                          >
                            {t("instance.llm.openInBrowser")}
                          </button>
                        </div>
                      </div>
                    )}
                    <p className="text-xs text-ink-3">{t("instance.llm.waitingCallback")}</p>
                    <div>
                      <div className="flex gap-2">
                        <input
                          value={oauthManualUrl}
                          onChange={(e) => setOauthManualUrl(e.target.value)}
                          placeholder="http://localhost:1455/auth/callback?code=..."
                          className="flex-1 bg-s2 border border-edge rounded-lg px-3 py-1.5 text-xs text-ink placeholder:text-ink-3 focus:border-brand font-mono"
                        />
                        <button
                          onClick={async () => {
                            if (!oauthManualUrl.trim()) return;
                            try {
                              await post("/settings/oauth/openai/callback", { redirectUrl: oauthManualUrl });
                              setOauthManualUrl("");
                            } catch (e: any) {
                              setOauthError(e.message);
                            }
                          }}
                          disabled={!oauthManualUrl.trim()}
                          className="px-3 py-1.5 bg-brand hover:bg-brand-light rounded-lg text-xs disabled:opacity-50"
                        >
                          {t("common.submit")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {oauthStatus === "authenticating" && (
                  <p className="text-sm text-ink-2 animate-pulse">{t("instance.llm.savingTokens")}</p>
                )}

                {oauthStatus === "complete" && (
                  <p className="text-sm text-ok">{t("instance.llm.oauthConfigured")}</p>
                )}

                {oauthError && <p className="text-sm text-danger">{oauthError}</p>}

                <p className="text-[10px] text-ink-3">
                  {t("instance.llm.oauthNote")}
                </p>
              </div>
            )}

            {/* Advanced options — auto-configured from preset, only show for override */}
            {editing.preset !== "custom" && !showAdvanced ? (
              <div className="flex items-center gap-3 text-xs text-ink-3">
                <span>{t("instance.llm.apiTypeLabel")}: <code className="text-ink-2">{editing.api || t("instance.llm.autoDetect")}</code></span>
                <span>{t("instance.llm.authModeLabel")}: <code className="text-ink-2">{editing.auth}</code></span>
                <button onClick={() => setShowAdvanced(true)} className="text-ink-3 hover:text-ink underline underline-offset-2">
                  {t("common.override")}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 p-3 bg-s2/50 border border-edge rounded-lg">
                <div>
                  <label className="block text-xs text-ink-2 mb-1">{t("instance.llm.authModeLabel")}</label>
                  <select
                    value={editing.auth}
                    onChange={(e) => setEditing({ ...editing, auth: e.target.value })}
                    className="w-full bg-s2 border border-edge rounded-lg px-3 py-2 text-sm text-ink"
                  >
                    {AUTH_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-ink-2 mb-1">{t("instance.llm.apiTypeLabel")}</label>
                  <select
                    value={editing.api}
                    onChange={(e) => setEditing({ ...editing, api: e.target.value })}
                    className="w-full bg-s2 border border-edge rounded-lg px-3 py-2 text-sm text-ink"
                  >
                    <option value="">{t("instance.llm.autoDetect")}</option>
                    {API_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
              </div>
            )}

            {editing.models.length > 0 && (
              <div>
                <label className="block text-sm text-ink-2 mb-1">{t("instance.llm.modelsLabel")} ({editing.models.length})</label>
                <div className="flex flex-wrap gap-1">
                  {editing.models.map((m: any, i: number) => (
                    <span key={i} className="px-2 py-0.5 rounded bg-s2 text-xs text-ink-2 font-mono">{m.id || m.name || `model-${i}`}</span>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={saveEntry}
                disabled={saving || !editing.name.trim() || !editing.baseUrl.trim()}
                className="px-4 py-2 bg-brand hover:bg-brand-light rounded-lg text-sm disabled:opacity-50"
              >
                {saving ? t("common.saving") : editOrigName ? t("instance.llm.update") : t("common.add")}
              </button>
              <button onClick={() => { setEditing(null); setEditOrigName(null); }} className="px-4 py-2 text-sm text-ink-3 hover:text-ink">
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ControlTab({ inst }: { inst: InstanceInfo }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{ running: boolean; pid?: number } | null>(null);
  const [versions, setVersions] = useState<{ node: any; openclaw: any } | null>(null);
  const [configText, setConfigText] = useState("");
  const [configError, setConfigError] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const [snaps, setSnaps] = useState<any[]>([]);
  const [snapReason, setSnapReason] = useState("");
  const [diffResult, setDiffResult] = useState<any>(null);
  const [diffIds, setDiffIds] = useState<[number|null, number|null]>([null, null]);
  const [initialLoading, setInitialLoading] = useState(true);

  const fetchStatus = async () => {
    try {
      const s = await get<{ running: boolean; pid?: number }>(`/lifecycle/${inst.id}/status`);
      setStatus(s);
    } catch { setStatus({ running: false }); }
  };

  const fetchVersions = async () => {
    try {
      const hostId = inst.id.match(/^ssh-(\d+)-/)?.[1] || "local";
      const v = await get<any>(`/lifecycle/host/${hostId}/versions`);
      setVersions(v);
    } catch { /* ignore */ }
  };

  const fetchConfig = async () => {
    try {
      const cfg = await get<any>(`/lifecycle/${inst.id}/config-file`);
      setConfigText(JSON.stringify(cfg, null, 2));
      setConfigDirty(false);
      setConfigError("");
    } catch (e: any) {
      setConfigError(e.message || t("instance.control.failedLoadConfig"));
    }
  };

  const fetchSnaps = async () => {
    try { setSnaps(await get<any[]>(`/lifecycle/${inst.id}/snapshots`)); } catch {}
  };

  useEffect(() => {
    Promise.all([fetchStatus(), fetchVersions(), fetchConfig(), fetchSnaps()])
      .finally(() => setInitialLoading(false));
    const timer = setInterval(fetchStatus, 10_000);
    return () => clearInterval(timer);
  }, [inst.id]);

  const doAction = async (action: string) => {
    setBusy(action);
    try {
      await post(`/lifecycle/${inst.id}/${action}`);
      await fetchStatus();
    } finally { setBusy(""); }
  };

  const saveConfig = async () => {
    try {
      JSON.parse(configText);
    } catch {
      setConfigError(t("instance.control.invalidJson"));
      return;
    }
    setBusy("config");
    try {
      await put(`/lifecycle/${inst.id}/config-file`, JSON.parse(configText));
      setConfigDirty(false);
      setConfigError("");
    } catch (e: any) {
      setConfigError(e.message);
    } finally { setBusy(""); }
  };

  const [installVersion, setInstallVersion] = useState("");
  const [installSteps, setInstallSteps] = useState<Array<{ step: string; status: string; detail?: string }>>([]);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const doInstall = async () => {
    const hostId = inst.id.match(/^ssh-(\d+)-/)?.[1] || "local";
    setBusy("install");
    setInstallSteps([]);
    try {
      const res = await fetch(`/api/lifecycle/host/${hostId}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ version: installVersion || undefined }),
      });
      const reader = res.body?.getReader();
      if (reader) {
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
              if (msg.done !== undefined) break;
              setInstallSteps((prev) => {
                const idx = prev.findIndex((s) => s.step === msg.step);
                if (idx >= 0) { const next = [...prev]; next[idx] = msg; return next; }
                return [...prev, msg];
              });
            } catch { /* ignore */ }
          }
        }
      }
      await fetchVersions();
    } finally { setBusy(""); }
  };

  const doUninstall = async () => {
    const hostId = inst.id.match(/^ssh-(\d+)-/)?.[1] || "local";
    setBusy("uninstall");
    setInstallSteps([]);
    try {
      const res = await fetch(`/api/lifecycle/host/${hostId}/uninstall`, {
        method: "POST",
        credentials: "include",
      });
      const reader = res.body?.getReader();
      if (reader) {
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
              if (msg.done !== undefined) break;
              setInstallSteps((prev) => {
                const idx = prev.findIndex((s) => s.step === msg.step);
                if (idx >= 0) { const next = [...prev]; next[idx] = msg; return next; }
                return [...prev, msg];
              });
            } catch { /* ignore */ }
          }
        }
      }
      await fetchVersions();
    } finally { setBusy(""); }
  };

  const toggleLogs = async () => {
    if (showLogs) { setShowLogs(false); return; }
    setShowLogs(true);
    setLogs([]);
    try {
      const res = await fetch(`/api/lifecycle/${inst.id}/logs?lines=50`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to fetch logs" }));
        setLogs([`Error: ${(err as any).error || res.statusText}`]);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        const lines = text.split("\n").filter(l => l.startsWith("data: ")).map(l => {
          try { return JSON.parse(l.slice(6)); } catch { return l.slice(6); }
        });
        if (lines.length) {
          setLogs(prev => [...prev, ...lines].slice(-500));
          logRef.current?.scrollTo(0, logRef.current.scrollHeight);
        }
      }
    } catch { /* stream ended */ }
  };

  const createSnapshot = async () => {
    setBusy("snapshot");
    try {
      await post(`/lifecycle/${inst.id}/snapshots`, { configJson: configText, reason: snapReason || undefined });
      setSnapReason("");
      await fetchSnaps();
    } finally { setBusy(""); }
  };

  const doDiff = async () => {
    if (diffIds[0] === null || diffIds[1] === null) return;
    try {
      const result = await post<any>("/lifecycle/snapshots/diff", { id1: diffIds[0], id2: diffIds[1] });
      setDiffResult(result);
    } catch {}
  };

  const doCleanup = async () => {
    try {
      await post(`/lifecycle/${inst.id}/snapshots/cleanup`, { keepCount: 10 });
      await fetchSnaps();
    } catch {}
  };

  const restoreSnapshot = async (snapId: number) => {
    if (!confirm(t("instance.control.restoreConfirm", { id: snapId }))) return;
    setBusy("restore");
    try {
      await post(`/lifecycle/${inst.id}/snapshots/${snapId}/restore`, {});
      await fetchSnaps();
      // Refresh the config display
      try {
        const cfg = await get<any>(`/lifecycle/${inst.id}/config-file`);
        setConfigText(JSON.stringify(cfg, null, 2));
      } catch {}
    } finally { setBusy(""); }
  };

  if (initialLoading) {
    return (
      <div className="flex items-center justify-center py-20 text-ink-3 text-sm">
        <RefreshCw size={16} className="animate-spin mr-2" /> {t("instance.control.loadingLifecycle")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Process Control */}
      <div className="bg-s1 border border-edge rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wider mb-3">{t("instance.control.processControl")}</h3>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-3 h-3 rounded-full ${status === null ? "bg-ink-3 animate-pulse" : status.running ? "bg-ok shadow-glow-cyan" : "bg-ink-3"}`} />
            <span className="text-ink font-medium">
              {status === null ? t("instance.control.checkingStatus") : status.running ? (status.pid ? t("instance.control.runningWithPid", { pid: status.pid }) : t("instance.control.runningLabel")) : t("instance.control.stoppedLabel")}
            </span>
          </div>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={() => doAction("start")}
              disabled={!!busy || status?.running === true}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-ok/20 text-ok hover:bg-ok/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play size={14} /> {t("common.start")}
            </button>
            <button
              onClick={() => doAction("stop")}
              disabled={!!busy || !status?.running}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-danger/20 text-danger hover:bg-danger/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Square size={14} /> {t("common.stop")}
            </button>
            <button
              onClick={() => doAction("restart")}
              disabled={!!busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-warn/20 text-warn hover:bg-warn/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCcw size={14} /> {t("common.restart")}
            </button>
          </div>
        </div>
        {busy && ["start", "stop", "restart"].includes(busy) && (
          <p className="mt-2 text-sm text-ink-3 animate-pulse">{t("instance.control.processing", { action: busy })}</p>
        )}
      </div>

      {/* Version & Upgrade */}
      <div className="bg-s1 border border-edge rounded-card p-4 shadow-card">
        <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wider mb-3">{t("instance.control.version")}</h3>
        <div className="flex items-center gap-6">
          <div>
            <span className="text-xs text-ink-3">{t("instance.control.installed")}</span>
            <p className="font-mono text-ink">{versions?.openclaw?.installed || inst.version || t("instance.control.notFound")}</p>
          </div>
          <div>
            <span className="text-xs text-ink-3">{t("instance.control.latest")}</span>
            <p className="font-mono text-ink">{versions?.openclaw?.latest || (versions ? t("common.unknown") : "...")}</p>
          </div>
          <div>
            <span className="text-xs text-ink-3">{t("instance.control.nodejs")}</span>
            <p className={`font-mono ${!versions ? "text-ink-3" : versions.node?.sufficient ? "text-ok" : "text-danger"}`}>
              {versions?.node?.version || (versions ? t("instance.control.notFound") : "...")}
            </p>
          </div>
          {versions?.openclaw?.distTags && (
            <div className="ml-auto flex items-center gap-2">
              <select
                value={installVersion}
                onChange={(e) => setInstallVersion(e.target.value)}
                className="bg-s2 border border-edge rounded px-2 py-1.5 text-sm text-ink"
              >
                {Object.entries(versions.openclaw.distTags as Record<string, string>)
                  .sort(([a], [b]) => a === "latest" ? -1 : b === "latest" ? 1 : a.localeCompare(b))
                  .map(([tag, ver]) => (
                  <option key={tag} value={ver}>
                    {tag === "latest" ? `${ver} (stable)` : `${ver} (${tag})`}
                  </option>
                ))}
              </select>
              <button
                onClick={doInstall}
                disabled={!!busy || (versions?.openclaw?.installed === installVersion)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-brand/20 text-brand hover:bg-brand/30 disabled:opacity-40"
              >
                {(versions?.openclaw?.installed || inst.version) ? <><ArrowUpCircle size={14} /> {t("instance.control.upgrade")}</> : <><Download size={14} /> {t("instance.control.install")}</>}
              </button>
              {(versions?.openclaw?.installed || inst.version) && (
                <button
                  onClick={() => setConfirmUninstall(true)}
                  disabled={!!busy}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-danger/20 text-danger hover:bg-danger/30 disabled:opacity-40"
                >
                  <Trash2 size={14} /> {t("instance.control.uninstall")}
                </button>
              )}
            </div>
          )}
        </div>
        {installSteps.length > 0 && (
          <div className="mt-3 pt-3 border-t border-edge space-y-1">
            {installSteps.map((s, i) => (
              <div key={i} className="flex items-start gap-1.5 text-xs">
                <span className="shrink-0">{s.status === "running" ? "⏳" : s.status === "done" ? "✅" : s.status === "error" ? "❌" : "⏭️"}</span>
                <span className={s.status === "error" ? "text-danger" : s.status === "done" ? "text-ok" : "text-ink-2"}>
                  {s.step}{s.detail ? ` — ${s.detail}` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Config Editor */}
      <div className="bg-s1 border border-edge rounded-card shadow-card">
        <div className="flex items-center justify-between p-4 border-b border-edge">
          <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wider">{t("instance.control.configFile")}</h3>
          <button
            onClick={saveConfig}
            disabled={!configDirty || !!busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-brand text-white hover:bg-brand-light disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Save size={14} /> {t("common.save")}
          </button>
        </div>
        <textarea
          value={configText}
          onChange={(e) => { setConfigText(e.target.value); setConfigDirty(true); setConfigError(""); }}
          className="w-full h-80 p-4 bg-s2 text-sm font-mono text-ink border-0 focus:outline-none resize-none"
          spellCheck={false}
        />
        {configError && <p className="px-4 py-2 text-sm text-danger">{configError}</p>}
      </div>

      {/* Config Snapshots */}
      <div className="bg-s1 border border-edge rounded-card shadow-card">
        <div className="flex items-center justify-between p-4 border-b border-edge">
          <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wider">{t("instance.control.configSnapshots")}</h3>
          <div className="flex gap-2">
            <input
              value={snapReason}
              onChange={(e) => setSnapReason(e.target.value)}
              placeholder={t("instance.control.reasonPlaceholder")}
              className="px-2 py-1 text-sm bg-s2 border border-edge rounded text-ink placeholder:text-ink-3 w-40"
            />
            <button
              onClick={createSnapshot}
              disabled={!configText || !!busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-brand/20 text-brand hover:bg-brand/30 disabled:opacity-40"
            >
              <Camera size={14} /> {t("instance.control.snapshot")}
            </button>
          </div>
        </div>

        {snaps.length > 0 ? (
          <div className="divide-y divide-edge">
            {snaps.slice(0, 20).map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="font-mono text-ink-3">#{s.id}</span>
                <span className="text-ink">{s.reason || "—"}</span>
                <span className="text-xs text-ink-3 ml-auto">{s.created_at}</span>
                <button
                  onClick={() => restoreSnapshot(s.id)}
                  disabled={!!busy}
                  className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-s2 text-ink-3 hover:text-warn hover:bg-warn/10 disabled:opacity-40"
                  title={t("instance.control.restore")}
                >
                  <RotateCcw size={11} /> {t("instance.control.restore")}
                </button>
                <button
                  onClick={() => setDiffIds(prev => prev[0] === null ? [s.id, prev[1]] : [prev[0], s.id])}
                  className={`px-2 py-0.5 text-xs rounded ${
                    diffIds.includes(s.id) ? "bg-brand text-white" : "bg-s2 text-ink-3 hover:text-ink"
                  }`}
                >
                  {diffIds[0] === s.id ? "A" : diffIds[1] === s.id ? "B" : t("common.select")}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="p-4 text-sm text-ink-3">{t("instance.control.noSnapshots")}</p>
        )}

        {/* Diff controls */}
        {(diffIds[0] !== null || diffIds[1] !== null) && (
          <div className="border-t border-edge p-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-ink-2">
                {t("instance.control.comparing", { a: diffIds[0] ?? "?", b: diffIds[1] ?? "?" })}
              </span>
              <button
                onClick={doDiff}
                disabled={diffIds[0] === null || diffIds[1] === null}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-cyan/20 text-cyan hover:bg-cyan/30 disabled:opacity-40"
              >
                <GitCompare size={14} /> {t("common.compare")}
              </button>
              <button
                onClick={() => { setDiffIds([null, null]); setDiffResult(null); }}
                className="px-2 py-1 text-xs text-ink-3 hover:text-ink"
              >
                {t("common.clear")}
              </button>
            </div>
            {diffResult && (
              <div className="mt-3 bg-s2 rounded p-3 text-sm font-mono overflow-auto max-h-60">
                {diffResult.changes.length === 0 ? (
                  <p className="text-ok">{t("instance.control.noDifferencesFound")}</p>
                ) : (
                  diffResult.changes.map((ch: any, i: number) => (
                    <div key={i} className="mb-1">
                      <span className="text-ink-2">{ch.path}: </span>
                      <span className="text-danger">{JSON.stringify(ch.before)}</span>
                      <span className="text-ink-3"> → </span>
                      <span className="text-ok">{JSON.stringify(ch.after)}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* Cleanup */}
        {snaps.length > 10 && (
          <div className="border-t border-edge px-4 py-2 flex justify-end">
            <button
              onClick={doCleanup}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-ink-3 hover:text-danger"
            >
              <Trash2 size={12} /> {t("instance.control.cleanOldSnapshots")}
            </button>
          </div>
        )}
      </div>

      {/* Logs */}
      <div className="bg-s1 border border-edge rounded-card shadow-card">
        <div className="flex items-center justify-between p-4 border-b border-edge">
          <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wider">{t("instance.control.logs")}</h3>
          <button
            onClick={toggleLogs}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-s2 text-ink-2 hover:text-ink hover:bg-s3"
          >
            <Terminal size={14} /> {showLogs ? t("instance.control.hideLogs") : t("instance.control.streamLogs")}
          </button>
        </div>
        {showLogs && (
          <div ref={logRef} className="h-64 overflow-auto p-4 bg-deep font-mono text-xs text-ink-2 whitespace-pre-wrap">
            {logs.length === 0 ? (
              <span className="text-ink-3 animate-pulse">{t("instance.control.waitingForLogs")}</span>
            ) : (
              logs.map((line, i) => <div key={i}>{line}</div>)
            )}
          </div>
        )}
      </div>

      {confirmUninstall && (
        <ConfirmDialog
          title={t("instance.control.uninstallConfirmTitle")}
          message={t("instance.control.uninstallConfirmMsg")}
          confirmLabel={t("instance.control.uninstall")}
          onConfirm={async () => {
            setConfirmUninstall(false);
            await doUninstall();
          }}
          onCancel={() => setConfirmUninstall(false)}
        />
      )}
    </div>
  );
}

function ChannelsTab({ inst }: { inst: InstanceInfo }) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [editingAccount, setEditingAccount] = useState<{ channel: string; accountId: string } | null>(null);
  const [editValues, setEditValues] = useState<ChannelFormValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [showRestartDialog, setShowRestartDialog] = useState(false);

  useEffect(() => { loadChannels(); }, [inst.id]);

  async function loadChannels() {
    setLoading(true);
    try {
      const data = await get<any>(`/lifecycle/${inst.id}/channels`);
      setChannels(data.channels || []);
    } catch { setChannels([]); }
    setLoading(false);
  }

  async function handleProbe() {
    setProbing(true);
    try {
      const data = await post<any>(`/lifecycle/${inst.id}/channels/probe`);
      setChannels(data.channels || []);
    } catch { /* keep existing */ }
    setProbing(false);
  }

  async function handleLogout(channel: string, accountId: string) {
    if (!confirm(`${t("channels.logout")} ${channel}/${accountId}?`)) return;
    try {
      await post(`/lifecycle/${inst.id}/channels/logout`, { channel, accountId });
      loadChannels();
    } catch (err: any) {
      alert(`${t("channels.logout")} failed: ${err.message}`);
    }
  }

  function startEdit(channel: string, accountId: string, account: any, configChannels: any) {
    const chConfig = configChannels?.[channel] || {};
    const accConfig = chConfig.accounts?.[accountId] || chConfig;
    setEditingAccount({ channel, accountId });
    setEditValues({
      enabled: account.enabled ?? true,
      dmPolicy: accConfig.dmPolicy || account.dmPolicy || "",
      groupPolicy: accConfig.groupPolicy || account.groupPolicy || "",
      allowFrom: (accConfig.allowFrom || account.allowFrom || []).map(String),
      groupAllowFrom: (accConfig.groupAllowFrom || account.groupAllowFrom || []).map(String),
      historyLimit: accConfig.historyLimit ?? "",
      dmHistoryLimit: accConfig.dmHistoryLimit ?? "",
      textChunkLimit: accConfig.textChunkLimit ?? "",
      chunkMode: accConfig.chunkMode || "",
      blockStreaming: accConfig.blockStreaming ?? false,
    });
  }

  async function handleSave() {
    if (!editingAccount || !editValues) return;
    setSaving(true);
    try {
      await put(`/lifecycle/${inst.id}/channels/config`, {
        channel: editingAccount.channel,
        accountId: editingAccount.accountId,
        config: editValues,
      });
      setEditingAccount(null);
      setEditValues(null);
      setShowRestartDialog(true);
      loadChannels();
    } catch (err: any) {
      alert(`${t("common.save")} failed: ${err.message}`);
    }
    setSaving(false);
  }

  async function handleToggleEnabled(channel: string, accountId: string, currentEnabled: boolean) {
    try {
      await put(`/lifecycle/${inst.id}/channels/config`, {
        channel,
        accountId,
        config: { enabled: !currentEnabled },
      });
      setShowRestartDialog(true);
      loadChannels();
    } catch (err: any) {
      alert(`${t("common.error")}: ${err.message}`);
    }
  }

  const configChannels = (inst.config as any)?.parsed?.channels || {};

  if (loading) return <div className="text-ink-3 text-sm p-4">{t("channels.loadingChannels")}</div>;

  return (
    <div className="space-y-4">
      {/* Header with probe button */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-ink">{t("channels.title")}</h3>
        <button
          onClick={handleProbe}
          disabled={probing}
          className="flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"
        >
          <Search size={14} className={probing ? "animate-spin" : ""} />
          {probing ? t("channels.probing") : t("channels.probe")}
        </button>
      </div>

      {channels.length === 0 && <p className="text-ink-3 text-sm">{t("channels.noChannelsConfigured")}</p>}

      {/* Channels grouped by type, running channels first */}
      {[...channels].sort((a: any, b: any) => {
        const aRunning = a.accounts.some((acc: any) => acc.running || acc.connected);
        const bRunning = b.accounts.some((acc: any) => acc.running || acc.connected);
        if (aRunning !== bRunning) return aRunning ? -1 : 1;
        const aEnabled = a.accounts.some((acc: any) => acc.enabled);
        const bEnabled = b.accounts.some((acc: any) => acc.enabled);
        if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
        return 0;
      }).map((ch: any) => {
        const connectedCount = ch.accounts.filter((a: any) => a.connected).length;
        const runningCount = ch.accounts.filter((a: any) => a.running).length;
        return (
          <div key={ch.type} className="bg-s1 border border-edge rounded-card shadow-card overflow-hidden">
            {/* Channel type header */}
            <div className="flex items-center justify-between p-4 border-b border-edge">
              <div className="flex items-center gap-2">
                <Radio size={16} className="text-ink-3" />
                <span className="font-semibold text-ink">{ch.label || ch.type}</span>
                <span className="text-ink-3 text-xs">{ch.type}</span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-ink-2">{ch.accounts.length} {t("channels.account")}{ch.accounts.length !== 1 ? "s" : ""}</span>
                {connectedCount > 0 && <span className="text-ok">{connectedCount} {t("channels.connected")}</span>}
                {runningCount > connectedCount && <span className="text-ok">{runningCount - connectedCount} {t("channels.running")}</span>}
                {ch.accounts.length > runningCount && <span className="text-ink-2">{ch.accounts.length - runningCount} {t("channels.stopped")}</span>}
              </div>
            </div>

            {/* Account rows */}
            <div className="divide-y divide-edge/50">
              {[...ch.accounts].sort((a: any, b: any) => {
                const score = (x: any) => x.connected ? 3 : x.running ? 2 : x.enabled ? 1 : 0;
                return score(b) - score(a);
              }).map((acc: any) => {
                const isEditing = editingAccount?.channel === ch.type && editingAccount?.accountId === acc.accountId;
                const statusLabel = !acc.enabled ? "disabled" : acc.connected ? "connected" : acc.running ? "running" : acc.lastError ? "error" : "stopped";
                const statusColor = statusLabel === "connected" ? "bg-ok" : statusLabel === "running" ? "bg-ok" : statusLabel === "error" ? "bg-danger" : "bg-ink-2";

                return (
                  <div key={acc.accountId} className="p-4">
                    {/* Account header row */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`inline-block w-2 h-2 rounded-full ${statusColor}`} />
                        <span className="text-sm font-medium text-ink">{acc.accountId}</span>
                        {acc.name && <span className="text-ink-2 text-xs">({acc.name})</span>}
                        <span className={`text-xs ${statusLabel === "connected" ? "text-ok" : statusLabel === "running" ? "text-ok" : statusLabel === "error" ? "text-danger" : "text-ink-2"}`}>
                          {statusLabel}
                        </span>
                      </div>
                      {!isEditing && (
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => startEdit(ch.type, acc.accountId, acc, configChannels)}
                            className="px-2 py-1 text-xs rounded bg-s2 border border-edge text-ink hover:bg-s3"
                          >
                            {t("common.edit")}
                          </button>
                          <button
                            onClick={() => handleToggleEnabled(ch.type, acc.accountId, acc.enabled)}
                            className="px-2 py-1 text-xs rounded bg-s2 border border-edge text-ink hover:bg-s3"
                          >
                            {acc.enabled ? t("channels.disable") : t("channels.enable")}
                          </button>
                          <button
                            onClick={() => handleLogout(ch.type, acc.accountId)}
                            className="px-2 py-1 text-xs rounded bg-s2 border border-edge text-ink hover:bg-s3 flex items-center gap-1"
                          >
                            <LogOut size={12} /> {t("channels.logout")}
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Status details */}
                    <div className="space-y-1.5 text-xs">
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <div><span className="text-ink-3">{t("channels.connectedLabel")}</span> <span className="text-ink">{timeAgo(acc.lastConnectedAt) || "\u2014"}</span></div>
                        <div><span className="text-ink-3">{t("channels.lastIn")}</span> <span className="text-ink">{timeAgo(acc.lastInboundAt) || "\u2014"}</span></div>
                        <div><span className="text-ink-3">{t("channels.lastOut")}</span> <span className="text-ink">{timeAgo(acc.lastOutboundAt) || "\u2014"}</span></div>
                        <div><span className="text-ink-3">{t("channels.reconnects")}</span> <span className="text-ink">{acc.reconnectAttempts ?? 0}</span></div>
                      </div>
                      {acc.lastError && (
                        <div className="text-danger bg-danger/10 px-2 py-1 rounded">{acc.lastError}</div>
                      )}

                      {/* Policies */}
                      <div className="flex flex-wrap gap-3 pt-0.5">
                        {acc.dmPolicy && <div><span className="text-ink-3">{t("channels.dmLabel")}</span> <span className="text-ink">{acc.dmPolicy}</span></div>}
                        {acc.groupPolicy && <div><span className="text-ink-3">{t("channels.groupLabel")}</span> <span className="text-ink">{acc.groupPolicy}</span></div>}
                        {acc.allowFrom?.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-ink-3">{t("channels.allowLabel")}</span>
                            {acc.allowFrom.map((u: string) => (
                              <span key={u} className="px-1.5 py-0.5 rounded bg-cyan-dim text-cyan text-[10px]">{u}</span>
                            ))}
                          </div>
                        )}
                        {acc.groupAllowFrom?.length > 0 && (
                          <div className="flex items-center gap-1 flex-wrap">
                            <span className="text-ink-3">{t("channels.groupAllowLabel")}</span>
                            {acc.groupAllowFrom.map((g: string) => (
                              <span key={g} className="px-1.5 py-0.5 rounded bg-cyan-dim text-cyan text-[10px]">{g}</span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Edit form */}
                      {isEditing && editValues && (
                        <div className="mt-3 pt-3 border-t border-edge">
                          <ChannelForm
                            values={editValues}
                            onChange={setEditValues}
                            channelType={ch.type}
                            accountId={acc.accountId}
                          />
                          <div className="flex gap-2 mt-3">
                            <button
                              onClick={handleSave}
                              disabled={saving}
                              className="px-3 py-1.5 text-sm rounded bg-brand text-white hover:bg-brand-light disabled:opacity-50"
                            >
                              {saving ? t("common.saving") : t("common.save")}
                            </button>
                            <button
                              onClick={() => { setEditingAccount(null); setEditValues(null); }}
                              className="px-3 py-1.5 text-sm rounded bg-s2 border border-edge text-ink hover:bg-s3"
                            >
                              {t("common.cancel")}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <RestartDialog instanceId={inst.id} open={showRestartDialog} onClose={() => setShowRestartDialog(false)} />
    </div>
  );
}

export function Instance() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { instances, loading, refresh } = useInstances();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const tab = searchParams.get("tab") as Tab;
    if (tab && ["overview", "sessions", "config", "security", "agents", "channels", "llm", "control"].includes(tab)) {
      setActiveTab(tab);
    }
  }, [searchParams]);

  const inst = instances.find((i) => i.id === id);

  if (!inst) {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-full text-ink-3 text-sm">
          <svg className="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
          {t("instance.loadingInstance")}
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center h-full text-ink-3">
        <p className="text-lg mb-2">{t("instance.instanceNotFound")}</p>
        <Link to="/" className="text-cyan hover:underline text-sm">{t("instance.backToDashboard")}</Link>
      </div>
    );
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: t("instance.overviewTab") },
    { key: "sessions", label: `${t("instance.sessionsTab")} (${inst.sessions.length})` },
    { key: "config", label: t("instance.configTab") },
    { key: "security", label: t("instance.securityTab") },
    { key: "agents", label: `${t("instance.agentsTab")} (${inst.agents.length})` },
    { key: "channels", label: t("instance.channelsTab") },
    { key: "llm", label: t("instance.llmTab") },
    { key: "control", label: t("instance.controlTab") },
  ];

  return (
    <div className="h-full flex">
      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-3 mb-4">
          <Link to="/" className="text-ink-3 hover:text-ink"><ChevronLeft size={20} /></Link>
          <StatusDot status={inst.connection.status} />
          <h1 className="text-2xl font-bold text-ink">{inst.connection.label || inst.id}</h1>
          {inst.version && <span className="text-sm text-ink-3">v{inst.version}</span>}
          <button
            onClick={() => post(`/instances/${inst.id}/refresh`).then(refresh)}
            className="text-ink-3 hover:text-ink text-sm ml-2"
          ><RefreshCw size={16} /></button>
        </div>

        <div className="flex gap-1 mb-4 border-b border-edge pb-0">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 text-sm ${activeTab === tab.key ? "border-b-2 border-brand text-brand" : "text-ink-3 hover:text-ink"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto">
          {activeTab === "overview" && <OverviewTab inst={inst} onSwitchTab={setActiveTab} />}
          {activeTab === "sessions" && <SessionsTab inst={inst} />}
          {activeTab === "config" && <ConfigTab inst={inst} />}
          {activeTab === "security" && <SecurityTab inst={inst} />}
          {activeTab === "agents" && <AgentsTab inst={inst} initialAgentId={searchParams.get("agent") || undefined} onSwitchTab={setActiveTab} />}
          {activeTab === "channels" && <ChannelsTab inst={inst} />}
          {activeTab === "llm" && <LlmTab inst={inst} />}
          {activeTab === "control" && <ControlTab inst={inst} />}
        </div>
      </div>
    </div>
  );
}
