/**
 * Provider quota / balance fetchers.
 * Queries provider-specific APIs via SSH on the remote host (keys stay on the host).
 */

type Exec = { exec: (cmd: string, opts?: any) => Promise<{ stdout: string; stderr: string; exitCode: number }> };

export interface QuotaWindow {
  label: string;        // "3h", "Day", "Week"
  usedPercent: number;  // 0-100
  resetAt: number;      // epoch ms
  windowSeconds: number;
}

export interface ProviderQuota {
  provider: string;
  displayName: string;
  windows: QuotaWindow[];
  balance?: number;      // USD or CNY
  currency?: string;     // "USD" | "CNY"
  plan?: string;
  error?: string;
}

// ─── Codex (OpenAI OAuth) ─────────────────────────────────────

function windowLabel(seconds: number, primaryResetAt?: number, secondaryResetAt?: number): string {
  if (seconds >= 604_800) return "Week";
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  if (primaryResetAt && secondaryResetAt && secondaryResetAt - primaryResetAt >= 3 * 86_400) return "Week";
  return "Day";
}

export async function fetchCodexQuota(exec: Exec, accessToken: string, accountId?: string): Promise<ProviderQuota> {
  const headers = [
    `-H 'Authorization: Bearer ${accessToken}'`,
    `-H 'User-Agent: CodexBar'`,
    `-H 'Accept: application/json'`,
  ];
  if (accountId) headers.push(`-H 'ChatGPT-Account-Id: ${accountId}'`);

  const cmd = `curl -sS --max-time 10 ${headers.join(" ")} 'https://chatgpt.com/backend-api/wham/usage' 2>&1`;
  const r = await exec.exec(cmd, { timeout: 15_000 });
  if (r.exitCode !== 0) return { provider: "openai-codex", displayName: "OpenAI Codex", windows: [], error: `curl failed: ${r.stderr.slice(0, 200)}` };

  let data: any;
  try { data = JSON.parse(r.stdout.trim()); } catch {
    return { provider: "openai-codex", displayName: "OpenAI Codex", windows: [], error: `Invalid JSON: ${r.stdout.slice(0, 200)}` };
  }

  const windows: QuotaWindow[] = [];
  const rl = data.rate_limit;
  if (rl) {
    const pw = rl.primary_window;
    const sw = rl.secondary_window;
    if (pw) {
      const secs = pw.limit_window_seconds || 10_800;
      windows.push({ label: `${Math.round(secs / 3600)}h`, usedPercent: Math.min(100, Math.max(0, pw.used_percent || 0)), resetAt: (pw.reset_at || 0) * 1000, windowSeconds: secs });
    }
    if (sw) {
      const secs = sw.limit_window_seconds || 86_400;
      windows.push({ label: windowLabel(secs, pw?.reset_at, sw?.reset_at), usedPercent: Math.min(100, Math.max(0, sw.used_percent || 0)), resetAt: (sw.reset_at || 0) * 1000, windowSeconds: secs });
    }
  }

  let balance: number | undefined;
  if (data.credits?.balance != null) {
    const bal = parseFloat(String(data.credits.balance));
    if (!isNaN(bal)) balance = bal;
  }

  return { provider: "openai-codex", displayName: "OpenAI Codex", windows, balance, currency: "USD", plan: data.plan_type || undefined };
}

// ─── DeepSeek ─────────────────────────────────────────────────
// GET https://api.deepseek.com/user/balance
// Response: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "5.00", ... }] }

export async function fetchDeepSeekBalance(exec: Exec, apiKey: string): Promise<ProviderQuota> {
  const cmd = `curl -sS --max-time 10 -H 'Authorization: Bearer ${apiKey}' -H 'Accept: application/json' 'https://api.deepseek.com/user/balance' 2>&1`;
  const r = await exec.exec(cmd, { timeout: 15_000 });
  if (r.exitCode !== 0) return { provider: "deepseek", displayName: "DeepSeek", windows: [], error: `curl failed` };

  let data: any;
  try { data = JSON.parse(r.stdout.trim()); } catch {
    return { provider: "deepseek", displayName: "DeepSeek", windows: [], error: `Invalid response` };
  }

  if (!data.balance_infos?.length) {
    return { provider: "deepseek", displayName: "DeepSeek", windows: [], error: data.message || "No balance info" };
  }

  const info = data.balance_infos[0];
  const balance = parseFloat(info.total_balance || "0");
  return { provider: "deepseek", displayName: "DeepSeek", windows: [], balance, currency: info.currency || "CNY" };
}

// ─── Moonshot (Kimi) ──────────────────────────────────────────
// GET https://api.moonshot.cn/v1/users/me/balance
// Response: { data: { available_balance: 50.0, voucher_balance: 0, cash_balance: 50.0 } }

export async function fetchMoonshotBalance(exec: Exec, apiKey: string): Promise<ProviderQuota> {
  const cmd = `curl -sS --max-time 10 -H 'Authorization: Bearer ${apiKey}' -H 'Accept: application/json' 'https://api.moonshot.cn/v1/users/me/balance' 2>&1`;
  const r = await exec.exec(cmd, { timeout: 15_000 });
  if (r.exitCode !== 0) return { provider: "moonshot", displayName: "Moonshot (Kimi)", windows: [], error: `curl failed` };

  let data: any;
  try { data = JSON.parse(r.stdout.trim()); } catch {
    return { provider: "moonshot", displayName: "Moonshot (Kimi)", windows: [], error: `Invalid response` };
  }

  if (!data.data) {
    return { provider: "moonshot", displayName: "Moonshot (Kimi)", windows: [], error: data.error?.message || "No balance info" };
  }

  const balance = data.data.available_balance ?? data.data.cash_balance ?? 0;
  return { provider: "moonshot", displayName: "Moonshot (Kimi)", windows: [], balance, currency: "CNY" };
}

// ─── 智谱 (GLM / Zhipu) ──────────────────────────────────────
// GET https://open.bigmodel.cn/api/llm-application/open/v2/account/balance
// Headers: Authorization: Bearer <api_key>

export async function fetchZhipuBalance(exec: Exec, apiKey: string): Promise<ProviderQuota> {
  const cmd = `curl -sS --max-time 10 -H 'Authorization: Bearer ${apiKey}' -H 'Accept: application/json' 'https://open.bigmodel.cn/api/llm-application/open/v2/account/balance' 2>&1`;
  const r = await exec.exec(cmd, { timeout: 15_000 });
  if (r.exitCode !== 0) return { provider: "zhipu", displayName: "智谱 (GLM)", windows: [], error: `curl failed` };

  let data: any;
  try { data = JSON.parse(r.stdout.trim()); } catch {
    return { provider: "zhipu", displayName: "智谱 (GLM)", windows: [], error: `Invalid response` };
  }

  // Zhipu API returns { success: true, data: { balance: { available: "10.00" } } }
  // or { code, message } on error
  if (data.code && data.code !== 200) {
    return { provider: "zhipu", displayName: "智谱 (GLM)", windows: [], error: data.message || `Error ${data.code}` };
  }

  const bal = parseFloat(data.data?.balance?.available || data.data?.balance || "0");
  return { provider: "zhipu", displayName: "智谱 (GLM)", windows: [], balance: isNaN(bal) ? undefined : bal, currency: "CNY" };
}

// ─── 通义千问 (Qwen / Alibaba) ────────────────────────────────
// No public balance API available via simple API key auth.
// DashScope requires AccessKey + complex signing, skipped for now.

// ─── Dispatcher ───────────────────────────────────────────────

/** Map provider name → fetcher function (requires API key) */
const API_KEY_FETCHERS: Record<string, (exec: Exec, apiKey: string) => Promise<ProviderQuota>> = {
  deepseek: fetchDeepSeekBalance,
  moonshot: fetchMoonshotBalance,
  zhipu: fetchZhipuBalance,
};

export function getApiKeyFetcher(provider: string): ((exec: Exec, apiKey: string) => Promise<ProviderQuota>) | null {
  return API_KEY_FETCHERS[provider] || null;
}
