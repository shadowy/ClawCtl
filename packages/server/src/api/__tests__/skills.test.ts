import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { skillRoutes } from "../skills.js";
import { seedTemplates } from "../../skills/templates-seed.js";
import { MockInstanceManager } from "../../__tests__/helpers/mock-instance-manager.js";
import { mockAuthMiddleware } from "../../__tests__/helpers/mock-auth.js";
import { makeInstanceInfo } from "../../__tests__/helpers/fixtures.js";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_zh TEXT NOT NULL,
      description TEXT NOT NULL,
      description_zh TEXT NOT NULL,
      icon TEXT DEFAULT '',
      skills TEXT NOT NULL DEFAULT '[]',
      builtin INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      output TEXT DEFAULT '',
      operator TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    );
  `);
  return db;
}

describe("Skills API routes", () => {
  let app: Hono;
  let db: Database.Database;
  let manager: MockInstanceManager;

  beforeEach(() => {
    db = createTestDb();
    seedTemplates(db);
    manager = new MockInstanceManager();
    app = new Hono();
    app.use("/*", mockAuthMiddleware());
    app.route("/skills", skillRoutes(db, manager as any));
  });

  // ─── GET / (catalog) ───

  describe("GET / (catalog)", () => {
    it("returns bundled catalog, tags, and categories", async () => {
      const res = await app.request("/skills");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.bundled).toBeDefined();
      expect(Array.isArray(data.bundled)).toBe(true);
      expect(data.bundled.length).toBe(52);
      expect(Array.isArray(data.tags)).toBe(true);
      expect(data.tags.length).toBeGreaterThan(0);
      expect(Array.isArray(data.categories)).toBe(true);
      expect(data.categories).toContain("dev");
    });
  });

  // ─── GET /search ───

  describe("GET /search", () => {
    it("searches by query", async () => {
      const res = await app.request("/skills/search?q=github");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.results.length).toBeGreaterThanOrEqual(1);
      const names = data.results.map((r: any) => r.name);
      expect(names).toContain("github");
    });

    it("filters by tag", async () => {
      const res = await app.request("/skills/search?tag=macos");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      for (const entry of data.results) {
        expect(entry.tags).toContain("macos");
      }
    });

    it("filters by category", async () => {
      const res = await app.request("/skills/search?category=dev");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.results.length).toBeGreaterThan(0);
      for (const entry of data.results) {
        expect(entry.category).toBe("dev");
      }
    });

    it("returns empty results for no match", async () => {
      const res = await app.request("/skills/search?q=nonexistent-xyz-99999");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.results).toEqual([]);
    });

    it("returns all when no filters", async () => {
      const res = await app.request("/skills/search");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.results.length).toBe(52);
    });
  });

  // ─── GET /templates ───

  describe("GET /templates", () => {
    it("returns all seeded templates sorted by sort_order", async () => {
      const res = await app.request("/skills/templates");
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.templates.length).toBe(15);
      // Check ordering
      for (let i = 1; i < data.templates.length; i++) {
        expect(data.templates[i].sort_order).toBeGreaterThanOrEqual(
          data.templates[i - 1].sort_order,
        );
      }
    });

    it("returns parsed skills arrays (not raw JSON strings)", async () => {
      const res = await app.request("/skills/templates");
      const data = await res.json() as any;
      for (const tpl of data.templates) {
        expect(Array.isArray(tpl.skills)).toBe(true);
        expect(tpl.skills.length).toBeGreaterThan(0);
        expect(tpl.skills[0]).toHaveProperty("name");
      }
    });
  });

  // ─── POST /templates ───

  describe("POST /templates", () => {
    const validTemplate = {
      id: "custom-test",
      name: "Custom Test",
      name_zh: "自定义测试",
      description: "A test template",
      description_zh: "测试模板",
      icon: "star",
      skills: [{ name: "github", source: "bundled", note: "GH" }],
    };

    it("creates a custom template", async () => {
      const res = await app.request("/skills/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validTemplate),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.id).toBe("custom-test");

      // Verify it's in DB
      const row = db.prepare("SELECT * FROM skill_templates WHERE id = ?").get("custom-test") as any;
      expect(row.name).toBe("Custom Test");
      expect(row.builtin).toBe(0);
    });

    it("returns 400 for missing required fields", async () => {
      const res = await app.request("/skills/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "x" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for empty skills array", async () => {
      const res = await app.request("/skills/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validTemplate, skills: [] }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 409 for duplicate id", async () => {
      // "engineering" already exists from seed
      const res = await app.request("/skills/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validTemplate, id: "engineering" }),
      });
      expect(res.status).toBe(409);
    });

    it("auto-assigns sort_order when not provided", async () => {
      await app.request("/skills/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validTemplate),
      });
      const row = db.prepare("SELECT sort_order FROM skill_templates WHERE id = ?").get("custom-test") as any;
      // Builtin templates have sort_order 1-15, so this should be 16
      expect(row.sort_order).toBe(16);
    });

    it("creates audit log entry", async () => {
      await app.request("/skills/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validTemplate),
      });
      const ops = db.prepare("SELECT * FROM operations WHERE type = 'skill.template.create'").all() as any[];
      expect(ops.length).toBe(1);
      expect(ops[0].output).toContain("Custom Test");
    });
  });

  // ─── PUT /templates/:id ───

  describe("PUT /templates/:id", () => {
    it("updates template fields", async () => {
      const res = await app.request("/skills/templates/engineering", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Engineering v2", icon: "hammer" }),
      });
      expect(res.status).toBe(200);

      const row = db.prepare("SELECT name, icon FROM skill_templates WHERE id = ?").get("engineering") as any;
      expect(row.name).toBe("Engineering v2");
      expect(row.icon).toBe("hammer");
    });

    it("updates skills array", async () => {
      const newSkills = [{ name: "tmux", source: "bundled", note: "Terminal" }];
      const res = await app.request("/skills/templates/engineering", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skills: newSkills }),
      });
      expect(res.status).toBe(200);

      const row = db.prepare("SELECT skills FROM skill_templates WHERE id = ?").get("engineering") as any;
      expect(JSON.parse(row.skills)).toEqual(newSkills);
    });

    it("returns 404 for non-existent template", async () => {
      const res = await app.request("/skills/templates/nonexistent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 when no fields provided", async () => {
      const res = await app.request("/skills/templates/engineering", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("creates audit log entry", async () => {
      await app.request("/skills/templates/engineering", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Eng Updated" }),
      });
      const ops = db.prepare("SELECT * FROM operations WHERE type = 'skill.template.update'").all() as any[];
      expect(ops.length).toBe(1);
    });
  });

  // ─── DELETE /templates/:id ───

  describe("DELETE /templates/:id", () => {
    it("deletes a custom template", async () => {
      // Insert a custom (non-builtin) template
      db.prepare(
        "INSERT INTO skill_templates (id, name, name_zh, description, description_zh, skills, builtin) VALUES (?, ?, ?, ?, ?, ?, 0)",
      ).run("custom-del", "Del", "删除", "desc", "描述", "[]");

      const res = await app.request("/skills/templates/custom-del", { method: "DELETE" });
      expect(res.status).toBe(200);

      const row = db.prepare("SELECT id FROM skill_templates WHERE id = ?").get("custom-del");
      expect(row).toBeUndefined();
    });

    it("returns 403 for builtin template", async () => {
      const res = await app.request("/skills/templates/engineering", { method: "DELETE" });
      expect(res.status).toBe(403);
    });

    it("returns 404 for non-existent template", async () => {
      const res = await app.request("/skills/templates/nonexistent", { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    it("creates audit log for successful delete", async () => {
      db.prepare(
        "INSERT INTO skill_templates (id, name, name_zh, description, description_zh, skills, builtin) VALUES (?, ?, ?, ?, ?, ?, 0)",
      ).run("custom-audit", "Audit", "审计", "desc", "描述", "[]");
      await app.request("/skills/templates/custom-audit", { method: "DELETE" });
      const ops = db.prepare("SELECT * FROM operations WHERE type = 'skill.template.delete'").all() as any[];
      expect(ops.length).toBe(1);
    });
  });

  // ─── POST /install ───

  describe("POST /install", () => {
    beforeEach(() => {
      manager.seed([
        makeInstanceInfo({ id: "inst-1" }),
      ]);
    });

    it("validates and returns success count", async () => {
      const res = await app.request("/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [{ name: "github", source: "bundled" }],
          targets: [{ instanceId: "inst-1", agentIds: ["agent1", "agent2"] }],
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.installed).toBe(2); // 1 skill * 2 agents
    });

    it("returns 400 for missing skills", async () => {
      const res = await app.request("/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [],
          targets: [{ instanceId: "inst-1", agentIds: ["a1"] }],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for skills without name/source", async () => {
      const res = await app.request("/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [{ name: "github" }], // missing source
          targets: [{ instanceId: "inst-1", agentIds: ["a1"] }],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing targets", async () => {
      const res = await app.request("/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [{ name: "github", source: "bundled" }],
          targets: [],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [{ name: "github", source: "bundled" }],
          targets: [{ instanceId: "no-such-instance", agentIds: ["a1"] }],
        }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for target with empty agentIds", async () => {
      const res = await app.request("/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [{ name: "github", source: "bundled" }],
          targets: [{ instanceId: "inst-1", agentIds: [] }],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("creates audit log entry", async () => {
      await app.request("/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [{ name: "github", source: "bundled" }],
          targets: [{ instanceId: "inst-1", agentIds: ["a1"] }],
        }),
      });
      const ops = db.prepare("SELECT * FROM operations WHERE type = 'skill.install'").all() as any[];
      expect(ops.length).toBe(1);
    });
  });

  // ─── DELETE /uninstall ───

  describe("DELETE /uninstall", () => {
    beforeEach(() => {
      manager.seed([
        makeInstanceInfo({ id: "inst-1" }),
      ]);
    });

    it("validates and returns removed count", async () => {
      const res = await app.request("/skills/uninstall", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: ["github", "slack"],
          targets: [{ instanceId: "inst-1", agentIds: ["agent1"] }],
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.removed).toBe(2); // 2 skills * 1 agent
    });

    it("returns 400 for empty skills", async () => {
      const res = await app.request("/skills/uninstall", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [],
          targets: [{ instanceId: "inst-1", agentIds: ["a1"] }],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for non-string skills", async () => {
      const res = await app.request("/skills/uninstall", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [123],
          targets: [{ instanceId: "inst-1", agentIds: ["a1"] }],
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for unknown instance", async () => {
      const res = await app.request("/skills/uninstall", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: ["github"],
          targets: [{ instanceId: "no-such", agentIds: ["a1"] }],
        }),
      });
      expect(res.status).toBe(404);
    });

    it("creates audit log entry", async () => {
      await app.request("/skills/uninstall", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: ["github"],
          targets: [{ instanceId: "inst-1", agentIds: ["a1"] }],
        }),
      });
      const ops = db.prepare("SELECT * FROM operations WHERE type = 'skill.uninstall'").all() as any[];
      expect(ops.length).toBe(1);
    });
  });

  // ─── Permission checks ───

  describe("write permission enforcement", () => {
    it("auditor cannot create templates", async () => {
      const app2 = new Hono();
      app2.use("/*", mockAuthMiddleware({ userId: 2, username: "viewer", role: "auditor" }));
      app2.route("/skills", skillRoutes(db, manager as any));

      const res = await app2.request("/skills/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "x", name: "X", name_zh: "X", description: "d", description_zh: "d",
          skills: [{ name: "a", source: "bundled", note: "" }],
        }),
      });
      expect(res.status).toBe(403);
    });

    it("auditor can read catalog", async () => {
      const app2 = new Hono();
      app2.use("/*", mockAuthMiddleware({ userId: 2, username: "viewer", role: "auditor" }));
      app2.route("/skills", skillRoutes(db, manager as any));

      const res = await app2.request("/skills");
      expect(res.status).toBe(200);
    });

    it("auditor can read templates", async () => {
      const app2 = new Hono();
      app2.use("/*", mockAuthMiddleware({ userId: 2, username: "viewer", role: "auditor" }));
      app2.route("/skills", skillRoutes(db, manager as any));

      const res = await app2.request("/skills/templates");
      expect(res.status).toBe(200);
    });

    it("auditor cannot install skills", async () => {
      const app2 = new Hono();
      app2.use("/*", mockAuthMiddleware({ userId: 2, username: "viewer", role: "auditor" }));
      app2.route("/skills", skillRoutes(db, manager as any));

      const res = await app2.request("/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skills: [{ name: "a", source: "bundled" }],
          targets: [{ instanceId: "i", agentIds: ["a"] }],
        }),
      });
      expect(res.status).toBe(403);
    });
  });
});
