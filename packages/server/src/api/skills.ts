import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { InstanceManager } from "../instances/manager.js";
import type { HostStore } from "../hosts/store.js";
import { getHostExecutor } from "../executor/factory.js";
import { requireWrite } from "../auth/middleware.js";
import { auditLog } from "../audit.js";
import {
  getBundledCatalog,
  getAllTags,
  getAllCategories,
  filterCatalog,
  searchClawHub,
  fetchClawHubDetail,
} from "../skills/catalog.js";
import { getInstallCommand, getUnsupportedReason } from "../skills/install-map.js";

interface TemplateRow {
  id: string;
  name: string;
  name_zh: string;
  description: string;
  description_zh: string;
  icon: string;
  skills: string;
  builtin: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function skillRoutes(db: Database.Database, manager: InstanceManager, hostStore?: HostStore) {
  const app = new Hono();

  // ─── Read-only endpoints (any authenticated user) ───

  // GET / — returns bundled catalog + tags + categories
  app.get("/", (c) => {
    const bundled = getBundledCatalog();
    const tags = getAllTags();
    const categories = getAllCategories();
    return c.json({ bundled, tags, categories });
  });

  // GET /search?q=...&tag=...&category=...&offset=...&limit=... — searches bundled + ClawHub marketplace
  app.get("/search", async (c) => {
    const q = c.req.query("q") || "";
    const tag = c.req.query("tag");
    const category = c.req.query("category");
    const offset = parseInt(c.req.query("offset") || "0") || 0;
    const limit = Math.min(parseInt(c.req.query("limit") || "20") || 20, 50);
    const bundled = filterCatalog({ query: q || undefined, tag, category });

    // Also search ClawHub marketplace when there's a text query
    let clawhub: Awaited<ReturnType<typeof searchClawHub>> = [];
    let clawhubError: string | undefined;
    if (q.trim()) {
      try {
        clawhub = await searchClawHub(q, limit, offset);
      } catch (e: any) {
        clawhubError = e.message === "rate_limited" ? "rate_limited" : "unavailable";
      }
      // Deduplicate: remove ClawHub results that already exist in bundled
      const bundledNames = new Set(bundled.map((b) => b.name));
      clawhub = clawhub.filter((ch) => !bundledNames.has(ch.name));
    }

    return c.json({ results: bundled, clawhub, hasMore: clawhub.length === limit, clawhubError });
  });

  // GET /clawhub/details?slugs=a,b,c — batch fetch stats for ClawHub skills
  app.get("/clawhub/details", async (c) => {
    const slugsParam = c.req.query("slugs") || "";
    const slugs = slugsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);
    if (slugs.length === 0) return c.json({ details: {} });

    const results = await Promise.all(slugs.map((s) => fetchClawHubDetail(s).then((d) => [s, d] as const)));
    const details: Record<string, { downloads: number; stars: number; installs: number; author?: string }> = {};
    for (const [slug, d] of results) {
      if (d) details[slug] = d;
    }
    return c.json({ details });
  });

  // GET /templates — list all templates sorted by sort_order
  app.get("/templates", (c) => {
    const rows = db
      .prepare("SELECT * FROM skill_templates ORDER BY sort_order")
      .all() as TemplateRow[];
    const templates = rows.map((r) => ({
      ...r,
      skills: JSON.parse(r.skills),
    }));
    return c.json({ templates });
  });

  // ─── Write endpoints (require skills write permission) ───

  // POST /templates — create a custom template
  app.post("/templates", requireWrite("skills"), async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const { id, name, name_zh, description, description_zh, icon, skills, sort_order } = body;

    if (!id || !name || !name_zh || !description || !description_zh) {
      return c.json(
        { error: "id, name, name_zh, description, description_zh are required" },
        400,
      );
    }
    if (!skills || !Array.isArray(skills) || skills.length === 0) {
      return c.json({ error: "skills must be a non-empty array" }, 400);
    }

    // Check for duplicate id
    const existing = db
      .prepare("SELECT id FROM skill_templates WHERE id = ?")
      .get(id) as { id: string } | undefined;
    if (existing) {
      return c.json({ error: "Template id already exists" }, 409);
    }

    // Determine sort_order: use provided or max+1
    const maxRow = db
      .prepare("SELECT MAX(sort_order) as mx FROM skill_templates")
      .get() as { mx: number | null };
    const order = sort_order ?? (maxRow.mx != null ? maxRow.mx + 1 : 1);

    db.prepare(
      `INSERT INTO skill_templates (id, name, name_zh, description, description_zh, icon, skills, builtin, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(id, name, name_zh, description, description_zh, icon || "", JSON.stringify(skills), order);

    auditLog(db, c, "skill.template.create", `Created skill template: ${name} (${id})`);
    return c.json({ id }, 201);
  });

  // PUT /templates/:id — update template
  app.put("/templates/:id", requireWrite("skills"), async (c) => {
    const id = c.req.param("id");
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

    const existing = db
      .prepare("SELECT id FROM skill_templates WHERE id = ?")
      .get(id) as { id: string } | undefined;
    if (!existing) {
      return c.json({ error: "Template not found" }, 404);
    }

    // Build SET clause dynamically for provided fields
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) { updates.push("name = ?"); values.push(body.name); }
    if (body.name_zh !== undefined) { updates.push("name_zh = ?"); values.push(body.name_zh); }
    if (body.description !== undefined) { updates.push("description = ?"); values.push(body.description); }
    if (body.description_zh !== undefined) { updates.push("description_zh = ?"); values.push(body.description_zh); }
    if (body.icon !== undefined) { updates.push("icon = ?"); values.push(body.icon); }
    if (body.skills !== undefined) { updates.push("skills = ?"); values.push(JSON.stringify(body.skills)); }
    if (body.sort_order !== undefined) { updates.push("sort_order = ?"); values.push(body.sort_order); }

    if (updates.length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`UPDATE skill_templates SET ${updates.join(", ")} WHERE id = ?`).run(...values);

    auditLog(db, c, "skill.template.update", `Updated skill template: ${id}`);
    return c.json({ ok: true });
  });

  // DELETE /templates/:id — delete template (builtin templates cannot be deleted)
  app.delete("/templates/:id", requireWrite("skills"), (c) => {
    const id = c.req.param("id");

    const row = db
      .prepare("SELECT id, builtin FROM skill_templates WHERE id = ?")
      .get(id) as { id: string; builtin: number } | undefined;
    if (!row) {
      return c.json({ error: "Template not found" }, 404);
    }
    if (row.builtin === 1) {
      return c.json({ error: "Cannot delete built-in template" }, 403);
    }

    db.prepare("DELETE FROM skill_templates WHERE id = ?").run(id);
    auditLog(db, c, "skill.template.delete", `Deleted skill template: ${id}`);
    return c.json({ ok: true });
  });

  // ─── Shared helper: patch agent skills via Gateway RPC config.patch ───

  async function patchAgentSkills(
    instanceId: string,
    agentIds: string[],
    skillNames: string[],
    mode: "add" | "remove",
  ): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
    const client = manager.getClient(instanceId);
    if (!client) return { ok: false, error: "Instance not connected" };

    // 1. Read current config to get hash and agent skill lists
    const configRes = await client.rpc("config.get", {});
    const hash: string | undefined = configRes?.hash;
    const parsed = configRes?.parsed || {};
    const agentList: any[] = parsed?.agents?.list || [];

    // 2. Build merge-patch entries for each target agent
    const patchAgents: { id: string; skills: string[] }[] = [];
    for (const agentId of agentIds) {
      const agentCfg = agentList.find(
        (a: any) => a.id?.toLowerCase() === agentId.toLowerCase(),
      );
      const existing: string[] = agentCfg?.skills || [];

      let newSkills: string[];
      if (mode === "add") {
        // If agent has no skills allowlist, adding creates one —
        // include all currently-available skills so we don't restrict the agent
        if (existing.length === 0 && !agentCfg?.skills) {
          // No allowlist = all skills available, adding is a no-op for config
          // but we still want to ensure the skill is enabled globally
          continue;
        }
        const merged = new Set(existing);
        for (const name of skillNames) merged.add(name);
        newSkills = Array.from(merged);
        if (newSkills.length === existing.length) continue; // nothing to add
      } else {
        newSkills = existing.filter((s) => !skillNames.includes(s));
        if (newSkills.length === existing.length) continue; // nothing to remove
      }

      patchAgents.push({ id: agentCfg?.id || agentId, skills: newSkills });
    }

    // If no config changes needed (e.g. all agents have no allowlist),
    // return success — the skills are already globally available
    if (patchAgents.length === 0) {
      return { ok: true, skipped: true };
    }

    // 3. Send config.patch with merge-patch
    // mergeObjectArraysById: true means { agents: { list: [{id, skills}] } }
    // will find matching agents by id and merge the skills field
    const patch = { agents: { list: patchAgents } };
    const patchParams: Record<string, unknown> = {
      raw: JSON.stringify(patch),
      restartDelayMs: 2000,
    };
    if (hash) patchParams.baseHash = hash;

    await client.rpc("config.patch", patchParams);
    return { ok: true };
  }

  // POST /install — install skills to agents on remote instances (SSE stream)
  // Returns text/event-stream with real-time progress events:
  //   event: step   → { instanceId, skill?, message }
  //   event: skill  → { instanceId, name, installed, error?, warnings? }
  //   event: instance → { instanceId, ok, skipped? }
  //   event: done   → { ok, results }
  app.post("/install", requireWrite("skills"), async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const { skills, targets, force } = body;
    const forceInstall = !!force;

    // Validate request body
    if (!skills || !Array.isArray(skills) || skills.length === 0) {
      return c.json({ error: "skills must be a non-empty array of {name, source}" }, 400);
    }
    for (const sk of skills) {
      if (!sk.name || !sk.source) {
        return c.json({ error: "Each skill must have name and source" }, 400);
      }
    }
    if (!targets || !Array.isArray(targets) || targets.length === 0) {
      return c.json({ error: "targets must be a non-empty array of {instanceId, agentIds}" }, 400);
    }
    for (const tgt of targets) {
      if (!tgt.instanceId || !tgt.agentIds || !Array.isArray(tgt.agentIds) || tgt.agentIds.length === 0) {
        return c.json({ error: "Each target must have instanceId and non-empty agentIds array" }, 400);
      }
      const inst = manager.get(tgt.instanceId);
      if (!inst) {
        return c.json({ error: `Instance not found: ${tgt.instanceId}` }, 404);
      }
    }

    const skillNames = skills.map((s: { name: string }) => s.name);
    const skillSourceMap = new Map<string, string>();
    for (const sk of skills) skillSourceMap.set(sk.name, sk.source);
    type SkillInstallDetail = { name: string; installed: boolean; error?: string; warnings?: string[]; suspicious?: boolean };

    // Return SSE stream
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    function send(event: string, data: unknown) {
      const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      writer.write(encoder.encode(line)).catch(() => {});
    }

    // Run install logic in background, streaming events
    (async () => {
      // Extended PATH for SSH which checks (non-login shell misses user bin dirs)
      const EXT_PATH = "PATH=$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$HOME/.npm-global/bin:$PATH";

      // Check if binaries already exist on remote host via SSH
      async function sshCheckBins(instanceId: string, bins: string[]): Promise<boolean> {
        if (!hostStore) return false;
        const match = instanceId.match(/^ssh-(\d+)-/);
        if (!match) return false;
        const hostId = parseInt(match[1]);
        try {
          const executor = getHostExecutor(hostId, hostStore);
          const checkCmd = `${EXT_PATH}; ${bins.map((b) => `which ${b}`).join(" && ")}`;
          const res = await executor.exec(checkCmd, { timeout: 10_000 });
          return res.exitCode === 0;
        } catch {
          return false;
        }
      }

      // SSH fallback helper — uses install-map to determine correct method per binary
      type SshInstallResult = { ok: boolean; error?: string; alreadyInstalled?: boolean; suspicious?: boolean; details?: string[] };
      async function sshInstallBins(instanceId: string, bins: string[], emitStep?: (msg: string) => void): Promise<SshInstallResult> {
        if (!hostStore) return { ok: false, error: "No host store configured" };
        const match = instanceId.match(/^ssh-(\d+)-/);
        if (!match) return { ok: false, error: "Not an SSH instance" };
        const hostId = parseInt(match[1]);
        try {
          const executor = getHostExecutor(hostId, hostStore);

          // Check if all bins already exist
          const checkCmd = `${EXT_PATH}; ${bins.map((b) => `which ${b}`).join(" && ")}`;
          const checkRes = await executor.exec(checkCmd, { timeout: 10_000 });
          if (checkRes.exitCode === 0) return { ok: true, alreadyInstalled: true };

          // Detect OS
          const osRes = await executor.exec("uname -s", { timeout: 10_000 });
          const osName = osRes.stdout.trim().toLowerCase();
          const os: "linux" | "darwin" = osName === "darwin" ? "darwin" : "linux";

          // Detect available package managers (parallel, with extended PATH)
          const detect = async (cmd: string) =>
            executor.exec(`${EXT_PATH}; ${cmd}`, { timeout: 5_000 }).then((r) => r.exitCode === 0).catch(() => false);
          let [hasApt, hasGo, hasNpm, hasCargo, hasPip, hasPipx] = await Promise.all([
            detect("which apt-get"),
            detect("which go"),
            detect("which npm"),
            detect("which cargo"),
            detect("which pip3 || which pip"),
            detect("which pipx"),
          ]);

          // Find which bins are actually missing
          const missingBins: string[] = [];
          for (const bin of bins) {
            const exists = await executor.exec(`${EXT_PATH}; which ${bin}`, { timeout: 5_000 });
            if (exists.exitCode !== 0) missingBins.push(bin);
          }
          if (missingBins.length === 0) return { ok: true, alreadyInstalled: true };

          // Determine which toolchains are needed but missing, then auto-install them
          const available = { apt: hasApt, go: hasGo, npm: hasNpm, cargo: hasCargo, pip: hasPip, pipx: hasPipx };
          const neededToolchains = new Set<string>();
          for (const bin of missingBins) {
            const spec = getInstallCommand(bin, os, available);
            if (!spec) {
              // Check what toolchain WOULD work if available
              const specIfAll = getInstallCommand(bin, os, { apt: true, go: true, npm: true, cargo: true, pip: true, pipx: true });
              if (specIfAll) {
                if (specIfAll.label.startsWith("go:") && !hasGo) neededToolchains.add("go");
                else if (specIfAll.label.startsWith("npm:") && !hasNpm) neededToolchains.add("npm");
                else if (specIfAll.label.startsWith("cargo:") && !hasCargo) neededToolchains.add("cargo");
                else if (specIfAll.label.startsWith("pip:") && !hasPip) neededToolchains.add("pip");
              }
            }
          }

          const details: string[] = [];

          // Auto-install missing toolchains
          if (neededToolchains.size > 0 && hasApt) {
            for (const tc of neededToolchains) {
              if (tc === "go" && !hasGo) {
                emitStep?.("Installing Go toolchain...");
                const r = await executor.exec("sudo apt-get update -qq && sudo apt-get install -y golang-go", { timeout: 120_000 });
                if (r.exitCode === 0) { hasGo = true; details.push("Installed Go (apt)"); }
              } else if (tc === "npm" && !hasNpm) {
                emitStep?.("Installing Node.js + npm...");
                const r = await executor.exec("sudo apt-get update -qq && sudo apt-get install -y nodejs npm", { timeout: 120_000 });
                if (r.exitCode === 0) { hasNpm = true; details.push("Installed Node.js (apt)"); }
              } else if (tc === "cargo" && !hasCargo) {
                emitStep?.("Installing Rust toolchain...");
                const r = await executor.exec(
                  "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && . $HOME/.cargo/env && which cargo",
                  { timeout: 180_000 },
                );
                if (r.exitCode === 0) { hasCargo = true; details.push("Installed Rust/Cargo (rustup)"); }
              } else if (tc === "pip" && !hasPip) {
                emitStep?.("Installing pip3 + pipx...");
                const r = await executor.exec("sudo apt-get update -qq && sudo apt-get install -y python3-pip pipx", { timeout: 120_000 });
                if (r.exitCode === 0) { hasPip = true; hasPipx = true; details.push("Installed pip3 + pipx (apt)"); }
              }
            }
          }

          // Auto-install pipx if pip packages are needed but pipx isn't available (PEP 668 on Ubuntu 24.04+)
          if (!hasPipx && hasApt) {
            // Check if any missing bin needs pip
            const needsPip = missingBins.some((b) => {
              const spec = getInstallCommand(b, os, { apt: true, go: true, npm: true, cargo: true, pip: true, pipx: true });
              return spec?.label.startsWith("pipx:") || spec?.label.startsWith("pip:");
            });
            if (needsPip) {
              emitStep?.("Installing pipx...");
              const r = await executor.exec("sudo apt-get update -qq && sudo apt-get install -y pipx", { timeout: 60_000 });
              if (r.exitCode === 0) { hasPipx = true; details.push("Installed pipx (apt)"); }
            }
          }

          // Refresh available after toolchain installs
          const avail = { apt: hasApt, go: hasGo, npm: hasNpm, cargo: hasCargo, pip: hasPip, pipx: hasPipx };

          // Install each missing binary using the appropriate method
          const failed: string[] = [];

          // Group apt packages to install in one batch
          const aptBins: string[] = [];
          const otherBins: { bin: string; cmd: string; label: string }[] = [];
          const unsupported: { bin: string; reason: string }[] = [];

          for (const bin of missingBins) {
            const spec = getInstallCommand(bin, os, avail);
            if (!spec) {
              unsupported.push({ bin, reason: getUnsupportedReason(bin, os) });
              continue;
            }
            if (spec.label.startsWith("apt:")) {
              aptBins.push(spec.label.slice(5)); // extract package name
            } else {
              otherBins.push({ bin, ...spec });
            }
          }

          // Batch apt install
          if (aptBins.length > 0) {
            const pkgs = aptBins.join(" ");
            emitStep?.(`apt-get install ${pkgs}`);
            const res = await executor.exec(
              `sudo apt-get update -qq && sudo apt-get install -y ${pkgs}`,
              { timeout: 120_000 },
            );
            if (res.exitCode === 0) {
              details.push(`apt: ${pkgs}`);
            } else {
              failed.push(...aptBins.map((p) => `apt:${p}`));
              details.push(`apt failed: ${res.stderr.slice(0, 200)}`);
            }
          }

          // Install non-apt tools one by one
          for (const { bin, cmd, label } of otherBins) {
            emitStep?.(`${label}`);
            // For cargo commands, ensure .cargo/env is sourced
            const finalCmd = label.startsWith("cargo:") ? `. $HOME/.cargo/env 2>/dev/null; ${cmd}` : cmd;
            // Cargo compiles from source (slow); Go downloads and compiles
            const timeout = label.startsWith("cargo:") ? 600_000 : label.startsWith("go:") ? 300_000 : 180_000;
            const res = await executor.exec(finalCmd, { timeout });
            if (res.exitCode === 0) {
              details.push(label);
            } else {
              failed.push(bin);
              details.push(`${label} failed (exit ${res.exitCode})`);
            }
          }

          if (unsupported.length > 0) {
            failed.push(...unsupported.map((u) => u.bin));
            for (const u of unsupported) details.push(`${u.bin}: ${u.reason}`);
          }

          if (failed.length === 0) return { ok: true, details };

          // Build descriptive error: use specific reasons for unsupported binaries
          const unsupportedNames = new Set(unsupported.map((u) => u.bin));
          const realFailed = failed.filter((f) => !unsupportedNames.has(f));

          let error: string;
          if (realFailed.length === 0) {
            // All failures are unsupported — show reasons
            error = unsupported.map((u) => u.reason).join("; ");
          } else {
            // Mix of real failures and unsupported — show failed names + reasons
            const parts = realFailed.map((f) => f);
            for (const u of unsupported) parts.push(`${u.bin} (${u.reason})`);
            error = `Failed: ${parts.join(", ")}`;
          }

          return { ok: false, error, details };
        } catch (err: any) {
          return { ok: false, error: `SSH: ${err.message}` };
        }
      }

      // SSH helper: install a ClawHub community skill via clawhub CLI
      async function sshInstallClawHubSkill(
        instanceId: string,
        slug: string,
        emitStep?: (msg: string) => void,
        force?: boolean,
      ): Promise<SshInstallResult> {
        if (!hostStore) return { ok: false, error: "No host store configured" };
        const match = instanceId.match(/^ssh-(\d+)-/);
        if (!match) return { ok: false, error: "Not an SSH instance" };
        const hostId = parseInt(match[1]);
        try {
          const executor = getHostExecutor(hostId, hostStore);

          // Check if clawhub CLI is available
          const hasClawHub = await executor
            .exec(`${EXT_PATH}; which clawhub`, { timeout: 10_000 })
            .then((r) => r.exitCode === 0)
            .catch(() => false);

          if (!hasClawHub) {
            // Check if npm is available to install clawhub
            const hasNpm = await executor
              .exec(`${EXT_PATH}; which npm`, { timeout: 10_000 })
              .then((r) => r.exitCode === 0)
              .catch(() => false);
            if (!hasNpm) {
              return { ok: false, error: "npm not available — cannot install clawhub CLI" };
            }
            emitStep?.("Installing clawhub CLI...");
            const installRes = await executor.exec(
              `${EXT_PATH}; npm install -g clawhub`,
              { timeout: 120_000 },
            );
            if (installRes.exitCode !== 0) {
              return { ok: false, error: `Failed to install clawhub CLI: ${installRes.stderr.slice(0, 200)}` };
            }
          }

          // Check if already installed
          const checkRes = await executor.exec(
            `test -d ~/.openclaw/skills/${slug}`,
            { timeout: 10_000 },
          );
          if (checkRes.exitCode === 0) {
            return { ok: true, alreadyInstalled: true, details: [`${slug}: already installed`] };
          }

          // Install the community skill
          const forceFlag = force ? " --force" : "";
          const baseCmd = `${EXT_PATH}; clawhub --workdir ~/.openclaw install ${slug} --no-input${forceFlag}`;
          emitStep?.(`clawhub install ${slug}...`);
          let res = await executor.exec(`${baseCmd} 2>&1`, { timeout: 180_000 });
          const out = res.stdout + res.stderr;

          // Already installed → success
          if (out.includes("Already installed")) {
            return { ok: true, alreadyInstalled: true, details: [`${slug}: already installed`] };
          }

          // Suspicious skill flagged by VirusTotal → stop and require user confirmation
          if (res.exitCode !== 0 && out.includes("suspicious")) {
            return { ok: false, suspicious: true, error: "Flagged as suspicious by VirusTotal. Review before installing." };
          }

          // Other failure → retry once
          if (res.exitCode !== 0) {
            emitStep?.(`Retrying clawhub install ${slug}...`);
            await new Promise((r) => setTimeout(r, 2000));
            res = await executor.exec(`${baseCmd} 2>&1`, { timeout: 180_000 });
          }

          if (res.exitCode === 0) {
            return { ok: true, details: [`clawhub: ${slug}`] };
          }
          // Show combined output for diagnostics (spinner chars stripped)
          const output = (res.stdout + res.stderr).replace(/\r/g, "\n").trim();
          return { ok: false, error: `clawhub install failed (exit ${res.exitCode}): ${output.slice(0, 300)}` };
        } catch (err: any) {
          return { ok: false, error: `SSH: ${err.message}` };
        }
      }

      // Host deduplication
      const hostInstalled = new Map<string, Map<string, SkillInstallDetail>>();
      function getHostKey(instanceId: string): string {
        const inst = manager.get(instanceId);
        if (!inst) return instanceId;
        try { return new URL(inst.connection.url).hostname; } catch { return inst.connection.url; }
      }

      type InstallResult = { instanceId: string; ok: boolean; error?: string; skipped?: boolean; skillResults?: SkillInstallDetail[] };
      const results: InstallResult[] = [];

      for (const tgt of targets) {
        const client = manager.getClient(tgt.instanceId);
        if (!client) {
          send("instance", { instanceId: tgt.instanceId, ok: false, error: "Not connected" });
          results.push({ instanceId: tgt.instanceId, ok: false, error: "Not connected" });
          continue;
        }

        const hostKey = getHostKey(tgt.instanceId);
        const priorInstalls = hostInstalled.get(hostKey);
        const skillResults: SkillInstallDetail[] = [];
        let hasError = false;

        try {
          send("step", { instanceId: tgt.instanceId, message: "Checking skill status..." });
          const statusRes = await client.rpc("skills.status", {});
          const statusSkills: any[] = statusRes?.skills || [];

          for (const skillName of skillNames) {
            if (priorInstalls?.has(skillName)) {
              const prior = priorInstalls.get(skillName)!;
              skillResults.push(prior);
              send("skill", { instanceId: tgt.instanceId, ...prior });
              if (!prior.installed) hasError = true;
              continue;
            }

            // ── ClawHub community skill: install via clawhub CLI over SSH ──
            if (skillSourceMap.get(skillName) === "clawhub") {
              const emitSkillStep = (msg: string) => send("step", { instanceId: tgt.instanceId, skill: skillName, message: msg });
              emitSkillStep(`Installing community skill ${skillName}...`);
              let sshRes = await sshInstallClawHubSkill(tgt.instanceId, skillName, emitSkillStep, forceInstall);

              // Retry once on SSH connection errors
              if (!sshRes.ok && !sshRes.suspicious && sshRes.error?.startsWith("SSH:") && !sshRes.error?.includes("Command timeout")) {
                emitSkillStep("Retrying SSH connection...");
                await new Promise((r) => setTimeout(r, 3000));
                sshRes = await sshInstallClawHubSkill(tgt.instanceId, skillName, emitSkillStep, forceInstall);
              }

              if (sshRes.suspicious) {
                // Flagged by VirusTotal — report to frontend for user confirmation
                const r: SkillInstallDetail = { name: skillName, installed: false, suspicious: true, error: sshRes.error };
                skillResults.push(r);
                send("skill", { instanceId: tgt.instanceId, ...r });
                hasError = true;
              } else if (sshRes.ok) {
                const r: SkillInstallDetail = { name: skillName, installed: true, warnings: sshRes.details };
                skillResults.push(r);
                send("skill", { instanceId: tgt.instanceId, ...r });
              } else {
                const r: SkillInstallDetail = { name: skillName, installed: false, error: sshRes.error, warnings: sshRes.details };
                skillResults.push(r);
                send("skill", { instanceId: tgt.instanceId, ...r });
                hasError = true;
              }
              continue;
            }

            // ── Bundled skill: use Gateway RPC + SSH binary install ──
            const statusEntry = statusSkills.find((s: any) => s.name === skillName);

            if (statusEntry?.eligible) {
              const r: SkillInstallDetail = { name: skillName, installed: true };
              skillResults.push(r);
              send("skill", { instanceId: tgt.instanceId, ...r });
              continue;
            }

            const installOptions: any[] = statusEntry?.install || [];
            const missing: any = statusEntry?.missing || {};
            const missingBins: string[] = missing?.bins || [];
            let installed = false;

            // Pre-check: if bins are already present on host (SSH), skip install entirely
            if (missingBins.length > 0) {
              const alreadyPresent = await sshCheckBins(tgt.instanceId, missingBins);
              if (alreadyPresent) {
                const r: SkillInstallDetail = { name: skillName, installed: true };
                skillResults.push(r);
                send("skill", { instanceId: tgt.instanceId, ...r });
                continue;
              }
            }

            if (installOptions.length > 0) {
              const opt = installOptions[0];
              send("step", { instanceId: tgt.instanceId, skill: skillName, message: `Installing ${skillName} via ${opt.kind || "RPC"}...` });
              try {
                const installRes = await client.rpc("skills.install", { name: skillName, installId: opt.id, timeoutMs: 120_000 });
                if (installRes?.ok) {
                  const r: SkillInstallDetail = { name: skillName, installed: true, warnings: installRes.warnings };
                  skillResults.push(r);
                  send("skill", { instanceId: tgt.instanceId, ...r });
                  installed = true;
                }
              } catch {
                // RPC failed — try SSH fallback
              }
            }

            if (!installed && missingBins.length > 0) {
              const emitSkillStep = (msg: string) => send("step", { instanceId: tgt.instanceId, skill: skillName, message: msg });
              emitSkillStep(`Installing ${missingBins.join(", ")} via SSH...`);
              let sshRes = await sshInstallBins(tgt.instanceId, missingBins, emitSkillStep);

              // Retry once on SSH connection errors (not command timeouts)
              if (!sshRes.ok && sshRes.error?.startsWith("SSH:") && !sshRes.error?.includes("Command timeout")) {
                emitSkillStep("Retrying SSH connection...");
                await new Promise((r) => setTimeout(r, 3000));
                sshRes = await sshInstallBins(tgt.instanceId, missingBins, emitSkillStep);
              }

              if (sshRes.ok) {
                const warnings = sshRes.alreadyInstalled ? undefined : sshRes.details;
                const r: SkillInstallDetail = { name: skillName, installed: true, warnings };
                skillResults.push(r);
                send("skill", { instanceId: tgt.instanceId, ...r });
                installed = true;
              } else {
                const r: SkillInstallDetail = { name: skillName, installed: false, error: sshRes.error || `Missing: ${missingBins.join(", ")}`, warnings: sshRes.details };
                skillResults.push(r);
                send("skill", { instanceId: tgt.instanceId, ...r });
                hasError = true;
              }
            } else if (!installed) {
              const r: SkillInstallDetail = { name: skillName, installed: true };
              skillResults.push(r);
              send("skill", { instanceId: tgt.instanceId, ...r });
            }
          }

          if (!hostInstalled.has(hostKey)) {
            const m = new Map<string, SkillInstallDetail>();
            for (const sr of skillResults) m.set(sr.name, sr);
            hostInstalled.set(hostKey, m);
          }

          send("step", { instanceId: tgt.instanceId, message: "Updating config..." });
          const patchRes = await patchAgentSkills(tgt.instanceId, tgt.agentIds, skillNames, "add");
          const instResult: InstallResult = {
            instanceId: tgt.instanceId,
            ok: !hasError && patchRes.ok,
            skipped: patchRes.skipped,
            skillResults,
          };
          results.push(instResult);
          send("instance", instResult);
        } catch (err: any) {
          const instResult: InstallResult = { instanceId: tgt.instanceId, ok: false, error: err.message, skillResults };
          results.push(instResult);
          send("instance", instResult);
        }
      }

      const allOk = results.every((r) => r.ok);
      auditLog(db, c, "skill.install",
        `Installed ${skillNames.join(", ")} to ${targets.length} instance(s)${allOk ? "" : " (partial failure)"}`);
      send("done", { ok: allOk, results });
      writer.close().catch(() => {});
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  // DELETE /uninstall — remove skills from agents
  app.delete("/uninstall", requireWrite("skills"), async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const { skills, targets } = body;

    // Validate request body
    if (!skills || !Array.isArray(skills) || skills.length === 0) {
      return c.json({ error: "skills must be a non-empty array of skill names" }, 400);
    }
    for (const sk of skills) {
      if (typeof sk !== "string" || !sk) {
        return c.json({ error: "Each skill must be a non-empty string" }, 400);
      }
    }
    if (!targets || !Array.isArray(targets) || targets.length === 0) {
      return c.json({ error: "targets must be a non-empty array of {instanceId, agentIds}" }, 400);
    }
    for (const tgt of targets) {
      if (!tgt.instanceId || !tgt.agentIds || !Array.isArray(tgt.agentIds) || tgt.agentIds.length === 0) {
        return c.json({ error: "Each target must have instanceId and non-empty agentIds array" }, 400);
      }
      const inst = manager.get(tgt.instanceId);
      if (!inst) {
        return c.json({ error: `Instance not found: ${tgt.instanceId}` }, 404);
      }
    }

    const results: { instanceId: string; ok: boolean; error?: string; skipped?: boolean }[] = [];

    for (const tgt of targets) {
      try {
        const res = await patchAgentSkills(tgt.instanceId, tgt.agentIds, skills, "remove");
        results.push({ instanceId: tgt.instanceId, ...res });
      } catch (err: any) {
        results.push({ instanceId: tgt.instanceId, ok: false, error: err.message });
      }
    }

    const allOk = results.every((r) => r.ok);
    auditLog(
      db,
      c,
      "skill.uninstall",
      `Uninstalled ${skills.join(", ")} from ${targets.length} instance(s)${allOk ? "" : " (partial failure)"}`,
    );
    return c.json({ ok: allOk, results });
  });

  return app;
}
