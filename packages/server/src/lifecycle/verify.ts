import type { CommandExecutor } from "../executor/types.js";

export interface VerifyConfig {
  endpoint: string;
  authType: "bearer" | "x-api-key" | "query";
  accountEndpoint?: string;
}

export interface VerifyResult {
  status: "valid" | "invalid" | "unknown";
  error?: string;
  email?: string;
  accountInfo?: Record<string, unknown>;
}

const PROVIDER_VERIFY: Record<string, (baseUrl: string) => VerifyConfig> = {
  openai: (u) => ({ endpoint: `${u}/models`, authType: "bearer", accountEndpoint: `${u}/me` }),
  anthropic: (u) => ({ endpoint: `${u}/models`, authType: "x-api-key" }),
  google: (u) => ({ endpoint: `${u.replace(/\/v1\/?$/, "")}/v1beta/models`, authType: "query" }),
  mistral: (u) => ({ endpoint: `${u}/models`, authType: "bearer" }),
  deepseek: (u) => ({ endpoint: `${u}/models`, authType: "bearer", accountEndpoint: `${u}/user/balance` }),
  groq: (u) => ({ endpoint: `${u}/models`, authType: "bearer" }),
  together: (u) => ({ endpoint: `${u}/models`, authType: "bearer" }),
  cohere: (u) => ({ endpoint: `${u.replace(/\/v1\/?$/, "")}/v2/models`, authType: "bearer" }),
};

export function getVerifyConfig(provider: string, baseUrl: string): VerifyConfig | null {
  const url = baseUrl.replace(/\/+$/, "");
  if (!url) return null;

  const factory = PROVIDER_VERIFY[provider];
  if (factory) return factory(url);

  // Unknown provider with baseUrl: try OpenAI-compatible
  return { endpoint: `${url}/models`, authType: "bearer" };
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "***" + key.slice(-2);
  return key.slice(0, 4) + "..." + key.slice(-4);
}

export async function verifyProviderKey(
  exec: CommandExecutor,
  provider: string,
  key: string,
  baseUrl: string,
): Promise<VerifyResult> {
  const cfg = getVerifyConfig(provider, baseUrl);
  if (!cfg) return { status: "unknown", error: "No base URL configured" };

  const tmpKey = "/tmp/.clawctl-vk-$$";
  const cleanup = `rm -f ${tmpKey}`;

  let curlCmd: string;
  if (cfg.authType === "query") {
    curlCmd = [
      `printf '%s' '${escapeShell(key)}' > ${tmpKey}`,
      `CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "${cfg.endpoint}?key=$(cat ${tmpKey})")`,
      cleanup,
      `echo $CODE`,
    ].join(" && ");
  } else {
    const header = cfg.authType === "x-api-key" ? "x-api-key" : "Authorization";
    const prefix = cfg.authType === "x-api-key" ? "" : "Bearer ";
    curlCmd = [
      `printf '%s' '${escapeShell(key)}' > ${tmpKey}`,
      `CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -H "${header}: ${prefix}$(cat ${tmpKey})" "${cfg.endpoint}")`,
      cleanup,
      `echo $CODE`,
    ].join(" && ");
  }

  try {
    const r = await exec.exec(curlCmd, { timeout: 15_000 });

    // Non-zero exit code means curl itself failed (e.g. timeout=28, network error)
    if (r.exitCode !== 0) {
      exec.exec(cleanup).catch(() => {});
      const errMsg = r.stderr.trim() || `curl exit code ${r.exitCode}`;
      return { status: "unknown", error: errMsg };
    }

    const code = parseInt(r.stdout.trim()) || 0;

    if (code === 200) {
      const account = cfg.accountEndpoint
        ? await fetchAccountInfo(exec, cfg, key)
        : undefined;
      return {
        status: "valid",
        email: account?.email,
        accountInfo: account?.info,
      };
    }
    if (code === 401 || code === 403) {
      return { status: "invalid", error: `HTTP ${code}: unauthorized` };
    }
    return { status: "unknown", error: `HTTP ${code}` };
  } catch (err: unknown) {
    exec.exec(cleanup).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timeout") || msg.includes("Timeout")) {
      return { status: "unknown", error: "Connection timeout" };
    }
    return { status: "unknown", error: msg };
  }
}

async function fetchAccountInfo(
  exec: CommandExecutor,
  cfg: VerifyConfig,
  key: string,
): Promise<{ email?: string; info?: Record<string, unknown> } | undefined> {
  if (!cfg.accountEndpoint) return undefined;
  const tmpKey = "/tmp/.clawctl-vk-acct-$$";
  const header = cfg.authType === "x-api-key" ? "x-api-key" : "Authorization";
  const prefix = cfg.authType === "x-api-key" ? "" : "Bearer ";
  const cmd = [
    `printf '%s' '${escapeShell(key)}' > ${tmpKey}`,
    `curl -s -m 10 -H "${header}: ${prefix}$(cat ${tmpKey})" "${cfg.accountEndpoint}"`,
  ].join(" && ") + `; rm -f ${tmpKey}`;

  try {
    const r = await exec.exec(cmd, { timeout: 15_000 });
    if (r.exitCode !== 0) return undefined;
    const data = JSON.parse(r.stdout) as Record<string, unknown>;
    const userObj = data.user as Record<string, unknown> | undefined;
    const orgObj = data.organization as Record<string, unknown> | undefined;
    return {
      email:
        (data.email as string | undefined) ||
        (userObj?.email as string | undefined) ||
        (orgObj?.name as string | undefined),
      info: data,
    };
  } catch {
    return undefined;
  }
}

function escapeShell(s: string): string {
  return s.replace(/'/g, "'\\''");
}
