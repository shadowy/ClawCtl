import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { get } from "../lib/api";

interface Operation {
  id: number;
  instance_id: string;
  type: string;
  status: string;
  output: string;
  operator: string | null;
  started_at: string;
  finished_at: string | null;
}

interface PageResult {
  data: Operation[];
  total: number;
  page: number;
  pageSize: number;
}

export function Operations() {
  const { t } = useTranslation();
  const [result, setResult] = useState<PageResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [operator, setOperator] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // debounced operator for search-as-you-type
  const [debouncedOp, setDebouncedOp] = useState("");

  const pageSize = 50;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedOp(operator), 400);
    return () => clearTimeout(timer);
  }, [operator]);

  const fetchOps = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (debouncedOp) params.set("operator", debouncedOp);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    try {
      const res = await get<PageResult>(`/operations?${params}`);
      setResult(res);
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, debouncedOp, fromDate, toDate]);

  useEffect(() => { fetchOps(); }, [fetchOps]);

  // reset to page 1 when filters change
  useEffect(() => { setPage(1); }, [debouncedOp, fromDate, toDate]);

  const totalPages = result ? Math.max(1, Math.ceil(result.total / pageSize)) : 1;
  const operations = result?.data || [];

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">{t("operations.title")}</h1>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4 mb-4">
        <div>
          <label className="block text-xs text-ink-3 mb-1">{t("operations.operatorLabel")}</label>
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              placeholder={t("operations.searchOperator")}
              className="pl-8 pr-3 py-1.5 text-sm bg-s2 border border-edge rounded text-ink placeholder:text-ink-3 focus:outline-none focus:border-cyan w-48"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-ink-3 mb-1">{t("operations.fromLabel")}</label>
          <input
            type="datetime-local"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="px-3 py-1.5 text-sm bg-s2 border border-edge rounded text-ink focus:outline-none focus:border-cyan"
          />
        </div>
        <div>
          <label className="block text-xs text-ink-3 mb-1">{t("operations.toLabel")}</label>
          <input
            type="datetime-local"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="px-3 py-1.5 text-sm bg-s2 border border-edge rounded text-ink focus:outline-none focus:border-cyan"
          />
        </div>
        {(operator || fromDate || toDate) && (
          <button
            onClick={() => { setOperator(""); setFromDate(""); setToDate(""); }}
            className="px-3 py-1.5 text-sm text-ink-3 hover:text-ink border border-edge rounded"
          >
            {t("common.clear")}
          </button>
        )}
        <div className="ml-auto text-sm text-ink-3">
          {result ? t("common.records", { n: result.total }) : ""}
        </div>
      </div>

      {loading && !result ? (
        <div className="flex items-center justify-center py-20 text-ink-3 text-sm">
          <svg className="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>
          {t("operations.loadingOperations")}
        </div>
      ) : operations.length === 0 ? (
        <div className="bg-s1 border border-edge rounded-card p-8 text-center text-ink-3">
          {debouncedOp || fromDate || toDate ? t("operations.noMatchingOperations") : t("operations.noOperationsYet")}
        </div>
      ) : (
        <>
          <div className={`bg-s1 border border-edge rounded-card overflow-hidden shadow-card ${loading ? "opacity-60" : ""}`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge text-ink-3">
                  <th className="text-left p-3">{t("operations.idHeader")}</th>
                  <th className="text-left p-3">{t("operations.typeHeader")}</th>
                  <th className="text-left p-3">{t("operations.instanceHeader")}</th>
                  <th className="text-left p-3">{t("operations.statusHeader")}</th>
                  <th className="text-left p-3">{t("operations.operatorHeader")}</th>
                  <th className="text-left p-3">{t("operations.startedHeader")}</th>
                  <th className="text-left p-3">{t("operations.finishedHeader")}</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((op) => (
                  <tr key={op.id} className="border-b border-edge/50 hover:bg-s1/50">
                    <td className="p-3">{op.id}</td>
                    <td className="p-3">{op.type}</td>
                    <td className="p-3">{op.instance_id || "\u2014"}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        op.status === "running" ? "bg-cyan-dim text-cyan" :
                        op.status === "success" ? "bg-ok-dim text-ok" :
                        "bg-danger-dim text-danger"
                      }`}>{op.status}</span>
                    </td>
                    <td className="p-3 text-ink-3">{op.operator || "\u2014"}</td>
                    <td className="p-3 text-ink-3">{op.started_at}</td>
                    <td className="p-3 text-ink-3">{op.finished_at || "\u2014"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4">
            <span className="text-sm text-ink-3">
              {t("common.pageOf", { page, total: totalPages })}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="flex items-center gap-1 px-3 py-1.5 text-sm rounded border border-edge hover:bg-s2 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={14} /> {t("common.prev")}
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="flex items-center gap-1 px-3 py-1.5 text-sm rounded border border-edge hover:bg-s2 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {t("common.next")} <ChevronRight size={14} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
