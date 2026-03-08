import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Shield, Check, X } from "lucide-react";
import { get } from "../lib/api";

interface Template {
  id: string;
  name: string;
  description: string;
  preset: boolean;
  config: {
    toolsAllow: string[];
    execSecurity: string;
    workspaceOnly: boolean;
  };
}

interface TemplateApplyModalProps {
  open: boolean;
  onClose: () => void;
  onApply: (config: Template["config"]) => void;
  currentValues: {
    toolsAllow: string[];
    execSecurity: string;
    workspaceOnly: boolean;
  };
}

export function TemplateApplyModal({ open, onClose, onApply, currentValues }: TemplateApplyModalProps) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<Template | null>(null);

  useEffect(() => {
    if (open) {
      get<Template[]>("/instances/templates").then(setTemplates).catch(() => {});
      setSelected(null);
    }
  }, [open]);

  if (!open) return null;

  const diff = selected ? [
    { field: t("templateApply.toolsAllowField"), before: currentValues.toolsAllow.join(", ") || t("templateApply.noneValue"), after: selected.config.toolsAllow.join(", ") },
    { field: t("templateApply.execSecurityField"), before: currentValues.execSecurity || t("templateApply.noneValue"), after: selected.config.execSecurity },
    { field: t("templateApply.workspaceOnlyField"), before: String(currentValues.workspaceOnly), after: String(selected.config.workspaceOnly) },
  ] : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-s1 border border-edge rounded-card shadow-card max-w-lg w-full max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-edge">
          <h3 className="text-lg font-semibold text-ink flex items-center gap-2">
            <Shield size={18} /> {t("templateApply.title")}
          </h3>
          <button onClick={onClose} className="text-ink-3 hover:text-ink"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {templates.map((tpl) => (
            <button
              key={tpl.id}
              onClick={() => setSelected(tpl)}
              className={`w-full text-left p-3 rounded border ${
                selected?.id === tpl.id ? "border-brand bg-brand/5" : "border-edge hover:border-ink-3"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium text-ink">{tpl.name}</span>
                {tpl.preset && <span className="px-1.5 py-0.5 text-xs rounded bg-cyan-dim text-cyan">{t("security.preset")}</span>}
              </div>
              <p className="text-xs text-ink-3 mt-0.5">{tpl.description}</p>
            </button>
          ))}
        </div>

        {selected && (
          <div className="border-t border-edge p-4">
            <h4 className="text-sm font-medium text-ink mb-2">{t("templateApply.previewChanges")}</h4>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-ink-3 text-xs">
                  <th className="text-left py-1">{t("templateApply.fieldHeader")}</th>
                  <th className="text-left py-1">{t("templateApply.currentHeader")}</th>
                  <th className="text-left py-1">{t("templateApply.afterHeader")}</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((d) => (
                  <tr key={d.field} className={d.before !== d.after ? "text-warn" : "text-ink-2"}>
                    <td className="py-1">{d.field}</td>
                    <td className="py-1 font-mono text-xs">{d.before}</td>
                    <td className="py-1 font-mono text-xs">{d.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-end mt-3">
              <button
                onClick={() => { onApply(selected.config); onClose(); }}
                className="flex items-center gap-1.5 px-4 py-2 text-sm rounded bg-brand text-white hover:bg-brand-light"
              >
                <Check size={14} /> {t("templateApply.applyToForm")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
