import type { CommandExecutor } from "../executor/types.js";
import { createChannelConfig, CHANNEL_DEFS, type CreateChannelInput } from "./channel-config.js";
import { readRemoteConfig, writeRemoteConfig } from "./config.js";

const MIN_NODE_MAJOR = 22;

export interface NodeVersionInfo {
  installed: boolean;
  version?: string;
  sufficient: boolean;
}

export async function checkNodeVersion(exec: CommandExecutor): Promise<NodeVersionInfo> {
  const r = await exec.exec("node --version 2>/dev/null");
  if (r.exitCode !== 0 || !r.stdout.trim()) return { installed: false, sufficient: false };
  const version = r.stdout.trim().replace(/^v/, "");
  const major = parseInt(version.split(".")[0]);
  return { installed: true, version, sufficient: major >= MIN_NODE_MAJOR };
}

export interface VersionInfo {
  installed?: string;
  latest?: string;
  updateAvailable: boolean;
  distTags?: Record<string, string>;
}

export async function getVersions(exec: CommandExecutor): Promise<VersionInfo> {
  const [installedR, tagsR] = await Promise.all([
    exec.exec("openclaw --version 2>/dev/null"),
    exec.exec("npm view openclaw dist-tags --json 2>/dev/null"),
  ]);
  const installed = installedR.exitCode === 0 ? installedR.stdout.trim() : undefined;
  let distTags: Record<string, string> | undefined;
  let latest: string | undefined;
  if (tagsR.exitCode === 0 && tagsR.stdout.trim()) {
    try {
      distTags = JSON.parse(tagsR.stdout.trim());
      latest = distTags?.latest;
    } catch { /* ignore parse error */ }
  }
  // Extract semver from installed string (e.g. "OpenClaw 2026.3.8 (3caab92)" → "2026.3.8")
  const installedVersion = installed?.match(/(\d+\.\d+\.\d+)/)?.[1];
  return {
    installed,
    latest,
    updateAvailable: !!(installedVersion && latest && installedVersion !== latest),
    distTags,
  };
}

export interface InstallResult {
  success: boolean;
  output: string;
}

export async function installOpenClaw(exec: CommandExecutor, version?: string): Promise<InstallResult> {
  const pkg = version ? `openclaw@${version}` : "openclaw@latest";
  const r = await exec.exec(`npm i -g ${pkg}`, { timeout: 120_000 });
  return { success: r.exitCode === 0, output: r.stdout + r.stderr };
}

// --- Streaming multi-step install with auto Node.js setup ---

export interface InstallStep {
  step: string;
  status: "running" | "done" | "error" | "skipped";
  detail?: string;
}

type EmitFn = (event: InstallStep) => Promise<void>;

/** Run a long command via nohup so it survives SSH disconnects.
 *  Polls for completion every 3s. Returns stdout + exit code. */
async function execLong(
  exec: CommandExecutor,
  command: string,
  timeout: number = 180_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const id = `clawctl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const logFile = `/tmp/${id}.log`;
  const rcFile = `/tmp/${id}.rc`;

  // Start in background: run command, write exit code to rcFile when done
  await exec.exec(
    `nohup bash -c '${command.replace(/'/g, "'\\''")}; echo $? > ${rcFile}' > ${logFile} 2>&1 &`,
  );

  // Poll for completion
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 3000));
    const rcR = await exec.exec(`cat ${rcFile} 2>/dev/null`);
    if (rcR.exitCode === 0 && rcR.stdout.trim() !== "") {
      // Done — read log and cleanup
      const logR = await exec.exec(`cat ${logFile} 2>/dev/null`);
      const exitCode = parseInt(rcR.stdout.trim()) || 0;
      await exec.exec(`rm -f ${logFile} ${rcFile}`);
      return { stdout: logR.stdout, stderr: "", exitCode };
    }
  }

  // Timeout — kill and cleanup
  await exec.exec(`pkill -f '${id}' 2>/dev/null; rm -f ${logFile} ${rcFile}`);
  return { stdout: "", stderr: "Command timed out", exitCode: 124 };
}

async function ensureNodeJs(exec: CommandExecutor, emit: EmitFn): Promise<boolean> {
  await emit({ step: "Check Node.js", status: "running" });
  const node = await checkNodeVersion(exec);

  if (node.installed && node.sufficient) {
    await emit({ step: "Check Node.js", status: "done", detail: `v${node.version}` });
    return true;
  }

  if (node.installed && !node.sufficient) {
    await emit({ step: "Check Node.js", status: "running", detail: `v${node.version} too old (need ≥${MIN_NODE_MAJOR}), upgrading...` });
  } else {
    await emit({ step: "Check Node.js", status: "running", detail: "Not found, installing..." });
  }

  // Detect OS and package manager
  const osR = await exec.exec("cat /etc/os-release 2>/dev/null | grep ^ID= | cut -d= -f2 | tr -d '\"'");
  const osId = osR.stdout.trim().toLowerCase();

  let installCmd: string;
  if (["ubuntu", "debian"].includes(osId)) {
    // NodeSource for Debian/Ubuntu
    installCmd = [
      "apt-get update -qq",
      "apt-get install -y -qq curl ca-certificates gnupg",
      `curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x | bash -`,
      "apt-get install -y -qq nodejs",
    ].join(" && ");
  } else if (["centos", "rhel", "fedora", "rocky", "almalinux", "amzn"].includes(osId)) {
    installCmd = [
      `curl -fsSL https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x | bash -`,
      "yum install -y nodejs",
    ].join(" && ");
  } else if (["alpine"].includes(osId)) {
    installCmd = `apk add --no-cache nodejs npm`;
  } else {
    // Fallback: try nvm-style install
    installCmd = [
      `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash`,
      `export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm install ${MIN_NODE_MAJOR}`,
    ].join(" && ");
  }

  await emit({ step: "Install Node.js", status: "running", detail: `OS: ${osId || "unknown"}` });

  // Try with sudo first, fall back to direct if no sudo
  const hasSudo = (await exec.exec("command -v sudo >/dev/null 2>&1 && echo yes")).stdout.trim() === "yes";
  const prefix = hasSudo ? "sudo " : "";
  const r = await execLong(exec, `${prefix}bash -c '${installCmd.replace(/'/g, "'\\''")}'`, 180_000);

  if (r.exitCode !== 0) {
    await emit({ step: "Install Node.js", status: "error", detail: (r.stderr || r.stdout).slice(0, 200) });
    return false;
  }

  // Verify
  const verify = await checkNodeVersion(exec);
  if (!verify.installed || !verify.sufficient) {
    await emit({ step: "Install Node.js", status: "error", detail: "Installed but version check failed" });
    return false;
  }

  await emit({ step: "Install Node.js", status: "done", detail: `v${verify.version}` });
  return true;
}

async function ensureNpm(exec: CommandExecutor, emit: EmitFn): Promise<boolean> {
  await emit({ step: "Check npm", status: "running" });
  const r = await exec.exec("npm --version 2>/dev/null");
  if (r.exitCode === 0 && r.stdout.trim()) {
    await emit({ step: "Check npm", status: "done", detail: `v${r.stdout.trim()}` });
    return true;
  }

  await emit({ step: "Check npm", status: "running", detail: "Not found, installing..." });
  const hasSudo = (await exec.exec("command -v sudo >/dev/null 2>&1 && echo yes")).stdout.trim() === "yes";
  const prefix = hasSudo ? "sudo " : "";
  // Try corepack or direct install
  await execLong(exec, `${prefix}corepack enable 2>/dev/null || ${prefix}apt-get install -y -qq npm 2>/dev/null || ${prefix}yum install -y npm 2>/dev/null`, 60_000);

  const verify = await exec.exec("npm --version 2>/dev/null");
  if (verify.exitCode === 0 && verify.stdout.trim()) {
    await emit({ step: "Check npm", status: "done", detail: `v${verify.stdout.trim()}` });
    return true;
  }

  await emit({ step: "Check npm", status: "error", detail: "Could not install npm" });
  return false;
}

export async function streamUninstall(
  exec: CommandExecutor,
  emit: EmitFn,
): Promise<boolean> {
  // Step 1: Check if openclaw is installed
  await emit({ step: "Check installation", status: "running" });
  const r = await exec.exec("openclaw --version 2>/dev/null");
  if (r.exitCode !== 0 || !r.stdout.trim()) {
    await emit({ step: "Check installation", status: "done", detail: "Not installed, nothing to do" });
    return true;
  }
  await emit({ step: "Check installation", status: "done", detail: `v${r.stdout.trim()}` });

  // Step 2: Stop running processes
  await emit({ step: "Stop processes", status: "running" });
  const pids = await exec.exec("pgrep -f 'openclaw.*--port' 2>/dev/null");
  if (pids.exitCode === 0 && pids.stdout.trim()) {
    await exec.exec("pkill -f 'openclaw.*--port' 2>/dev/null; true");
    await emit({ step: "Stop processes", status: "done", detail: "Stopped running gateway processes" });
  } else {
    await emit({ step: "Stop processes", status: "done", detail: "No running processes" });
  }

  // Step 3: Disable systemd services if any
  await emit({ step: "Disable services", status: "running" });
  const units = await exec.exec("systemctl --user list-unit-files 'openclaw-gateway*.service' --no-legend 2>/dev/null");
  if (units.exitCode === 0 && units.stdout.trim()) {
    const serviceNames = units.stdout.trim().split("\n").map(l => l.split(/\s+/)[0]).filter(Boolean);
    for (const svc of serviceNames) {
      await exec.exec(`systemctl --user stop ${svc} 2>/dev/null; systemctl --user disable ${svc} 2>/dev/null; true`);
    }
    await emit({ step: "Disable services", status: "done", detail: `Disabled ${serviceNames.length} service(s)` });
  } else {
    await emit({ step: "Disable services", status: "skipped", detail: "No systemd services found" });
  }

  // Step 4: Uninstall npm package
  await emit({ step: "Uninstall openclaw", status: "running" });
  const hasSudo = (await exec.exec("command -v sudo >/dev/null 2>&1 && echo yes")).stdout.trim() === "yes";
  const prefix = hasSudo ? "sudo " : "";
  const uninstall = await exec.exec(`${prefix}npm rm -g openclaw`, { timeout: 60_000 });
  if (uninstall.exitCode !== 0) {
    await emit({ step: "Uninstall openclaw", status: "error", detail: (uninstall.stderr || uninstall.stdout).slice(0, 200) });
    return false;
  }
  await emit({ step: "Uninstall openclaw", status: "done" });

  // Step 5: Verify
  await emit({ step: "Verify removal", status: "running" });
  const verify = await exec.exec("openclaw --version 2>/dev/null");
  if (verify.exitCode === 0 && verify.stdout.trim()) {
    await emit({ step: "Verify removal", status: "error", detail: "openclaw still found after uninstall" });
    return false;
  }
  await emit({ step: "Verify removal", status: "done", detail: "openclaw removed successfully" });
  return true;
}

export async function streamInstall(
  exec: CommandExecutor,
  emit: EmitFn,
  version?: string,
): Promise<boolean> {
  // Step 1: Node.js
  if (!(await ensureNodeJs(exec, emit))) return false;

  // Step 2: npm
  if (!(await ensureNpm(exec, emit))) return false;

  // Step 3: Check for concurrent install
  const running = await exec.exec("ps aux | grep 'npm.*[i].*openclaw' | grep -v grep 2>/dev/null");
  if (running.exitCode === 0 && running.stdout.trim()) {
    await emit({ step: "Install check", status: "error", detail: "Another install is already in progress" });
    return false;
  }

  // Step 4: Install OpenClaw (nohup — survives SSH disconnect)
  const pkg = version ? `openclaw@${version}` : "openclaw@latest";
  await emit({ step: `Install ${pkg}`, status: "running" });
  const hasSudo = (await exec.exec("command -v sudo >/dev/null 2>&1 && echo yes")).stdout.trim() === "yes";
  const sudoPrefix = hasSudo ? "sudo " : "";
  const r = await execLong(exec, `${sudoPrefix}npm i -g ${pkg}`, 300_000);
  if (r.exitCode !== 0) {
    await emit({ step: `Install ${pkg}`, status: "error", detail: (r.stderr || r.stdout).slice(0, 200) });
    return false;
  }
  await emit({ step: `Install ${pkg}`, status: "done" });

  // Step 5: Verify — check binary and fix bin link if needed
  await emit({ step: "Verify installation", status: "running" });
  let verify = await exec.exec("openclaw --version 2>/dev/null");
  if (verify.exitCode !== 0 || !verify.stdout.trim()) {
    // bin link may be missing — try to rebuild
    await emit({ step: "Verify installation", status: "running", detail: "Bin link missing, rebuilding..." });
    await exec.exec(`${sudoPrefix}npm link openclaw 2>/dev/null; ${sudoPrefix}npm rebuild -g openclaw 2>/dev/null`);
    verify = await exec.exec("openclaw --version 2>/dev/null");
  }
  if (verify.exitCode !== 0 || !verify.stdout.trim()) {
    await emit({ step: "Verify installation", status: "error", detail: "openclaw command not found after install" });
    return false;
  }
  await emit({ step: "Verify installation", status: "done", detail: `v${verify.stdout.trim()}` });

  // Step 6: Check systemd availability
  const newVersion = verify.stdout.trim();
  const hasSystemd = (await exec.exec("command -v systemctl >/dev/null 2>&1 && echo yes")).stdout.trim() === "yes";

  if (!hasSystemd) {
    await emit({ step: "Setup service", status: "skipped", detail: "systemd not available" });
    return true;
  }

  // Step 7: Find existing gateway services
  await emit({ step: "Check services", status: "running" });
  const unitDir = "$HOME/.config/systemd/user";
  const findUnits = await exec.exec(`ls ${unitDir}/openclaw-gateway*.service 2>/dev/null; true`);
  const unitFiles = findUnits.stdout.trim().split("\n").filter((f) => f.endsWith(".service"));

  if (unitFiles.length > 0) {
    // Upgrade path: update version in existing unit files and restart
    await emit({ step: "Check services", status: "done", detail: `${unitFiles.length} service(s) found` });

    await emit({ step: "Update services", status: "running" });

    // Resolve the actual binary entrypoint for the newly-installed version.
    // `which openclaw` returns the wrapper (e.g. /usr/bin/openclaw); we need
    // the dist/index.js it points to, so ExecStart uses the correct path
    // even when the npm prefix changed across upgrades.
    const whichR = await exec.exec("which openclaw 2>/dev/null");
    const cliBin = whichR.stdout.trim() || "";
    let newDistPath = "";
    if (cliBin) {
      // Resolve the real path behind the symlink and find dist/index.js
      const realR = await exec.exec(`readlink -f '${cliBin}' 2>/dev/null`);
      const realBin = realR.stdout.trim();
      if (realBin) {
        // openclaw.mjs sits next to dist/; resolve dist/index.js from there
        const distR = await exec.exec(`dirname '${realBin}' 2>/dev/null`);
        const pkgDir = distR.stdout.trim();
        if (pkgDir) {
          const indexPath = `${pkgDir}/dist/index.js`;
          const existsR = await exec.exec(`test -f '${indexPath}' && echo yes`);
          if (existsR.stdout.trim() === "yes") newDistPath = indexPath;
        }
      }
    }

    for (const uf of unitFiles) {
      await exec.exec(`sed -i 's/OPENCLAW_SERVICE_VERSION=[^ ]*/OPENCLAW_SERVICE_VERSION=${newVersion}/' '${uf}' 2>/dev/null; true`);
      // Also update Description line
      await exec.exec(`sed -i 's/\\(Description=OpenClaw Gateway.*v\\)[^ )]*\\(.*\\)/\\1${newVersion}\\2/' '${uf}' 2>/dev/null; true`);
      // Update ExecStart binary path if the npm install location changed
      if (newDistPath) {
        await exec.exec(`sed -i 's|node .*/dist/index\\.js|node ${newDistPath}|' '${uf}' 2>/dev/null; true`);
      }
    }
    await exec.exec("systemctl --user daemon-reload 2>/dev/null; true");
    await emit({ step: "Update services", status: "done", detail: `Updated to v${newVersion}${newDistPath ? " (binary path synced)" : ""}` });

    // Restart running services
    await emit({ step: "Restart services", status: "running" });
    const listUnits = await exec.exec("systemctl --user list-units 'openclaw-gateway*' --no-pager --plain --no-legend 2>/dev/null");
    const units = listUnits.stdout.trim().split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((u) => u && u.startsWith("openclaw-gateway") && u.endsWith(".service"));
    if (units.length > 0) {
      let restarted = 0;
      for (const unit of units) {
        const r2 = await exec.exec(`systemctl --user restart ${unit} 2>&1`);
        if (r2.exitCode === 0) restarted++;
        else await emit({ step: "Restart services", status: "running", detail: `Failed to restart ${unit}` });
      }
      await emit({ step: "Restart services", status: "done", detail: `${restarted}/${units.length} services restarted` });
    } else {
      await emit({ step: "Restart services", status: "done", detail: "No active services to restart" });
    }
  } else {
    // Fresh install: use `openclaw gateway install` to create systemd service
    await emit({ step: "Check services", status: "done", detail: "No existing services" });

    await emit({ step: "Setup gateway service", status: "running", detail: "Creating systemd service..." });

    // Find an available port (default 18789)
    const portCheck = await exec.exec("ss -ltnp 2>/dev/null | grep ':18789 ' || true");
    const port = portCheck.stdout.trim() ? 18889 : 18789;

    const installR = await execLong(exec, `openclaw gateway install --port ${port} --json 2>&1`, 60_000);
    if (installR.exitCode !== 0) {
      await emit({ step: "Setup gateway service", status: "error", detail: (installR.stderr || installR.stdout).slice(0, 200) });
      // Non-fatal: install succeeded, just no systemd service
      return true;
    }
    await emit({ step: "Setup gateway service", status: "done", detail: `Port ${port}` });

    // Enable linger so service survives SSH logout
    await emit({ step: "Enable linger", status: "running" });
    const lingerR = await exec.exec("loginctl enable-linger $(whoami) 2>&1; true");
    if (lingerR.exitCode === 0) {
      await emit({ step: "Enable linger", status: "done" });
    } else {
      await emit({ step: "Enable linger", status: "skipped", detail: "loginctl not available" });
    }

    // Start the service
    await emit({ step: "Start gateway", status: "running" });
    const startR = await exec.exec("systemctl --user start openclaw-gateway.service 2>&1");
    if (startR.exitCode === 0) {
      await emit({ step: "Start gateway", status: "done", detail: `Running on port ${port}` });
    } else {
      await emit({ step: "Start gateway", status: "error", detail: startR.stdout.slice(0, 200) });
    }
  }

  return true;
}

// --- Channel creation with SSE progress ---

async function rollback(exec: CommandExecutor, backupPath: string, configDir: string): Promise<void> {
  await exec.exec(`cp "${backupPath}" "${configDir}/openclaw.json" 2>/dev/null; rm -f "${backupPath}"`);
}

export async function streamChannelCreate(
  exec: CommandExecutor,
  configDir: string,
  channel: string,
  input: CreateChannelInput,
  bindAgentIds: string[],
  emit: EmitFn,
): Promise<boolean> {
  const backupPath = `${configDir}/openclaw.json.channel-bak`;

  // Step 1: Validate
  await emit({ step: "Validate", status: "running" });
  const def = CHANNEL_DEFS[channel];
  if (!def) {
    await emit({ step: "Validate", status: "error", detail: `Unknown channel type: ${channel}` });
    return false;
  }
  const missing = def.requiredFields.filter((f) => !(input as any)[f]);
  if (missing.length > 0) {
    await emit({ step: "Validate", status: "error", detail: `Missing required fields: ${missing.join(", ")}` });
    return false;
  }
  await emit({ step: "Validate", status: "done", detail: `${def.label} channel` });

  // Step 2: Backup config
  await emit({ step: "Backup config", status: "running" });
  const cpR = await exec.exec(`cp "${configDir}/openclaw.json" "${backupPath}"`);
  if (cpR.exitCode !== 0) {
    await emit({ step: "Backup config", status: "error", detail: "Failed to backup openclaw.json" });
    return false;
  }
  await emit({ step: "Backup config", status: "done" });

  // Step 3: Check dependencies
  const needsDeps = !!(def.extensionDir && def.depCheckPath);
  if (needsDeps) {
    await emit({ step: "Check dependencies", status: "running" });
    // Find openclaw install dir
    const whichR = await exec.exec("readlink -f $(which openclaw) 2>/dev/null");
    if (whichR.exitCode !== 0 || !whichR.stdout.trim()) {
      await emit({ step: "Check dependencies", status: "error", detail: "Cannot locate openclaw installation" });
      await rollback(exec, backupPath, configDir);
      return false;
    }
    // Strip to get install root: /dist/..., /bin/..., or trailing filename (.mjs/.js)
    const clawBin = whichR.stdout.trim();
    let installDir = clawBin.replace(/\/(dist|bin)\/.*$/, "");
    if (installDir === clawBin) {
      // No /dist/ or /bin/ found — strip trailing filename (e.g. /openclaw.mjs)
      installDir = clawBin.replace(/\/[^/]+$/, "");
    }
    const extDir = `${installDir}/${def.extensionDir}`;
    const depCheck = await exec.exec(`test -d "${extDir}/node_modules/${def.depCheckPath}" && echo yes`);
    const depsInstalled = depCheck.stdout.trim() === "yes";

    if (depsInstalled) {
      await emit({ step: "Check dependencies", status: "done", detail: "Already installed" });
    } else {
      // Step 4: Install dependencies
      await emit({ step: "Install dependencies", status: "running" });
      const lockFile = `/tmp/openclaw-channel-install-${channel}.lock`;
      const lockCheck = await exec.exec(`test -f "${lockFile}" && echo locked`);
      if (lockCheck.stdout.trim() === "locked") {
        await emit({ step: "Install dependencies", status: "error", detail: "Another install is already in progress" });
        await rollback(exec, backupPath, configDir);
        return false;
      }

      const hasSudo = (await exec.exec("command -v sudo >/dev/null 2>&1 && echo yes")).stdout.trim() === "yes";
      const prefix = hasSudo ? "sudo " : "";
      const installCmd = `touch "${lockFile}" && cd "${extDir}" && ${prefix}npm install && rm -f "${lockFile}"`;
      const installR = await execLong(exec, installCmd, 180_000);
      if (installR.exitCode !== 0) {
        await exec.exec(`rm -f "${lockFile}"`);
        await emit({ step: "Install dependencies", status: "error", detail: (installR.stderr || installR.stdout).slice(0, 200) });
        await rollback(exec, backupPath, configDir);
        return false;
      }
      await emit({ step: "Install dependencies", status: "done" });
    }
  } else {
    await emit({ step: "Check dependencies", status: "skipped", detail: "Built-in channel" });
  }

  // Step 5: Write config
  await emit({ step: "Write config", status: "running" });
  try {
    const config = await readRemoteConfig(exec, configDir);
    const updated = createChannelConfig(config, channel, input, bindAgentIds);
    await writeRemoteConfig(exec, configDir, updated);
    await emit({ step: "Write config", status: "done" });
  } catch (err: any) {
    await emit({ step: "Write config", status: "error", detail: err.message?.slice(0, 200) });
    await rollback(exec, backupPath, configDir);
    return false;
  }

  // Step 6: Restart gateway
  await emit({ step: "Restart gateway", status: "running" });
  // Find the gateway port from config or default
  const portR = await exec.exec(
    `grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "${configDir}/openclaw.json" | head -1 | grep -o '[0-9]*$'; true`,
  );
  const port = portR.stdout.trim() || "3010";

  // Kill existing process on this port
  await exec.exec(`pkill -f "openclaw.*gateway.*--port[= ]${port}" 2>/dev/null; true`);
  // Also try lsof-based kill for any leftover
  await exec.exec(`lsof -ti:${port} | xargs kill -9 2>/dev/null; true`);
  // Brief pause to let port free up
  await new Promise((r) => setTimeout(r, 1000));

  // Start gateway via nohup
  const logFile = `${configDir}/gateway.log`;
  const profileSuffix = configDir.includes("-") ? configDir.replace(/.*\.openclaw-?/, "") : "";
  const envPrefix = profileSuffix ? `OPENCLAW_PROFILE=${profileSuffix} ` : "";
  await exec.exec(
    `nohup bash -c '${envPrefix}openclaw gateway --port ${port}' >> "${logFile}" 2>&1 &`,
  );
  await emit({ step: "Restart gateway", status: "done", detail: `Port ${port}` });

  // Step 7: Verify channel
  await emit({ step: "Verify channel", status: "running" });
  await new Promise((r) => setTimeout(r, 5000));
  const tailR = await exec.exec(`tail -50 "${logFile}" 2>/dev/null`);
  const logTail = tailR.stdout || "";

  if (logTail.includes("error") && logTail.includes(channel)) {
    await emit({ step: "Verify channel", status: "error", detail: `Gateway log indicates ${channel} channel error` });
    return false;
  }

  // Check if gateway is listening
  const listenCheck = await exec.exec(`lsof -i:${port} -sTCP:LISTEN 2>/dev/null | grep -q LISTEN && echo up; true`);
  if (listenCheck.stdout.trim() === "up") {
    await emit({ step: "Verify channel", status: "done", detail: "Gateway is running" });
  } else {
    await emit({ step: "Verify channel", status: "done", detail: "Gateway started (could not confirm listener)" });
  }

  // Cleanup backup on success
  await exec.exec(`rm -f "${backupPath}"`);
  return true;
}
