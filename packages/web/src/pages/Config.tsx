import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, X as XIcon, Minus, GitCompare } from "lucide-react";
import { useInstances } from "../hooks/useInstances";

type DiffEntry = { path: string; valueA: unknown; valueB: unknown; type: "changed" | "added" | "removed" | "same" };

function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        Object.assign(result, flatten(v, path));
      } else {
        result[path] = v;
      }
    }
  } else if (prefix) {
    result[prefix] = obj;
  }
  return result;
}

function formatValue(v: unknown): string {
  if (v === undefined) return "\u2014";
  if (typeof v === "string") return `"${v}"`;
  return JSON.stringify(v);
}

function diffConfigs(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): DiffEntry[] {
  const flatA = flatten(a || {});
  const flatB = flatten(b || {});
  const allKeys = [...new Set([...Object.keys(flatA), ...Object.keys(flatB)])].sort();
  return allKeys.map((path) => {
    const inA = path in flatA;
    const inB = path in flatB;
    const vA = flatA[path];
    const vB = flatB[path];
    if (!inA) return { path, valueA: undefined, valueB: vB, type: "added" as const };
    if (!inB) return { path, valueA: vA, valueB: undefined, type: "removed" as const };
    if (JSON.stringify(vA) !== JSON.stringify(vB)) return { path, valueA: vA, valueB: vB, type: "changed" as const };
    return { path, valueA: vA, valueB: vB, type: "same" as const };
  });
}

function DiffModal({ instA, instB, diff, onClose }: {
  instA: { label: string };
  instB: { label: string };
  diff: DiffEntry[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const diffOnly = diff.filter((d) => d.type !== "same");
  const displayDiff = showAll ? diff : diffOnly;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-s1 border border-edge rounded-card shadow-card w-[90vw] max-w-4xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-edge">
          <div>
            <h2 className="text-lg font-semibold">{t("config.configComparison")}</h2>
            <p className="text-sm text-ink-3 mt-0.5">
              <span className="text-warn">{instA.label}</span>
              {" " + t("config.vs") + " "}
              <span className="text-cyan">{instB.label}</span>
              {" \u2014 "}
              {diffOnly.length === 0 ? t("config.identical") : t("config.differencesFound", { n: diffOnly.length })}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {diff.length > diffOnly.length && (
              <button
                onClick={() => setShowAll(!showAll)}
                className="text-xs text-cyan hover:underline"
              >
                {showAll ? t("config.differencesOnly") : t("config.showAll")}
              </button>
            )}
            <button onClick={onClose} className="text-ink-3 hover:text-ink text-lg leading-none">&times;</button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {displayDiff.length === 0 ? (
            <p className="text-center text-ink-3 py-8">{t("config.noDifferences")}</p>
          ) : (
            <div className="space-y-1">
              {displayDiff.map((d) => (
                <div
                  key={d.path}
                  className={`rounded px-3 py-2 text-xs font-mono ${
                    d.type === "changed" ? "bg-warn/5" :
                    d.type === "added" ? "bg-ok/5" :
                    d.type === "removed" ? "bg-danger/5" : "bg-s2/50"
                  }`}
                >
                  <div className="text-ink-2 mb-1">{d.path}</div>
                  <div className="flex gap-4">
                    <div className="flex-1 min-w-0">
                      <span className="text-ink-3 text-[10px] uppercase mr-1">{instA.label}:</span>
                      <span className={`break-all ${d.type === "removed" ? "text-danger" : d.type === "changed" ? "text-warn" : "text-ink-3"}`}>
                        {formatValue(d.valueA)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-ink-3 text-[10px] uppercase mr-1">{instB.label}:</span>
                      <span className={`break-all ${d.type === "added" ? "text-ok" : d.type === "changed" ? "text-cyan" : "text-ink-3"}`}>
                        {formatValue(d.valueB)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Config() {
  const { t } = useTranslation();
  const { instances } = useInstances();
  const [diffA, setDiffA] = useState<string>("");
  const [diffB, setDiffB] = useState<string>("");
  const [showDiff, setShowDiff] = useState(false);

  const instA = instances.find((i) => i.id === diffA);
  const instB = instances.find((i) => i.id === diffB);

  const diff = useMemo(() => {
    if (!instA || !instB) return [];
    return diffConfigs(instA.config, instB.config);
  }, [instA, instB]);

  const diffOnly = diff.filter((d) => d.type !== "same");

  // Skill comparison
  const allSkills = new Set<string>();
  instances.forEach((inst) => inst.skills.forEach((s) => allSkills.add(s.name)));
  const skillNames = [...allSkills].sort();

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">{t("config.title")}</h1>

      <div className="bg-s1 border border-edge rounded-card p-4 shadow-card mb-6">
        <h2 className="text-lg font-semibold mb-3">{t("config.configComparison")}</h2>
        <div className="flex items-end gap-4">
          <div className="flex-1">
            <label className="block text-xs text-ink-3 mb-1">{t("config.instanceA")}</label>
            <select value={diffA} onChange={(e) => setDiffA(e.target.value)} className="w-full bg-s2 border border-edge rounded-lg px-3 py-2 text-sm text-ink">
              <option value="">{t("config.selectPlaceholder")}</option>
              {instances.map((i) => <option key={i.id} value={i.id}>{i.connection.label || i.id}</option>)}
            </select>
          </div>
          <div className="flex-1">
            <label className="block text-xs text-ink-3 mb-1">{t("config.instanceB")}</label>
            <select value={diffB} onChange={(e) => setDiffB(e.target.value)} className="w-full bg-s2 border border-edge rounded-lg px-3 py-2 text-sm text-ink">
              <option value="">{t("config.selectPlaceholder")}</option>
              {instances.map((i) => <option key={i.id} value={i.id}>{i.connection.label || i.id}</option>)}
            </select>
          </div>
          <button
            onClick={() => setShowDiff(true)}
            disabled={!instA || !instB}
            className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <GitCompare size={14} /> {t("common.compare")}
          </button>
        </div>
        {instA && instB && (
          <p className="text-xs text-ink-3 mt-2">
            {diffOnly.length === 0 ? t("config.configsIdentical") : t("config.differencesFound", { n: diffOnly.length })}
          </p>
        )}
      </div>

      {showDiff && instA && instB && (
        <DiffModal
          instA={{ label: instA.connection.label || instA.id }}
          instB={{ label: instB.connection.label || instB.id }}
          diff={diff}
          onClose={() => setShowDiff(false)}
        />
      )}

      {skillNames.length > 0 && (
        <div className="bg-s1 border border-edge rounded-card overflow-hidden shadow-card">
          <h2 className="text-lg font-semibold p-4 border-b border-edge">{t("config.skillComparison")}</h2>
          <div className="overflow-auto max-h-[500px]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-s1">
                <tr className="border-b border-edge text-ink-2">
                  <th className="text-left p-3">{t("config.skillHeader")}</th>
                  {instances.map((i) => <th key={i.id} className="text-center p-3">{i.connection.label || i.id}</th>)}
                </tr>
              </thead>
              <tbody>
                {skillNames.map((name) => (
                  <tr key={name} className="border-b border-edge/50 hover:bg-s1/50">
                    <td className="p-3 font-mono text-xs">{name}</td>
                    {instances.map((inst) => {
                      const skill = inst.skills.find((s) => s.name === name);
                      return (
                        <td key={inst.id} className="p-3 text-center">
                          {skill ? (
                            skill.status === "missing" ? (
                              <XIcon size={16} className="inline text-danger" />
                            ) : skill.status === "ready" ? (
                              <Check size={16} className="inline text-ok" />
                            ) : (
                              <span className="inline-flex items-center gap-1 text-warn">
                                <Minus size={16} className="inline" />
                                <span className="text-xs">{skill.status}</span>
                              </span>
                            )
                          ) : (
                            <XIcon size={16} className="inline text-danger" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
