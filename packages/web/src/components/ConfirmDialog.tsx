import { useState } from "react";
import { useTranslation } from "react-i18next";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const resolvedConfirmLabel = confirmLabel || t("common.delete");

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-deep/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-s3 border border-edge-modal rounded-card p-6 w-96 shadow-[0_8px_32px_rgba(0,0,0,0.5)]" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-ink mb-2">{title}</h3>
        <p className="text-sm text-ink-2 mb-5">{message}</p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 text-sm text-ink-2 hover:text-ink transition-colors disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleConfirm}
            disabled={busy}
            className="px-4 py-2 text-sm bg-danger hover:bg-danger/80 rounded-card text-white font-semibold transition-colors disabled:opacity-50"
          >
            {busy ? t("common.deleting") : resolvedConfirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
