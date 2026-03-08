import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useInstances } from "../hooks/useInstances";
import { get, post, del } from "../lib/api";
import { Shield, Search, Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "../components/ConfirmDialog";

function PolicyBadge({ value }: { value: string }) {
  const cls = value === "open" ? "bg-danger-dim text-danger"
    : value === "pairing" ? "bg-warn-dim text-warn"
    : value === "allowlist" ? "bg-ok-dim text-ok"
    : value === "true" ? "bg-ok-dim text-ok"
    : value === "false" ? "bg-s2 text-ink-3"
    : "bg-s2 text-ink";
  return <span className={`px-2 py-0.5 rounded text-xs ${cls}`}>{value}</span>;
}

function InjectionScanner() {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{risk: string; category?: string; detail?: string} | null>(null);
  const [scanning, setScanning] = useState(false);

  const scan = async () => {
    if (!message.trim()) return;
    setScanning(true);
    try {
      const r = await post<any>("/instances/scan-message", { message });
      setResult(r);
    } catch (e: any) {
      setResult({ risk: "error", detail: e.message });
    } finally { setScanning(false); }
  };

  return (
    <div className="p-4 space-y-3">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={t("security.scanPlaceholder")}
        className="w-full h-24 p-3 bg-s2 border border-edge rounded text-sm text-ink font-mono placeholder:text-ink-3 resize-none focus:outline-none focus:border-cyan"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={scan}
          disabled={!message.trim() || scanning}
          className="flex items-center gap-1.5 px-4 py-2 text-sm rounded bg-brand text-white hover:bg-brand-light disabled:opacity-40"
        >
          <Search size={14} /> {scanning ? t("security.scanning") : t("security.scan")}
        </button>
        {result && (
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm ${
            result.risk === "high" ? "bg-danger-dim text-danger" :
            result.risk === "medium" ? "bg-warn-dim text-warn" :
            result.risk === "error" ? "bg-danger-dim text-danger" :
            "bg-ok-dim text-ok"
          }`}>
            <span className="font-semibold uppercase">{result.risk}</span>
            {result.category && <span>— {result.category}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

function TemplateManager() {
  const { t } = useTranslation();
  const { instances } = useInstances();
  const navigate = useNavigate();
  const connectedInstances = instances.filter((i: any) => i.connection.status === "connected");

  const [templates, setTemplates] = useState<any[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newConfig, setNewConfig] = useState('{"toolsAllow":["read","search"],"execSecurity":"allowlist","workspaceOnly":true}');
  const [confirmDeleteTemplate, setConfirmDeleteTemplate] = useState<{ id: string; name: string } | null>(null);

  const refresh = () => get<any[]>("/instances/templates").then(setTemplates).catch(() => {});
  useEffect(() => { refresh(); }, []);

  const createTemplate = async () => {
    if (!newId || !newName) return;
    try {
      const config = JSON.parse(newConfig);
      await post("/instances/templates", { id: newId, name: newName, description: newDesc, config });
      setShowAdd(false);
      setNewId(""); setNewName(""); setNewDesc("");
      refresh();
    } catch {}
  };

  return (
    <div>
      <div className="divide-y divide-edge">
        {templates.map((tpl) => (
          <div key={tpl.id} className="flex items-center gap-3 px-4 py-3">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink">{tpl.name}</span>
                {tpl.preset && <span className="px-1.5 py-0.5 text-xs rounded bg-cyan-dim text-cyan">{t("security.preset")}</span>}
                <span className="font-mono text-xs text-ink-3">{tpl.id}</span>
              </div>
              <p className="text-xs text-ink-3 mt-0.5">{tpl.description}</p>
              <div className="flex gap-2 mt-1">
                <span className="text-xs text-ink-2">{t("security.toolsLabel")} {tpl.config.toolsAllow.join(", ")}</span>
                <span className="text-xs text-ink-3">|</span>
                <span className="text-xs text-ink-2">{t("security.execLabel")} {tpl.config.execSecurity}</span>
                <span className="text-xs text-ink-3">|</span>
                <span className="text-xs text-ink-2">{t("security.workspaceLabel")} {tpl.config.workspaceOnly ? "yes" : "no"}</span>
              </div>
            </div>
            {!tpl.preset && (
              <button onClick={() => setConfirmDeleteTemplate({ id: tpl.id, name: tpl.name })} className="text-ink-3 hover:text-danger">
                <Trash2 size={14} />
              </button>
            )}
            {connectedInstances.length > 0 && (
              <select
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    navigate(`/instance/${e.target.value}?tab=agents&applyTemplate=${tpl.id}`);
                  }
                }}
                className="px-2 py-1 text-xs bg-s2 border border-edge rounded text-ink cursor-pointer"
              >
                <option value="" disabled>{t("security.applyTo")}</option>
                {connectedInstances.map((inst: any) => (
                  <option key={inst.id} value={inst.id}>{inst.connection.label || inst.id}</option>
                ))}
              </select>
            )}
          </div>
        ))}
      </div>

      {!showAdd ? (
        <div className="p-4 border-t border-edge">
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-1.5 text-sm text-brand hover:text-brand-light">
            <Plus size={14} /> {t("security.addCustomTemplate")}
          </button>
        </div>
      ) : (
        <div className="p-4 border-t border-edge space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input value={newId} onChange={(e) => setNewId(e.target.value)} placeholder={t("security.templateIdPlaceholder")} className="px-2 py-1.5 text-sm bg-s2 border border-edge rounded text-ink placeholder:text-ink-3" />
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("security.displayNamePlaceholder")} className="px-2 py-1.5 text-sm bg-s2 border border-edge rounded text-ink placeholder:text-ink-3" />
          </div>
          <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder={t("security.descriptionPlaceholder")} className="w-full px-2 py-1.5 text-sm bg-s2 border border-edge rounded text-ink placeholder:text-ink-3" />
          <textarea value={newConfig} onChange={(e) => setNewConfig(e.target.value)} className="w-full h-16 px-2 py-1.5 text-sm font-mono bg-s2 border border-edge rounded text-ink resize-none" />
          <div className="flex gap-2">
            <button onClick={createTemplate} className="px-3 py-1.5 text-sm rounded bg-brand text-white hover:bg-brand-light">{t("common.create")}</button>
            <button onClick={() => setShowAdd(false)} className="px-3 py-1.5 text-sm text-ink-3 hover:text-ink">{t("common.cancel")}</button>
          </div>
        </div>
      )}
      {confirmDeleteTemplate && (
        <ConfirmDialog
          title={t("security.deleteTemplate")}
          message={t("security.deleteTemplateConfirm", { name: confirmDeleteTemplate.name })}
          onConfirm={async () => {
            try { await del(`/instances/templates/${confirmDeleteTemplate.id}`); refresh(); } catch {}
            setConfirmDeleteTemplate(null);
          }}
          onCancel={() => setConfirmDeleteTemplate(null)}
        />
      )}
    </div>
  );
}

export function Security() {
  const { t } = useTranslation();
  const { instances } = useInstances();

  const connectedInstances = instances.filter((i) => i.connection.status === "connected");

  const allIssues = connectedInstances.flatMap((inst) =>
    (inst.securityAudit || []).map((item) => ({
      ...item,
      instanceId: inst.id,
      instanceLabel: inst.connection.label || inst.id,
    }))
  );

  const critical = allIssues.filter((i) => i.level === "critical");
  const warnings = allIssues.filter((i) => i.level === "warn");
  const info = allIssues.filter((i) => i.level === "info");

  const agentPerms = connectedInstances.flatMap((inst) =>
    inst.agents.map((a) => ({
      instance: inst.connection.label || inst.id,
      agent: a.id,
      tools: a.toolsAllow || [],
      isDefault: a.isDefault,
      execSecurity: a.execSecurity,
    }))
  );

  const channelPolicies: { instance: string; channel: string; account: string; key: string; value: string }[] = [];
  for (const inst of connectedInstances) {
    const config = (inst.config as any)?.parsed || inst.config as any;
    const channels = config?.channels || {};
    const label = inst.connection.label || inst.id;
    for (const [chType, chConf] of Object.entries(channels) as [string, any][]) {
      if (chConf.dmPolicy) channelPolicies.push({ instance: label, channel: chType, account: "(top)", key: "dmPolicy", value: chConf.dmPolicy });
      if (chConf.groupPolicy) channelPolicies.push({ instance: label, channel: chType, account: "(top)", key: "groupPolicy", value: chConf.groupPolicy });
      const accounts = chConf.accounts || {};
      for (const [accId, accConf] of Object.entries(accounts) as [string, any][]) {
        if (!accConf.enabled && accConf.enabled !== undefined) continue;
        if (accConf.dmPolicy) channelPolicies.push({ instance: label, channel: chType, account: accId, key: "dmPolicy", value: accConf.dmPolicy });
        if (accConf.groupPolicy) channelPolicies.push({ instance: label, channel: chType, account: accId, key: "groupPolicy", value: accConf.groupPolicy });
        if (accConf.groupAllowFrom) channelPolicies.push({ instance: label, channel: chType, account: accId, key: "groupAllowFrom", value: `${accConf.groupAllowFrom.length} group(s)` });
        if (accConf.allowFrom) channelPolicies.push({ instance: label, channel: chType, account: accId, key: "allowFrom", value: accConf.allowFrom.includes("*") ? "* (all)" : `${accConf.allowFrom.length} user(s)` });
        if (accConf.requireMemberOpenIds?.length) channelPolicies.push({ instance: label, channel: chType, account: accId, key: "requireMembers", value: `${accConf.requireMemberOpenIds.length} ID(s)` });
      }
    }
  }

  const allBindings = connectedInstances.flatMap((inst) => {
    const config = (inst.config as any)?.parsed || inst.config as any;
    return (config?.bindings || []).map((b: any) => ({
      instance: inst.connection.label || inst.id,
      ...b,
    }));
  });

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">{t("security.title")}</h1>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-danger-dim border border-danger/30 rounded-card p-4 shadow-card">
          <p className="text-sm text-danger">{t("security.critical")}</p>
          <p className="text-2xl font-bold text-danger">{critical.length}</p>
        </div>
        <div className="bg-warn-dim border border-warn/30 rounded-card p-4 shadow-card">
          <p className="text-sm text-warn">{t("security.warnings")}</p>
          <p className="text-2xl font-bold text-warn">{warnings.length}</p>
        </div>
        <div className="bg-cyan-dim border border-cyan/30 rounded-card p-4 shadow-card">
          <p className="text-sm text-cyan">{t("security.info")}</p>
          <p className="text-2xl font-bold text-cyan">{info.length}</p>
        </div>
      </div>

      {allIssues.length > 0 ? (
        <div className="bg-s1 border border-edge rounded-card shadow-card mb-6">
          <h2 className="text-lg font-semibold p-4 border-b border-edge">{t("security.auditItems")}</h2>
          <div className="divide-y divide-edge">
            {allIssues.map((item, i) => (
              <div key={i} className="p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    item.level === "critical" ? "bg-danger-dim text-danger" :
                    item.level === "warn" ? "bg-warn-dim text-warn" :
                    "bg-cyan-dim text-cyan"
                  }`}>{item.level.toUpperCase()}</span>
                  <span className="text-sm font-medium">{item.title}</span>
                  <span className="text-xs text-ink-3 ml-auto">{item.instanceLabel}</span>
                </div>
                <p className="text-sm text-ink-2">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-ok-dim border border-ok/30 rounded-card p-6 text-center text-ok text-sm mb-6 shadow-card">
          {t("security.noAuditIssues")}
        </div>
      )}

      {channelPolicies.length > 0 && (
        <div className="bg-s1 border border-edge rounded-card overflow-hidden mb-6 shadow-card">
          <h2 className="text-lg font-semibold p-4 border-b border-edge">{t("security.channelPolicies")}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-ink-3">
                <th className="text-left p-3">{t("security.instanceHeader")}</th>
                <th className="text-left p-3">{t("security.channelHeader")}</th>
                <th className="text-left p-3">{t("security.accountHeader")}</th>
                <th className="text-left p-3">{t("security.policyHeader")}</th>
                <th className="text-left p-3">{t("security.valueHeader")}</th>
              </tr>
            </thead>
            <tbody>
              {channelPolicies.map((p, i) => (
                <tr key={i} className="border-b border-edge/50 hover:bg-s1/50">
                  <td className="p-3">{p.instance}</td>
                  <td className="p-3">{p.channel}</td>
                  <td className="p-3">{p.account}</td>
                  <td className="p-3 font-mono text-xs">{p.key}</td>
                  <td className="p-3"><PolicyBadge value={p.value} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {allBindings.length > 0 && (
        <div className="bg-s1 border border-edge rounded-card overflow-hidden mb-6 shadow-card">
          <h2 className="text-lg font-semibold p-4 border-b border-edge">{t("security.agentBindings")}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-ink-3">
                <th className="text-left p-3">{t("security.instanceHeader")}</th>
                <th className="text-left p-3">{t("security.agentHeader")}</th>
                <th className="text-left p-3">{t("security.channelHeader")}</th>
                <th className="text-left p-3">{t("security.accountHeader")}</th>
                <th className="text-left p-3">{t("security.matchHeader")}</th>
              </tr>
            </thead>
            <tbody>
              {allBindings.map((b: any, i: number) => (
                <tr key={i} className="border-b border-edge/50 hover:bg-s1/50">
                  <td className="p-3">{b.instance}</td>
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

      <div className="bg-s1 border border-edge rounded-card overflow-hidden shadow-card mb-6">
        <h2 className="text-lg font-semibold p-4 border-b border-edge">{t("security.agentPermissions")}</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-edge text-ink-3">
              <th className="text-left p-3">{t("security.instanceHeader")}</th>
              <th className="text-left p-3">{t("security.agentHeader")}</th>
              <th className="text-left p-3">{t("security.allowedTools")}</th>
              <th className="text-left p-3">{t("security.execSecurity")}</th>
              <th className="text-left p-3">{t("security.riskHeader")}</th>
            </tr>
          </thead>
          <tbody>
            {agentPerms.map((row, i) => {
              const exec = row.execSecurity;
              const hasAll = row.tools.includes("*") || row.tools.length === 0;
              const hasExec = hasAll || row.tools.some((tl) => ["exec", "shell", "bash"].includes(tl));
              const isFullExec = hasExec && (!exec || exec.security === "full");
              const risk = isFullExec ? "high" : hasExec ? "medium" : row.tools.length > 10 ? "medium" : "low";
              return (
                <tr key={i} className="border-b border-edge/50 hover:bg-s1/50">
                  <td className="p-3">{row.instance}</td>
                  <td className="p-3">{row.agent}{row.isDefault ? " (default)" : ""}</td>
                  <td className="p-3">{row.tools.length === 0 || (row.tools.length === 1 && row.tools[0] === "*") ? <span className="px-2 py-0.5 rounded text-xs bg-danger-dim text-danger">all</span> : row.tools.join(", ")}</td>
                  <td className="p-3">
                    {exec ? (
                      <div className="space-y-0.5">
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          exec.security === "allowlist" ? "bg-ok-dim text-ok" :
                          exec.security === "full" ? "bg-danger-dim text-danger" : "bg-s2 text-ink"
                        }`}>{exec.security || "\u2014"}</span>
                        {exec.workspaceOnly && <span className="ml-1 px-1.5 py-0.5 rounded text-xs bg-cyan-dim text-cyan">workspace-only</span>}
                      </div>
                    ) : <span className="text-ink-3">{"\u2014"}</span>}
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${
                      risk === "high" ? "bg-danger-dim text-danger" :
                      risk === "medium" ? "bg-warn-dim text-warn" :
                      "bg-ok-dim text-ok"
                    }`}>{risk}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Injection Scanner */}
      <div className="bg-s1 border border-edge rounded-card shadow-card mb-6">
        <h2 className="text-lg font-semibold p-4 border-b border-edge flex items-center gap-2">
          <Shield size={18} /> {t("security.injectionScanner")}
        </h2>
        <InjectionScanner />
      </div>

      {/* Permission Templates */}
      <div className="bg-s1 border border-edge rounded-card shadow-card">
        <h2 className="text-lg font-semibold p-4 border-b border-edge">{t("security.permissionTemplates")}</h2>
        <TemplateManager />
      </div>
    </div>
  );
}
