import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { seedTemplates, BUILTIN_TEMPLATES } from "../templates-seed.js";

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
  `);
  return db;
}

describe("skill_templates schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("creates the skill_templates table", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_templates'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("has all expected columns", () => {
    const cols = db.prepare("PRAGMA table_info(skill_templates)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toEqual(
      expect.arrayContaining([
        "id", "name", "name_zh", "description", "description_zh",
        "icon", "skills", "builtin", "sort_order", "created_at", "updated_at",
      ]),
    );
  });

  it("enforces primary key uniqueness on id", () => {
    db.prepare(
      "INSERT INTO skill_templates (id, name, name_zh, description, description_zh, skills) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("test", "Test", "测试", "desc", "描述", "[]");
    expect(() =>
      db.prepare(
        "INSERT INTO skill_templates (id, name, name_zh, description, description_zh, skills) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("test", "Test2", "测试2", "desc2", "描述2", "[]"),
    ).toThrow(/UNIQUE/);
  });

  it("sets default values correctly", () => {
    db.prepare(
      "INSERT INTO skill_templates (id, name, name_zh, description, description_zh) VALUES (?, ?, ?, ?, ?)",
    ).run("test", "Test", "测试", "desc", "描述");
    const row = db.prepare("SELECT * FROM skill_templates WHERE id = ?").get("test") as any;
    expect(row.icon).toBe("");
    expect(row.skills).toBe("[]");
    expect(row.builtin).toBe(0);
    expect(row.sort_order).toBe(0);
    expect(row.created_at).toBeDefined();
    expect(row.updated_at).toBeDefined();
  });
});

describe("BUILTIN_TEMPLATES constant", () => {
  it("has exactly 15 templates", () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(15);
  });

  it("all templates have unique ids", () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all templates have unique sort_order values", () => {
    const orders = BUILTIN_TEMPLATES.map((t) => t.sort_order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("all templates are marked builtin=1", () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.builtin).toBe(1);
    }
  });

  it("all templates have required string fields", () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.name_zh).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.description_zh).toBeTruthy();
      expect(t.icon).toBeTruthy();
    }
  });

  it("all templates have at least one skill", () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.skills.length).toBeGreaterThan(0);
    }
  });

  it("all skills have name, source, and note", () => {
    for (const t of BUILTIN_TEMPLATES) {
      for (const s of t.skills) {
        expect(s.name).toBeTruthy();
        expect(["bundled", "clawhub"]).toContain(s.source);
        expect(s.note).toBeTruthy();
      }
    }
  });

  it("sort_order values are 1 through 15", () => {
    const orders = BUILTIN_TEMPLATES.map((t) => t.sort_order).sort((a, b) => a - b);
    expect(orders).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });
});

describe("seedTemplates()", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("inserts all 15 built-in templates", () => {
    seedTemplates(db);
    const count = db.prepare("SELECT COUNT(*) as cnt FROM skill_templates").get() as { cnt: number };
    expect(count.cnt).toBe(15);
  });

  it("is idempotent — second call does not duplicate rows", () => {
    seedTemplates(db);
    seedTemplates(db);
    const count = db.prepare("SELECT COUNT(*) as cnt FROM skill_templates").get() as { cnt: number };
    expect(count.cnt).toBe(15);
  });

  it("does not overwrite user-modified rows", () => {
    seedTemplates(db);
    db.prepare("UPDATE skill_templates SET name = ? WHERE id = ?").run("My Custom Name", "engineering");
    seedTemplates(db);
    const row = db.prepare("SELECT name FROM skill_templates WHERE id = ?").get("engineering") as { name: string };
    expect(row.name).toBe("My Custom Name");
  });

  it("stores skills as valid JSON", () => {
    seedTemplates(db);
    const rows = db.prepare("SELECT id, skills FROM skill_templates").all() as { id: string; skills: string }[];
    for (const row of rows) {
      const parsed = JSON.parse(row.skills);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      for (const s of parsed) {
        expect(s).toHaveProperty("name");
        expect(s).toHaveProperty("source");
        expect(s).toHaveProperty("note");
      }
    }
  });

  it("all seeded rows have builtin=1", () => {
    seedTemplates(db);
    const rows = db.prepare("SELECT builtin FROM skill_templates").all() as { builtin: number }[];
    for (const row of rows) {
      expect(row.builtin).toBe(1);
    }
  });

  it("preserves sort_order from template definitions", () => {
    seedTemplates(db);
    const rows = db
      .prepare("SELECT id, sort_order FROM skill_templates ORDER BY sort_order")
      .all() as { id: string; sort_order: number }[];
    expect(rows[0]).toEqual({ id: "engineering", sort_order: 1 });
    expect(rows[14]).toEqual({ id: "cn-ai", sort_order: 15 });
  });

  it("specific template data is correct (spot check)", () => {
    seedTemplates(db);
    const row = db.prepare("SELECT * FROM skill_templates WHERE id = ?").get("cn-social") as any;
    expect(row.name).toBe("Chinese Social");
    expect(row.name_zh).toBe("中国社交媒体");
    expect(row.icon).toBe("message-circle");
    const skills = JSON.parse(row.skills);
    const names = skills.map((s: any) => s.name);
    expect(names).toContain("xiaohongshu-skills");
    expect(names).toContain("xurl");
  });
});
