import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Settings } from "lucide-react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";
import { useInstances } from "../hooks/useInstances";
import { get } from "../lib/api";

const INSTANCE_COLORS = ["#22d3ee", "#34d399", "#818cf8", "#f472b6", "#fb923c", "#facc15", "#a78bfa", "#4ade80"];

type TimeRange = "24h" | "7d" | "30d" | "all" | "custom";

const TIME_RANGE_MS: Record<string, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "all": 0,
};

export function Usage() {
  const { t } = useTranslation();
  const { instances } = useInstances();
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [pricing, setPricing] = useState<Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>>({});

  useEffect(() => {
    get<{ models: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> }>("/lifecycle/pricing/models")
      .then((r) => setPricing(r.models || {}))
      .catch(() => { /* ignore */ });
  }, []);

  const connectedInstances = instances.filter((i) => i.connection.status === "connected");

  /** Estimate cost in USD for a model using LiteLLM pricing (per 1M tokens) */
  const lookupCost = (model: string, inputTokens: number, outputTokens: number, cacheRead = 0, cacheWrite = 0): number | null => {
    if (!model || Object.keys(pricing).length === 0) return null;
    const calc = (p: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) => {
      const cr = p.cacheRead ?? p.input;  // fallback to input cost
      const cw = p.cacheWrite ?? p.input;
      return (inputTokens * p.input + outputTokens * p.output + cacheRead * cr + cacheWrite * cw) / 1_000_000;
    };

    // 1. Exact match
    if (pricing[model]) return calc(pricing[model]);

    // 2. Split provider/model if present
    const parts = model.split("/");
    const providerPart = parts[0];
    const modelName = parts.length > 1 ? parts.slice(1).join("/") : model;

    // 3. Try model name alone (handles bare names like "gpt-5.4")
    if (parts.length > 1 && pricing[modelName]) return calc(pricing[modelName]);

    // 4. Try provider prefix mappings
    const providerMap: Record<string, string[]> = {
      "openai-codex": ["openai/", ""], openai: ["openai/", ""], anthropic: ["anthropic/", ""],
      google: ["gemini/", "google/", ""], deepseek: ["deepseek/", ""],
      moonshot: ["moonshot/", "azure_ai/", ""], qwen: ["qwen/", ""], zhipu: ["zhipu/", ""],
    };
    if (parts.length > 1) {
      for (const pfx of providerMap[providerPart] || [`${providerPart}/`, ""]) {
        const key = pfx + modelName;
        if (pricing[key]) return calc(pricing[key]);
      }
    }

    // 5. Case-insensitive match
    const lower = model.toLowerCase();
    for (const [k, v] of Object.entries(pricing)) {
      if (k.toLowerCase() === lower) return calc(v);
    }

    return null;
  };

  const cutoff = timeRange === "custom"
    ? (customFrom ? new Date(customFrom).getTime() : 0)
    : timeRange === "all" ? 0 : Date.now() - TIME_RANGE_MS[timeRange];
  const cutoffEnd = timeRange === "custom" && customTo ? new Date(customTo).getTime() : 0;

  const filterSessions = (sessions: typeof connectedInstances[0]["sessions"]) =>
    sessions.filter((s) => {
      const t = s.updatedAt || 0;
      if (cutoff && t < cutoff) return false;
      if (cutoffEnd && t > cutoffEnd) return false;
      return true;
    });

  const { totalSessions, totalInputTokens, totalOutputTokens, totalTokens, instanceStats, dailyChart, instLabels, dailyRows } = useMemo(() => {
    let totalSessions = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    // key: "date|instance", used for daily per-instance breakdown
    const dailyInstMap = new Map<string, { date: string; instance: string; sessions: number; inputTokens: number; outputTokens: number; totalTokens: number }>();

    const instanceStats = connectedInstances.map((inst) => {
      const label = inst.connection.label || inst.id;
      const sessions = filterSessions(inst.sessions);
      const input = sessions.reduce((t, s) => t + (s.inputTokens || 0), 0);
      const output = sessions.reduce((t, s) => t + (s.outputTokens || 0), 0);
      const total = sessions.reduce((t, s) => t + (s.totalTokens || 0), 0);
      totalSessions += sessions.length;
      totalInputTokens += input;
      totalOutputTokens += output;
      totalTokens += total;

      for (const s of sessions) {
        const date = s.updatedAt ? new Date(s.updatedAt).toISOString().slice(0, 10) : "unknown";
        const key = `${date}|${label}`;
        const entry = dailyInstMap.get(key) || { date, instance: label, sessions: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        entry.sessions += 1;
        entry.inputTokens += s.inputTokens || 0;
        entry.outputTokens += s.outputTokens || 0;
        entry.totalTokens += s.totalTokens || 0;
        dailyInstMap.set(key, entry);
      }

      // Estimate cost per session
      let instCost = 0;
      let hasCost = false;
      for (const s of sessions) {
        const c = lookupCost(s.model || "", s.inputTokens || 0, s.outputTokens || 0, s.cacheRead || 0, s.cacheWrite || 0);
        if (c !== null) { instCost += c; hasCost = true; }
      }

      return {
        id: inst.id,
        label,
        sessionCount: sessions.length,
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        agentCount: inst.agents.length,
        models: [...new Set(inst.agents.map((a) => a.model).filter(Boolean))],
        estimatedCost: hasCost ? instCost : null as number | null,
      };
    });

    // Build chart data: each row is a date, with dynamic keys per instance
    const dates = [...new Set([...dailyInstMap.values()].map((e) => e.date))].sort();
    const instLabels = [...new Set([...dailyInstMap.values()].map((e) => e.instance))];
    const dailyChart = dates.map((date) => {
      const row: Record<string, any> = { date };
      for (const inst of instLabels) {
        const entry = dailyInstMap.get(`${date}|${inst}`);
        row[inst] = entry?.totalTokens || 0;
      }
      return row;
    });
    // Flat daily rows for the table
    const dailyRows = [...dailyInstMap.values()].sort((a, b) => a.date.localeCompare(b.date) || a.instance.localeCompare(b.instance));

    return { totalSessions, totalInputTokens, totalOutputTokens, totalTokens, instanceStats, dailyChart, instLabels, dailyRows };
  }, [connectedInstances, cutoff, cutoffEnd, pricing]);

  // Model comparison across all instances
  const modelComparison = connectedInstances.flatMap((inst) =>
    inst.agents.map((a) => ({
      instanceId: inst.id,
      instance: inst.connection.label || inst.id,
      agent: a.id,
      model: a.model || "default",
      toolCount: a.toolsAllow?.length || 0,
      isDefault: a.isDefault,
    }))
  );

  const timeRangeLabels: Record<TimeRange, string> = {
    "24h": "24H",
    "7d": "7D",
    "30d": "30D",
    "all": t("usage.allRange"),
    "custom": t("usage.customRange"),
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t("usage.title")}</h1>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            {(["24h", "7d", "30d", "all", "custom"] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setTimeRange(r)}
                className={`px-2.5 py-1 rounded text-xs font-medium ${
                  timeRange === r
                    ? "bg-s3 text-ink"
                    : "bg-s2 text-ink-2 hover:text-ink"
                }`}
              >
                {timeRangeLabels[r]}
              </button>
            ))}
          </div>
          {timeRange === "custom" && (
            <div className="flex items-center gap-2">
              <input
                type="datetime-local"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="px-2 py-1 text-xs bg-s2 border border-edge rounded text-ink focus:outline-none focus:border-cyan"
              />
              <span className="text-ink-3 text-xs">{t("usage.toSeparator")}</span>
              <input
                type="datetime-local"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="px-2 py-1 text-xs bg-s2 border border-edge rounded text-ink focus:outline-none focus:border-cyan"
              />
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-s1 border border-edge rounded-card p-4 shadow-card">
          <p className="text-sm text-ink-2">{t("common.instances")}</p>
          <p className="text-2xl font-bold">{connectedInstances.length}</p>
        </div>
        <div className="bg-s1 border border-edge rounded-card p-4 shadow-card">
          <p className="text-sm text-ink-2">{t("usage.totalSessions")}</p>
          <p className="text-2xl font-bold">{totalSessions}</p>
        </div>
        <div className="bg-s1 border border-edge rounded-card p-4 shadow-card">
          <p className="text-sm text-ink-2">{t("usage.inputOutput")}</p>
          <p className="text-lg font-bold">
            <span className="text-cyan">{totalInputTokens.toLocaleString()}</span>
            <span className="text-ink-3 mx-1">/</span>
            <span className="text-ok">{totalOutputTokens.toLocaleString()}</span>
          </p>
          <p className="text-xs text-ink-3 mt-1">{t("usage.totalTokens")}: {(totalInputTokens + totalOutputTokens).toLocaleString()}</p>
        </div>
        <div className="bg-s1 border border-edge rounded-card p-4 shadow-card">
          <p className="text-sm text-ink-2">{t("usage.estimatedCost")}</p>
          {instanceStats.some((s) => s.estimatedCost != null) ? (
            <p className="text-2xl font-bold text-warn">
              ${instanceStats.reduce((sum, s) => sum + (s.estimatedCost || 0), 0).toFixed(2)}
            </p>
          ) : (
            <p className="text-2xl font-bold text-ink-3">—</p>
          )}
        </div>
      </div>

      {/* Daily Trend by Instance */}
      {dailyChart.length > 0 && (
        <div className="bg-s1 border border-edge rounded-card shadow-card p-4 mb-6">
          <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wider mb-3">{t("usage.dailyTokenUsage")}</h3>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={dailyChart} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="date"
                tick={{ fill: "#64748b", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "#1e293b" }}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                tick={{ fill: "#64748b", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "#1e293b" }}
                tickFormatter={(v: number) => v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
              />
              <Tooltip
                contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 12 }}
                formatter={(value: number) => [value.toLocaleString(), ""]}
                labelStyle={{ color: "#94a3b8" }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, color: "#94a3b8" }}
                iconType="line"
                iconSize={14}
              />
              {instLabels.map((label, i) => (
                <Line
                  key={label}
                  type="monotone"
                  dataKey={label}
                  stroke={INSTANCE_COLORS[i % INSTANCE_COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 3, fill: INSTANCE_COLORS[i % INSTANCE_COLORS.length] }}
                  activeDot={{ r: 5 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Daily Breakdown Table */}
      {dailyRows.length > 0 && (
        <div className="bg-s1 border border-edge rounded-card overflow-hidden mb-6 shadow-card">
          <h2 className="text-sm font-semibold p-4 border-b border-edge text-ink-2 uppercase tracking-wider">
            {t("usage.dailyBreakdown")}
            <span className="ml-2 text-xs font-normal text-ink-3">({dailyRows.length} {t("usage.rows")})</span>
          </h2>
          <div className="max-h-[400px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-s1">
                <tr className="border-b border-edge text-ink-3 text-xs">
                  <th className="text-left p-3">{t("usage.dateHeader")}</th>
                  <th className="text-left p-3">{t("usage.instanceHeader")}</th>
                  <th className="text-right p-3">{t("usage.sessionsHeader")}</th>
                  <th className="text-right p-3">{t("usage.inputHeader")}</th>
                  <th className="text-right p-3">{t("usage.outputHeader")}</th>
                  <th className="text-right p-3">{t("usage.totalHeader")}</th>
                </tr>
              </thead>
              <tbody>
                {dailyRows.map((row) => (
                  <tr key={`${row.date}-${row.instance}`} className="border-b border-edge/50 hover:bg-s2/30">
                    <td className="p-3 font-mono text-ink-3">{row.date.slice(5)}</td>
                    <td className="p-3">{row.instance}</td>
                    <td className="p-3 text-right">{row.sessions}</td>
                    <td className="p-3 text-right text-cyan">{row.inputTokens.toLocaleString()}</td>
                    <td className="p-3 text-right text-ok">{row.outputTokens.toLocaleString()}</td>
                    <td className="p-3 text-right font-medium">{row.totalTokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Token Charts */}
      {instanceStats.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          {/* Token Distribution */}
          <div className="bg-s1 border border-edge rounded-card shadow-card p-4">
            <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wider mb-3">{t("usage.tokenDistribution")}</h3>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={instanceStats} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "#1e293b" }}
                  interval={0}
                  angle={instanceStats.length > 4 ? -25 : 0}
                  textAnchor={instanceStats.length > 4 ? "end" : "middle"}
                  height={instanceStats.length > 4 ? 60 : 30}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "#1e293b" }}
                  tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                />
                <Tooltip
                  contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 12 }}
                  formatter={(value: number, name: string) => [value.toLocaleString(), name === "inputTokens" ? t("usage.inputLegend") : t("usage.outputLegend")]}
                  labelStyle={{ color: "#94a3b8" }}
                />
                <Bar dataKey="inputTokens" stackId="tokens" fill="#22d3ee" radius={[0, 0, 0, 0]} name="inputTokens" />
                <Bar dataKey="outputTokens" stackId="tokens" fill="#34d399" radius={[4, 4, 0, 0]} name="outputTokens" />
              </BarChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 mt-2 text-xs text-ink-3">
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded" style={{background:"#22d3ee"}} /> {t("usage.inputLegend")}</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded" style={{background:"#34d399"}} /> {t("usage.outputLegend")}</span>
            </div>
          </div>

          {/* Session Activity */}
          <div className="bg-s1 border border-edge rounded-card shadow-card p-4">
            <h3 className="text-sm font-semibold text-ink-2 uppercase tracking-wider mb-3">{t("usage.sessionsPerInstance")}</h3>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={instanceStats} layout="vertical" margin={{ top: 5, right: 20, bottom: 5, left: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "#1e293b" }}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: "#1e293b" }}
                  width={100}
                />
                <Tooltip
                  contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0", fontSize: 12 }}
                  formatter={(value: number) => [value, t("usage.sessionsHeader")]}
                  labelStyle={{ color: "#94a3b8" }}
                />
                <Bar dataKey="sessionCount" fill="#818cf8" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {instanceStats.length > 0 && (
        <div className="bg-s1 border border-edge rounded-card overflow-hidden mb-6 shadow-card">
          <h2 className="text-lg font-semibold p-4 border-b border-edge">{t("usage.perInstanceUsage")}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-ink-2">
                <th className="text-left p-3">{t("usage.instanceHeader")}</th>
                <th className="text-right p-3">{t("usage.sessionsHeader")}</th>
                <th className="text-right p-3">{t("usage.inputTokensHeader")}</th>
                <th className="text-right p-3">{t("usage.outputTokensHeader")}</th>
                <th className="text-right p-3">{t("usage.totalTokensHeader")}</th>
                <th className="text-right p-3">{t("usage.estimatedCostHeader")}</th>
                <th className="text-left p-3">{t("usage.modelsHeader")}</th>
              </tr>
            </thead>
            <tbody>
              {instanceStats.map((row) => (
                <tr key={row.id} className="border-b border-edge/50 hover:bg-s1/50">
                  <td className="p-3 font-medium">{row.label}</td>
                  <td className="p-3 text-right">{row.sessionCount}</td>
                  <td className="p-3 text-right text-cyan">{row.inputTokens.toLocaleString()}</td>
                  <td className="p-3 text-right text-ok">{row.outputTokens.toLocaleString()}</td>
                  <td className="p-3 text-right font-medium">{row.totalTokens.toLocaleString()}</td>
                  <td className="p-3 text-right text-warn">{row.estimatedCost != null ? `$${row.estimatedCost.toFixed(4)}` : "—"}</td>
                  <td className="p-3">
                    {row.models.map((m) => (
                      <code key={m} className="text-xs text-cyan bg-cyan-dim px-1.5 py-0.5 rounded mr-1">{m}</code>
                    ))}
                  </td>
                </tr>
              ))}
              {instanceStats.length > 1 && (
                <tr className="border-t border-edge-hi font-medium">
                  <td className="p-3">{t("common.total")}</td>
                  <td className="p-3 text-right">{totalSessions}</td>
                  <td className="p-3 text-right text-cyan">{totalInputTokens.toLocaleString()}</td>
                  <td className="p-3 text-right text-ok">{totalOutputTokens.toLocaleString()}</td>
                  <td className="p-3 text-right">{totalTokens.toLocaleString()}</td>
                  <td className="p-3 text-right text-warn">
                    {instanceStats.some((s) => s.estimatedCost != null)
                      ? `$${instanceStats.reduce((sum, s) => sum + (s.estimatedCost || 0), 0).toFixed(4)}`
                      : "—"}
                  </td>
                  <td className="p-3" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {modelComparison.length > 0 && (
        <div className="bg-s1 border border-edge rounded-card overflow-hidden shadow-card">
          <h2 className="text-lg font-semibold p-4 border-b border-edge">{t("usage.agentConfiguration")}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge text-ink-2">
                <th className="text-left p-3">{t("usage.instanceHeader")}</th>
                <th className="text-left p-3">{t("usage.agentHeader")}</th>
                <th className="text-left p-3">{t("usage.modelHeader")}</th>
                <th className="text-left p-3">{t("usage.toolsHeader")}</th>
                <th className="text-right p-3"></th>
              </tr>
            </thead>
            <tbody>
              {modelComparison.map((row, i) => (
                <tr key={i} className="border-b border-edge/50 hover:bg-s1/50">
                  <td className="p-3">{row.instance}</td>
                  <td className="p-3">{row.agent}{row.isDefault ? " (default)" : ""}</td>
                  <td className="p-3"><code className="text-cyan">{row.model}</code></td>
                  <td className="p-3">{row.toolCount}</td>
                  <td className="p-3 text-right">
                    <Link
                      to={`/instance/${row.instanceId}?tab=agents&agent=${row.agent}`}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs text-ink-3 hover:text-brand border border-edge rounded hover:border-brand"
                    >
                      <Settings size={12} /> {t("usage.configAction")}
                    </Link>
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
