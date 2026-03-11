import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Search, X, LayoutGrid, List, Trash2, ShieldAlert, Store, Server } from "lucide-react";
import {
  Wrench, Megaphone, Palette, BarChart3, Users, Home,
  Cpu, ClipboardList, Zap, Headphones, TrendingUp,
  Database, MessageCircle, Building, Brain,
} from "lucide-react";
import { useInstances } from "../hooks/useInstances";
import { get } from "../lib/api";

// ─── Types ───

interface SkillCatalogEntry {
  name: string;
  description: string;
  source: "bundled" | "clawhub";
  emoji?: string;
  category: string;
  tags: string[];
  author?: string;
  downloads?: number;
  stars?: number;
  installs?: number;
  homepage?: string;
  requires?: { bins?: string[]; env?: string[]; os?: string[] };
}

interface SkillEntry {
  name: string;
  source: "bundled" | "clawhub";
  note: string;
}

interface SkillTemplate {
  id: string;
  name: string;
  name_zh: string;
  description: string;
  description_zh: string;
  icon: string;
  skills: SkillEntry[];
  builtin: number;
  sort_order: number;
}

// ─── Icon map ───

const ICON_MAP: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  wrench: Wrench,
  megaphone: Megaphone,
  palette: Palette,
  "bar-chart": BarChart3,
  users: Users,
  home: Home,
  cpu: Cpu,
  "clipboard-list": ClipboardList,
  zap: Zap,
  headphones: Headphones,
  "trending-up": TrendingUp,
  database: Database,
  "message-circle": MessageCircle,
  building: Building,
  brain: Brain,
};

function getIconComponent(name: string) {
  return ICON_MAP[name] || null;
}

// ─── SkillCard ───

function SkillCard({ skill, stats, onInstall, t }: {
  skill: SkillCatalogEntry;
  stats?: { downloads: number; stars: number; installs: number; author?: string; suspicious?: boolean };
  onInstall: () => void;
  t: (k: string) => string;
}) {
  const author = stats?.author || skill.author;
  const stars = stats?.stars ?? skill.stars ?? 0;
  const downloads = stats?.downloads ?? skill.downloads ?? 0;
  const suspicious = stats?.suspicious;
  return (
    <div className={`bg-s1 border rounded-lg p-4 hover:border-brand/30 transition-colors flex flex-col ${suspicious ? "border-red-500/40" : "border-edge"}`}>
      <div className="flex items-start justify-between mb-2">
        <span className="text-2xl">{skill.emoji || "\uD83D\uDCE6"}</span>
        <div className="flex items-center gap-1">
          {suspicious && (
            <span className="text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-500" title={t("skills.suspiciousDetail")}>&#9888; {t("skills.suspiciousWarning")}</span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded ${skill.source === "clawhub" ? "bg-amber-500/10 text-amber-500" : "text-ink-3 bg-s2"}`}>
            {skill.source === "clawhub" ? t("skills.community") : t(`skills.categories.${skill.category}`)}
          </span>
        </div>
      </div>
      <h3 className="text-sm font-medium text-ink mb-1">{skill.name}</h3>
      <p className="text-xs text-ink-3 mb-2 line-clamp-2 flex-1">{skill.description}</p>
      {skill.source === "clawhub" && (
        <div className="flex items-center gap-3 text-xs text-ink-3 mb-2">
          {author && <span title={t("skills.author")}>@{author}</span>}
          {stars > 0 && <span title={t("skills.stars")}>&#9733; {stars}</span>}
          {downloads > 0 && <span title={t("skills.downloads")}>&#8595; {downloads}</span>}
        </div>
      )}
      <button
        onClick={onInstall}
        className="w-full text-xs bg-brand/10 text-brand hover:bg-brand/20 py-1.5 rounded transition-colors mt-auto"
      >
        {t("skills.install")}
      </button>
    </div>
  );
}

// ─── SkillRow (list view) ───

function SkillRow({ skill, onInstall, t }: { skill: SkillCatalogEntry; onInstall: () => void; t: (k: string) => string }) {
  return (
    <div className="flex items-center gap-3 bg-s1 border border-edge rounded-lg px-4 py-2.5 hover:border-brand/30 transition-colors">
      <span className="text-lg shrink-0">{skill.emoji || "\uD83D\uDCE6"}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{skill.name}</span>
          <span className="text-xs text-ink-3 bg-s2 px-1.5 py-0.5 rounded">{t(`skills.categories.${skill.category}`)}</span>
        </div>
        <p className="text-xs text-ink-3 truncate">{skill.description}</p>
      </div>
      {skill.tags.length > 0 && (
        <div className="hidden md:flex gap-1 shrink-0">
          {skill.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="text-xs text-ink-3 bg-s2 px-1.5 py-0.5 rounded">{tag}</span>
          ))}
        </div>
      )}
      <button
        onClick={onInstall}
        className="text-xs bg-brand/10 text-brand hover:bg-brand/20 px-3 py-1.5 rounded transition-colors shrink-0"
      >
        {t("skills.install")}
      </button>
    </div>
  );
}

// ─── TemplateCard ───

function TemplateCard({ tpl, onInstall, t, lang }: {
  tpl: SkillTemplate;
  onInstall: () => void;
  t: (k: string) => string;
  lang: string;
}) {
  const name = lang === "zh" ? tpl.name_zh : tpl.name;
  const desc = lang === "zh" ? tpl.description_zh : tpl.description;
  const Icon = getIconComponent(tpl.icon);
  return (
    <div className="bg-s1 border border-edge rounded-lg p-4 hover:border-brand/30 transition-colors min-w-[200px]">
      <div className="flex items-center gap-2 mb-2">
        {Icon && <Icon size={18} className="text-brand" />}
        <h3 className="text-sm font-medium text-ink">{name}</h3>
      </div>
      <p className="text-xs text-ink-3 mb-2">{desc}</p>
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-3">{tpl.skills.length} {t("skills.skills")}</span>
        <button
          onClick={onInstall}
          className="text-xs bg-brand/10 text-brand hover:bg-brand/20 px-3 py-1 rounded transition-colors"
        >
          {t("skills.installAll")}
        </button>
      </div>
    </div>
  );
}

// ─── InstallDialog ───

interface InstallTarget {
  skills: { name: string; source: string }[];
}

function InstallDialog({ skills, instances, onClose, t }: {
  skills: { name: string; source: string }[];
  instances: { id: string; connection: { id: string; label?: string; status: string }; agents: { id: string; name?: string }[]; skills: { name: string; status: string }[] }[];
  onClose: () => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const [selections, setSelections] = useState<Map<string, Set<string>>>(new Map());
  const [installing, setInstalling] = useState(false);
  // per-instance progress: "pending" | "installing" | "done" | "error:msg"
  const [progress, setProgress] = useState<Map<string, string>>(new Map());
  const [doneCount, setDoneCount] = useState(0);
  // per-instance skill install details
  type SkillDetail = { name: string; status: "pending" | "installing" | "done" | "error" | "suspicious"; installed: boolean; error?: string; warnings?: string[]; stepMessage?: string; suspicious?: boolean };
  const [skillDetails, setSkillDetails] = useState<Map<string, SkillDetail[]>>(new Map());

  const connectedInstances = instances.filter((inst) => inst.connection.status === "connected");

  const skillNames = useMemo(() => new Set(skills.map((s) => s.name)), [skills]);

  // Check if all skills are already installed on an instance
  const installedMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const inst of connectedInstances) {
      const instSkillNames = new Set((inst.skills || []).filter((s) => s.status === "ready").map((s) => s.name));
      const allInstalled = Array.from(skillNames).every((name) => instSkillNames.has(name));
      m.set(inst.id, allInstalled);
    }
    return m;
  }, [connectedInstances, skillNames]);

  const toggleAgent = (instanceId: string, agentId: string) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(instanceId) || []);
      if (set.has(agentId)) set.delete(agentId);
      else set.add(agentId);
      if (set.size === 0) next.delete(instanceId);
      else next.set(instanceId, set);
      return next;
    });
  };

  const toggleAll = (instanceId: string, agents: { id: string }[]) => {
    setSelections((prev) => {
      const next = new Map(prev);
      const existing = next.get(instanceId);
      if (existing && existing.size === agents.length) {
        next.delete(instanceId);
      } else {
        next.set(instanceId, new Set(agents.map((a) => a.id)));
      }
      return next;
    });
  };

  const totalAgents = Array.from(selections.values()).reduce((sum, s) => sum + s.size, 0);
  const totalTargets = selections.size;
  const allDone = doneCount > 0 && doneCount === totalTargets;

  // Skill-level progress for checklist UI
  const completedSkills = useMemo(() => {
    let count = 0;
    for (const details of skillDetails.values()) {
      count += details.filter((s) => s.status === "done" || s.status === "error" || s.status === "suspicious").length;
    }
    return count;
  }, [skillDetails]);
  const totalSkillEntries = useMemo(() => {
    let count = 0;
    for (const details of skillDetails.values()) count += details.length;
    return count;
  }, [skillDetails]);

  const handleConfirm = async () => {
    if (totalAgents === 0) return;
    setInstalling(true);

    const entries = Array.from(selections.entries());
    const initProgress = new Map<string, string>();
    for (const [instId] of entries) initProgress.set(instId, "pending");
    setProgress(new Map(initProgress));
    setDoneCount(0);

    // Pre-populate skill checklist for all instances
    const initDetails = new Map<string, SkillDetail[]>();
    for (const [instId] of entries) {
      initDetails.set(instId, skills.map((sk) => ({
        name: sk.name,
        status: "pending" as const,
        installed: false,
      })));
    }
    setSkillDetails(initDetails);

    // Build all targets and send in a single SSE request
    const allTargets = entries.map(([instanceId, agentIds]) => ({
      instanceId,
      agentIds: Array.from(agentIds),
    }));

    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skills, targets: allTargets }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        for (const [instId] of entries) {
          setProgress((prev) => new Map(prev).set(instId, `error:${(err as any).error || "Request failed"}`));
        }
        setInstalling(false);
        return;
      }

      // Parse SSE stream
      const reader = res.body?.getReader();
      if (!reader) { setInstalling(false); return; }

      const decoder = new TextDecoder();
      let buffer = "";
      let completed = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || ""; // keep incomplete last part

        for (const part of parts) {
          let eventType = "";
          let dataStr = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            else if (line.startsWith("data: ")) dataStr = line.slice(6);
          }
          if (!eventType || !dataStr) continue;

          try {
            const data = JSON.parse(dataStr);
            const instId = data.instanceId;

            if (eventType === "step" && instId) {
              if (data.skill) {
                // Skill-level step → mark skill as "installing"
                setSkillDetails((prev) => {
                  const next = new Map(prev);
                  const list = [...(next.get(instId) || [])];
                  const idx = list.findIndex((s) => s.name === data.skill);
                  if (idx >= 0) list[idx] = { ...list[idx], status: "installing", stepMessage: data.message };
                  next.set(instId, list);
                  return next;
                });
              } else {
                // Instance-level step
                setProgress((prev) => new Map(prev).set(instId, `step:${data.message || "..."}`));
              }
            } else if (eventType === "skill" && instId) {
              setSkillDetails((prev) => {
                const next = new Map(prev);
                const list = [...(next.get(instId) || [])];
                const idx = list.findIndex((s) => s.name === data.name);
                const detail: SkillDetail = {
                  name: data.name,
                  status: data.suspicious ? "suspicious" : data.installed ? "done" : "error",
                  installed: data.installed,
                  error: data.error,
                  warnings: data.warnings,
                  suspicious: !!data.suspicious,
                };
                if (idx >= 0) list[idx] = detail; else list.push(detail);
                next.set(instId, list);
                return next;
              });
            } else if (eventType === "instance" && instId) {
              completed++;
              setDoneCount(completed);
              if (!data.ok) {
                setProgress((prev) => new Map(prev).set(instId, `error:${data.error || "Failed"}`));
              } else {
                setProgress((prev) => new Map(prev).set(instId, data.skipped ? "skipped" : "done"));
              }
            }
            // "done" event — stream finished, nothing extra to do
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err: any) {
      for (const [instId] of entries) {
        setProgress((prev) => new Map(prev).set(instId, `error:${err.message || "Network error"}`));
      }
    }

    setInstalling(false);
  };

  // Force-install a suspicious skill (user confirmed the risk)
  const handleForceInstall = async (skillName: string) => {
    // Find which instances have this skill flagged suspicious
    const targets: { instanceId: string; agentIds: string[] }[] = [];
    for (const [instId, details] of skillDetails.entries()) {
      const sd = details.find((s) => s.name === skillName && s.suspicious);
      if (sd) {
        const sel = selections.get(instId);
        if (sel) targets.push({ instanceId: instId, agentIds: Array.from(sel) });
      }
    }
    if (targets.length === 0) return;

    // Mark as installing again
    setSkillDetails((prev) => {
      const next = new Map(prev);
      for (const [instId, list] of next) {
        next.set(instId, list.map((s) =>
          s.name === skillName && s.suspicious ? { ...s, status: "installing" as const, suspicious: false, error: undefined } : s,
        ));
      }
      return next;
    });

    try {
      const res = await fetch("/api/skills/install", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [{ name: skillName, source: "clawhub" }],
          targets,
          force: true,
        }),
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            const instId = data.instanceId;
            if (!instId) continue;
            if (data.name) {
              setSkillDetails((prev) => {
                const next = new Map(prev);
                const list = [...(next.get(instId) || [])];
                const idx = list.findIndex((s) => s.name === data.name);
                const detail: SkillDetail = {
                  name: data.name,
                  status: data.installed ? "done" : "error",
                  installed: data.installed,
                  error: data.error,
                  warnings: data.warnings,
                };
                if (idx >= 0) list[idx] = detail; else list.push(detail);
                next.set(instId, list);
                return next;
              });
            }
          }
        }
      }
    } catch { /* network error — status stays as installing */ }
  };

  const getInstanceLabel = (instId: string) => {
    const inst = connectedInstances.find((i) => i.id === instId);
    return inst?.connection.label || instId;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-s1 border border-edge rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-edge">
          <h2 className="text-lg font-semibold text-ink">{t("skills.installDialog.title")}</h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Skill chips */}
        <div className="px-4 pt-3 flex flex-wrap gap-1.5">
          {skills.map((sk) => (
            <span key={sk.name} className="text-xs bg-brand/10 text-brand px-2 py-0.5 rounded">{sk.name}</span>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Skill checklist (visible during/after install) */}
          {progress.size > 0 && (
            <div className="space-y-3">
              {/* Progress bar */}
              <div className="flex items-center justify-between text-xs text-ink-2">
                <span>{t("skills.installDialog.progress", { done: completedSkills, total: totalSkillEntries })}</span>
                {allDone && <span className="text-ok">{t("skills.installDialog.allDone")}</span>}
              </div>
              <div className="h-1.5 bg-s2 rounded-full overflow-hidden">
                <div
                  className="h-full bg-brand rounded-full transition-all duration-500"
                  style={{ width: `${totalSkillEntries > 0 ? (completedSkills / totalSkillEntries) * 100 : 0}%` }}
                />
              </div>

              {/* Per-instance skill checklists */}
              {Array.from(progress.entries()).map(([instId, status]) => {
                const details = skillDetails.get(instId) || [];
                const instDone = status === "done" || status === "skipped";
                const instError = status.startsWith("error:");
                return (
                  <div key={instId} className="border border-edge rounded-lg overflow-hidden">
                    {/* Instance header */}
                    <div className="flex items-center justify-between px-3 py-2 bg-s2/30 border-b border-edge/50">
                      <span className="text-sm font-medium text-ink">{getInstanceLabel(instId)}</span>
                      {instDone && <span className="text-xs text-ok">{t("skills.installDialog.done")}</span>}
                      {instError && <span className="text-xs text-danger">{status.slice(6)}</span>}
                      {status === "pending" && <span className="text-xs text-ink-3">{t("skills.installDialog.pending")}</span>}
                      {!instDone && !instError && status !== "pending" && status.startsWith("step:") && (
                        <span className="text-xs text-ink-3">{status.slice(5)}</span>
                      )}
                    </div>

                    {/* Skill checklist */}
                    <div className="px-3 py-1">
                      {details.map((sd) => (
                        <div key={sd.name} className="py-1.5">
                          <div className="flex items-center gap-2 min-h-[20px]">
                            {/* Status icon */}
                            {sd.status === "pending" && (
                              <span className="w-4 h-4 flex items-center justify-center text-ink-3 text-xs shrink-0">&#9675;</span>
                            )}
                            {sd.status === "installing" && (
                              <span className="w-4 h-4 flex items-center justify-center shrink-0">
                                <span className="w-3 h-3 border-2 border-brand/30 border-t-brand rounded-full animate-spin" />
                              </span>
                            )}
                            {sd.status === "done" && (
                              <span className="w-4 h-4 flex items-center justify-center text-ok shrink-0">&#10003;</span>
                            )}
                            {sd.status === "error" && (
                              <span className="w-4 h-4 flex items-center justify-center text-danger shrink-0">&#10007;</span>
                            )}
                            {sd.status === "suspicious" && (
                              <span className="w-4 h-4 flex items-center justify-center text-amber-500 shrink-0">&#9888;</span>
                            )}

                            {/* Skill name */}
                            <span className={`text-sm ${sd.status === "pending" ? "text-ink-3" : "text-ink"}`}>
                              {sd.name}
                            </span>

                            {/* Status detail (right-aligned) */}
                            {sd.status === "installing" && sd.stepMessage && (
                              <span className="ml-auto text-xs text-brand truncate max-w-[220px]">{sd.stepMessage}</span>
                            )}
                            {sd.status === "done" && sd.warnings && sd.warnings.length > 0 && (
                              <span className="ml-auto text-xs text-ink-3 truncate max-w-[220px]">{sd.warnings[0]}</span>
                            )}
                            {sd.status === "error" && sd.error && (
                              <span className="ml-auto text-xs text-danger truncate max-w-[220px]">{sd.error}</span>
                            )}
                            {sd.status === "suspicious" && (
                              <span className="ml-auto text-xs text-amber-500 truncate max-w-[220px]">{t("skills.suspiciousWarning")}</span>
                            )}
                          </div>
                          {/* Suspicious: show risk warning + confirm button */}
                          {sd.status === "suspicious" && (
                            <div className="pl-6 mt-1">
                              <p className="text-xs text-amber-500 mb-1.5">{t("skills.suspiciousDetail")}</p>
                              <button
                                onClick={() => handleForceInstall(sd.name)}
                                className="text-xs bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 px-3 py-1 rounded transition-colors"
                              >
                                {t("skills.forceInstall")}
                              </button>
                            </div>
                          )}
                          {/* Warning details for errors */}
                          {sd.status === "error" && sd.warnings && sd.warnings.length > 0 && (
                            <p className="text-xs text-amber-500 pl-6 mt-0.5 break-words">{sd.warnings[0]}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Selection UI (hidden during install) */}
          {progress.size === 0 && (
            <>
              <p className="text-sm text-ink-2">{t("skills.installDialog.selectAgents")}</p>

              {connectedInstances.length === 0 ? (
                <p className="text-sm text-ink-3">{t("skills.installDialog.noInstances")}</p>
              ) : (
                connectedInstances.map((inst) => {
                  const allInstalled = installedMap.get(inst.id);
                  return (
                    <div key={inst.id} className="border border-edge rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-ink">{inst.connection.label || inst.id}</span>
                          {allInstalled && (
                            <span className="text-xs bg-ok/10 text-ok px-1.5 py-0.5 rounded">{t("skills.installDialog.installed")}</span>
                          )}
                        </div>
                        <button
                          onClick={() => toggleAll(inst.id, inst.agents)}
                          className="text-xs text-brand hover:text-brand-light transition-colors"
                        >
                          {t("skills.installDialog.selectAll")}
                        </button>
                      </div>
                      <div className="space-y-1.5">
                        {inst.agents.map((agent) => {
                          const checked = selections.get(inst.id)?.has(agent.id) || false;
                          return (
                            <label key={agent.id} className="flex items-center gap-2 text-sm text-ink-2 cursor-pointer hover:text-ink transition-colors">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleAgent(inst.id, agent.id)}
                                className="accent-brand"
                              />
                              {agent.name || agent.id}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-edge flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-ink-2 hover:text-ink transition-colors">
            {allDone ? t("common.close") : t("common.cancel")}
          </button>
          {!allDone && (
            <button
              onClick={handleConfirm}
              disabled={totalAgents === 0 || installing}
              className="px-4 py-2 bg-brand hover:bg-brand-light rounded-lg text-sm text-white font-medium disabled:opacity-50 transition-colors"
            >
              {installing
                ? t("skills.installDialog.installing")
                : t("skills.installDialog.confirm", { count: totalAgents })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Installed Skills View ───

function InstalledSkillsView({ instances, catalog, t }: {
  instances: { id: string; connection: { id: string; label?: string; status: string }; agents: { id: string; name?: string }[]; skills: { name: string; status: string; description?: string }[] }[];
  catalog: SkillCatalogEntry[];
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [suspiciousSkills, setSuspiciousSkills] = useState<Set<string>>(new Set());

  const connected = instances.filter((inst) => inst.connection.status === "connected");
  const bundledNames = useMemo(() => new Set(catalog.map((c) => c.name)), [catalog]);

  // Collect all unique clawhub skill names across all instances to check suspicious status
  const clawhubSkillNames = useMemo(() => {
    const names = new Set<string>();
    for (const inst of connected) {
      for (const sk of inst.skills || []) {
        if (sk.status !== "missing" && !bundledNames.has(sk.name)) names.add(sk.name);
      }
    }
    return names;
  }, [connected, bundledNames]);

  // Fetch suspicious status for clawhub skills
  useEffect(() => {
    if (clawhubSkillNames.size === 0) return;
    let cancelled = false;
    const slugs = Array.from(clawhubSkillNames).slice(0, 30);
    get<{ details: Record<string, { suspicious?: boolean }> }>(
      `/skills/clawhub/details?slugs=${encodeURIComponent(slugs.join(","))}`,
    ).then((res) => {
      if (cancelled || !res.details) return;
      const sus = new Set<string>();
      for (const [slug, d] of Object.entries(res.details)) {
        if (d.suspicious) sus.add(slug);
      }
      setSuspiciousSkills(sus);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [clawhubSkillNames]);

  const handleUninstall = async (instanceId: string, skillName: string, agentIds: string[]) => {
    setUninstalling(`${instanceId}:${skillName}`);
    try {
      await fetch("/api/skills/uninstall", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [skillName],
          targets: [{ instanceId, agentIds }],
        }),
      });
    } catch { /* ignore */ }
    setUninstalling(null);
  };

  if (connected.length === 0) {
    return <div className="text-sm text-ink-3 py-8 text-center">{t("skills.noInstances")}</div>;
  }

  return (
    <div className="space-y-4">
      {connected.map((inst) => {
        const instSkills = (inst.skills || []).filter(sk => sk.status !== "missing");
        const agentIds = inst.agents.map((a) => a.id);
        return (
          <div key={inst.id} className="border border-edge rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 bg-s2/50 border-b border-edge">
              <span className="text-sm font-medium text-ink">{inst.connection.label || inst.id}</span>
              <span className="text-xs text-ink-3">{t("skills.skillCount", { count: instSkills.length })}</span>
            </div>
            {instSkills.length === 0 ? (
              <div className="px-4 py-4 text-sm text-ink-3">{t("skills.noSkillsInstalled")}</div>
            ) : (
              <div className="divide-y divide-edge">
                {instSkills.map((sk) => {
                  const isClawhub = !bundledNames.has(sk.name);
                  const isSuspicious = suspiciousSkills.has(sk.name);
                  const isUninstalling = uninstalling === `${inst.id}:${sk.name}`;
                  return (
                    <div key={sk.name} className="flex items-center gap-3 px-4 py-2.5">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${sk.status === "ready" ? "bg-ok" : sk.status === "disabled" ? "bg-ink-3" : "bg-amber-500"}`} />
                      <span className="text-sm text-ink flex-1">{sk.name}</span>
                      {isClawhub && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 whitespace-nowrap">{t("skills.community")}</span>
                      )}
                      {isSuspicious && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 flex items-center gap-1 whitespace-nowrap">
                          <ShieldAlert size={12} />
                          {t("skills.suspiciousWarning")}
                        </span>
                      )}
                      <button
                        onClick={() => handleUninstall(inst.id, sk.name, agentIds)}
                        disabled={isUninstalling}
                        className="text-ink-3 hover:text-danger transition-colors disabled:opacity-50"
                        title={t("skills.uninstall")}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Skills Page ───

export function Skills() {
  const { t, i18n } = useTranslation();
  const { instances } = useInstances();
  const [pageTab, setPageTab] = useState<"market" | "installed">("market");
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [templates, setTemplates] = useState<SkillTemplate[]>([]);
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [showAllTemplates, setShowAllTemplates] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [installTarget, setInstallTarget] = useState<InstallTarget | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  // ClawHub marketplace search + pagination + stats
  const [clawhubResults, setClawhubResults] = useState<SkillCatalogEntry[]>([]);
  const [searchingHub, setSearchingHub] = useState(false);
  const [clawhubHasMore, setClawhubHasMore] = useState(false);
  const [clawhubLoadingMore, setClawhubLoadingMore] = useState(false);
  const [clawhubStats, setClawhubStats] = useState<Record<string, { downloads: number; stars: number; installs: number; author?: string; suspicious?: boolean }>>({});

  const fetchData = useCallback(() => {
    setLoadingCatalog(true);
    Promise.all([
      get<{ bundled: SkillCatalogEntry[]; tags: string[]; categories: string[] }>("/skills"),
      get<{ templates: SkillTemplate[] }>("/skills/templates"),
    ])
      .then(([catalogRes, templatesRes]) => {
        setCatalog(catalogRes.bundled);
        setCategories(catalogRes.categories as unknown as string[]);
        setTemplates(templatesRes.templates);
      })
      .catch(() => {})
      .finally(() => setLoadingCatalog(false));
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Debounced ClawHub marketplace search
  useEffect(() => {
    if (!search.trim() || search.trim().length < 2) {
      setClawhubResults([]);
      setClawhubHasMore(false);
      return;
    }
    setSearchingHub(true);
    const timer = setTimeout(async () => {
      try {
        const res = await get<{ results: SkillCatalogEntry[]; clawhub: SkillCatalogEntry[]; hasMore?: boolean }>(
          `/skills/search?q=${encodeURIComponent(search.trim())}`,
        );
        setClawhubResults(res.clawhub || []);
        setClawhubHasMore(!!res.hasMore);
      } catch {
        setClawhubResults([]);
        setClawhubHasMore(false);
      }
      setSearchingHub(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  // Load more ClawHub results
  const loadMoreClawHub = useCallback(async () => {
    if (clawhubLoadingMore || !clawhubHasMore || !search.trim()) return;
    setClawhubLoadingMore(true);
    try {
      const res = await get<{ clawhub: SkillCatalogEntry[]; hasMore?: boolean }>(
        `/skills/search?q=${encodeURIComponent(search.trim())}&offset=${clawhubResults.length}`,
      );
      const more = res.clawhub || [];
      if (more.length > 0) {
        setClawhubResults((prev) => [...prev, ...more]);
      }
      setClawhubHasMore(!!res.hasMore);
    } catch {
      setClawhubHasMore(false);
    }
    setClawhubLoadingMore(false);
  }, [search, clawhubResults.length, clawhubHasMore, clawhubLoadingMore]);

  // Async fetch ClawHub stats for visible results (phase 2)
  useEffect(() => {
    const needStats = clawhubResults.filter((r) => !clawhubStats[r.name]).map((r) => r.name);
    if (needStats.length === 0) return;
    let cancelled = false;
    get<{ details: Record<string, { downloads: number; stars: number; installs: number; author?: string }> }>(
      `/skills/clawhub/details?slugs=${encodeURIComponent(needStats.join(","))}`,
    ).then((res) => {
      if (!cancelled && res.details) {
        setClawhubStats((prev) => ({ ...prev, ...res.details }));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [clawhubResults]); // eslint-disable-line react-hooks/exhaustive-deps

  // Client-side filtering
  const filtered = useMemo(() => {
    const lowerSearch = search.toLowerCase();
    return catalog.filter((skill) => {
      if (selectedCategory && skill.category !== selectedCategory) return false;
      if (lowerSearch) {
        const inName = skill.name.toLowerCase().includes(lowerSearch);
        const inDesc = skill.description.toLowerCase().includes(lowerSearch);
        const inTags = skill.tags.some((tag) => tag.toLowerCase().includes(lowerSearch));
        if (!inName && !inDesc && !inTags) return false;
      }
      return true;
    });
  }, [catalog, search, selectedCategory]);

  const visibleTemplates = showAllTemplates ? templates : templates.slice(0, 4);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">{t("skills.title")}</h1>
        <button
          onClick={fetchData}
          className="flex items-center gap-2 text-sm text-ink-2 hover:text-ink transition-colors"
        >
          <RefreshCw size={16} />
          {t("common.refresh")}
        </button>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-5 border-b border-edge">
        <button
          onClick={() => setPageTab("market")}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 transition-colors ${pageTab === "market" ? "border-brand text-brand" : "border-transparent text-ink-3 hover:text-ink"}`}
        >
          <Store size={15} />
          {t("skills.tabMarket")}
        </button>
        <button
          onClick={() => setPageTab("installed")}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 transition-colors ${pageTab === "installed" ? "border-brand text-brand" : "border-transparent text-ink-3 hover:text-ink"}`}
        >
          <Server size={15} />
          {t("skills.tabInstalled")}
        </button>
      </div>

      {pageTab === "market" && (<>
      {/* Search + Category dropdown */}
      <div className="flex gap-3 mb-6">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("skills.searchPlaceholder")}
            className="w-full bg-s1 border border-edge rounded-lg pl-9 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-3 focus:border-brand transition-colors"
          />
        </div>
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          className="bg-s1 border border-edge rounded-lg px-3 py-2.5 text-sm text-ink"
        >
          <option value="">{t("skills.allCategories")}</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {t(`skills.categories.${cat}`)}
            </option>
          ))}
        </select>
      </div>

      {loadingCatalog ? (
        <div className="text-sm text-ink-3">{t("common.loading")}</div>
      ) : (
        <>
          {/* Scene Templates */}
          {templates.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-ink">{t("skills.sceneTemplates")}</h2>
                {templates.length > 4 && (
                  <button
                    onClick={() => setShowAllTemplates(!showAllTemplates)}
                    className="text-xs text-brand hover:text-brand-light transition-colors"
                  >
                    {showAllTemplates ? t("skills.showLess") : t("skills.showAll")}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {visibleTemplates.map((tpl) => (
                  <TemplateCard
                    key={tpl.id}
                    tpl={tpl}
                    onInstall={() =>
                      setInstallTarget({
                        skills: tpl.skills.map((s) => ({ name: s.name, source: s.source })),
                      })
                    }
                    t={t}
                    lang={i18n.language}
                  />
                ))}
              </div>
            </div>
          )}

          {/* All Skills */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-ink">
                {t("skills.allSkills")} ({filtered.length})
              </h2>
              <div className="flex items-center gap-3">
                {/* Category pills */}
                <div className="flex gap-1.5 overflow-x-auto">
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setSelectedCategory(selectedCategory === cat ? "" : cat)}
                      className={`px-2.5 py-0.5 text-xs rounded-full whitespace-nowrap transition-colors ${selectedCategory === cat ? "bg-brand text-white" : "bg-s2 text-ink-3 hover:text-ink"}`}
                    >
                      {t(`skills.categories.${cat}`)}
                    </button>
                  ))}
                </div>
                {/* View toggle */}
                <div className="flex bg-s1 border border-edge rounded-lg overflow-hidden shrink-0">
                  <button
                    onClick={() => setViewMode("grid")}
                    className={`px-2 py-1 transition-colors ${viewMode === "grid" ? "bg-brand/10 text-brand" : "text-ink-3 hover:text-ink"}`}
                    title={t("skills.gridView")}
                  >
                    <LayoutGrid size={14} />
                  </button>
                  <button
                    onClick={() => setViewMode("list")}
                    className={`px-2 py-1 transition-colors ${viewMode === "list" ? "bg-brand/10 text-brand" : "text-ink-3 hover:text-ink"}`}
                    title={t("skills.listView")}
                  >
                    <List size={14} />
                  </button>
                </div>
              </div>
            </div>
            {filtered.length === 0 ? (
              <div className="text-sm text-ink-3 py-8 text-center">{t("skills.noResults")}</div>
            ) : viewMode === "grid" ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {filtered.map((skill) => (
                  <SkillCard
                    key={skill.name}
                    skill={skill}
                    onInstall={() =>
                      setInstallTarget({
                        skills: [{ name: skill.name, source: skill.source }],
                      })
                    }
                    t={t}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {filtered.map((skill) => (
                  <SkillRow
                    key={skill.name}
                    skill={skill}
                    onInstall={() =>
                      setInstallTarget({
                        skills: [{ name: skill.name, source: skill.source }],
                      })
                    }
                    t={t}
                  />
                ))}
              </div>
            )}
          </div>

          {/* ClawHub marketplace results (shown when searching) */}
          {search.trim().length >= 2 && (
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-lg font-semibold text-ink">{t("skills.clawhubMarket")}</h2>
                <span className="text-xs bg-amber-500/10 text-amber-500 px-2 py-0.5 rounded">{t("skills.community")}</span>
              </div>
              <p className="text-xs text-amber-500/80 mb-3">{t("skills.clawhubWarning")}</p>
              {searchingHub ? (
                <div className="text-sm text-ink-3 py-4">{t("common.loading")}</div>
              ) : clawhubResults.length === 0 ? (
                <div className="text-sm text-ink-3 py-4 text-center">{t("skills.noResults")}</div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                    {clawhubResults.map((skill) => (
                      <SkillCard
                        key={skill.name}
                        skill={skill}
                        stats={clawhubStats[skill.name]}
                        onInstall={() =>
                          setInstallTarget({
                            skills: [{ name: skill.name, source: skill.source }],
                          })
                        }
                        t={t}
                      />
                    ))}
                  </div>
                  {clawhubHasMore && (
                    <div className="flex justify-center mt-4">
                      <button
                        onClick={loadMoreClawHub}
                        disabled={clawhubLoadingMore}
                        className="px-4 py-2 text-sm rounded-lg border border-surface-2 text-ink-2 hover:bg-surface-2 transition-colors disabled:opacity-50"
                      >
                        {clawhubLoadingMore ? t("common.loading") : t("common.loadMore")}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
      </>)}

      {/* Installed skills tab */}
      {pageTab === "installed" && (
        <InstalledSkillsView instances={instances} catalog={catalog} t={t} />
      )}

      {/* Install dialog */}
      {installTarget && (
        <InstallDialog
          skills={installTarget.skills}
          instances={instances}
          onClose={() => setInstallTarget(null)}
          t={t}
        />
      )}
    </div>
  );
}
