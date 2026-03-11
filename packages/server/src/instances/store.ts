import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";

const DB_PATH = path.join(os.homedir(), ".clawctl", "clawctl.db");

export function initDb(): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      token TEXT,
      label TEXT,
      auto_discovered INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'running',
      output TEXT DEFAULT '',
      started_at TEXT DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS config_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_aliases (
      instance_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      alias TEXT NOT NULL,
      PRIMARY KEY (instance_id, session_key)
    );

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

    CREATE TABLE IF NOT EXISTS provider_keys (
      instance_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      key_masked TEXT,
      status TEXT DEFAULT 'unknown',
      checked_at TEXT,
      error_message TEXT,
      email TEXT,
      account_info TEXT,
      PRIMARY KEY (instance_id, profile_id)
    );
  `);

  // Migrations
  try { db.exec("ALTER TABLE operations ADD COLUMN operator TEXT"); } catch { /* column already exists */ }

  return db;
}
