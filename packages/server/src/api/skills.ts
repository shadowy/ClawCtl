import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { InstanceManager } from "../instances/manager.js";
import { requireWrite } from "../auth/middleware.js";
import { auditLog } from "../audit.js";
import {
  getBundledCatalog,
  getAllTags,
  getAllCategories,
  filterCatalog,
} from "../skills/catalog.js";

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

export function skillRoutes(db: Database.Database, manager: InstanceManager) {
  const app = new Hono();

  // ─── Read-only endpoints (any authenticated user) ───

  // GET / — returns bundled catalog + tags + categories
  app.get("/", (c) => {
    const bundled = getBundledCatalog();
    const tags = getAllTags();
    const categories = getAllCategories();
    return c.json({ bundled, tags, categories });
  });

  // GET /search?q=...&tag=...&category=...
  app.get("/search", (c) => {
    const q = c.req.query("q") || "";
    const tag = c.req.query("tag");
    const category = c.req.query("category");
    const results = filterCatalog({ query: q || undefined, tag, category });
    return c.json({ results });
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
    const body = await c.req.json();
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
    const body = await c.req.json();

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

  // POST /install — install skills to agents on remote instances
  app.post("/install", requireWrite("skills"), async (c) => {
    const body = await c.req.json();
    const { skills, targets } = body;

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
      // Verify instance exists
      const inst = manager.get(tgt.instanceId);
      if (!inst) {
        return c.json({ error: `Instance not found: ${tgt.instanceId}` }, 404);
      }
    }

    // For now, validate and acknowledge — actual SSH config modification
    // will be implemented when the executor pattern is wired up.
    const skillNames = skills.map((s: { name: string }) => s.name);
    let count = 0;
    for (const tgt of targets) {
      count += tgt.agentIds.length * skillNames.length;
    }

    auditLog(
      db,
      c,
      "skill.install",
      `Installed ${skillNames.join(", ")} to ${targets.length} instance(s)`,
    );
    return c.json({ ok: true, installed: count });
  });

  // DELETE /uninstall — remove skills from agents
  app.delete("/uninstall", requireWrite("skills"), async (c) => {
    const body = await c.req.json();
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

    // For now, validate and acknowledge
    let count = 0;
    for (const tgt of targets) {
      count += tgt.agentIds.length * skills.length;
    }

    auditLog(
      db,
      c,
      "skill.uninstall",
      `Uninstalled ${skills.join(", ")} from ${targets.length} instance(s)`,
    );
    return c.json({ ok: true, removed: count });
  });

  return app;
}
