import type { CommandExecutor } from "../executor/types.js";

export function getConfigDir(profile: string): string {
  return profile === "default" ? "$HOME/.openclaw" : `$HOME/.openclaw-${profile}`;
}

/** Extract profile name from instance ID (e.g. "ssh-1-feishu" → "feishu") */
export function profileFromInstanceId(instanceId: string): string {
  const parts = instanceId.split("-");
  return parts[parts.length - 1];
}

export async function readRemoteConfig(exec: CommandExecutor, configDir: string): Promise<any> {
  const r = await exec.exec(`cat "${configDir}/openclaw.json"`);
  if (r.exitCode !== 0) throw new Error(`Failed to read config: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

export async function writeRemoteConfig(exec: CommandExecutor, configDir: string, config: any): Promise<void> {
  const json = JSON.stringify(config, null, 2);
  const r = await exec.exec(`cat > "${configDir}/openclaw.json" << 'CLAWCTL_EOF'\n${json}\nCLAWCTL_EOF`);
  if (r.exitCode !== 0) throw new Error(`Failed to write config: ${r.stderr}`);
}

/** Read auth-profiles.json for a specific agent */
export async function readAuthProfiles(exec: CommandExecutor, configDir: string, agentId: string): Promise<any> {
  const path = `${configDir}/agents/${agentId}/agent/auth-profiles.json`;
  const r = await exec.exec(`cat "${path}" 2>/dev/null || echo '{}'`);
  try { return JSON.parse(r.stdout); } catch { return {}; }
}

/** Write auth-profiles.json for a specific agent */
export async function writeAuthProfiles(exec: CommandExecutor, configDir: string, agentId: string, data: any): Promise<void> {
  const path = `${configDir}/agents/${agentId}/agent/auth-profiles.json`;
  const json = JSON.stringify(data, null, 2);
  const r = await exec.exec(`mkdir -p "${configDir}/agents/${agentId}/agent" && cat > "${path}" << 'CLAWCTL_EOF'\n${json}\nCLAWCTL_EOF`);
  if (r.exitCode !== 0) throw new Error(`Failed to write auth-profiles: ${r.stderr}`);
}
