import type Database from "better-sqlite3";
import { encrypt, decrypt } from "./crypto.js";
import type { RemoteHost, RemoteHostRow, CreateHostInput } from "./types.js";

export class HostStore {
  constructor(
    private db: Database.Database,
    private encSecret: string,
  ) {}

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remote_hosts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth_method TEXT NOT NULL CHECK(auth_method IN ('password', 'privateKey')),
        credential_enc TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        last_scan_at TEXT,
        last_scan_error TEXT
      )
    `);
  }

  create(input: CreateHostInput): RemoteHost {
    const credEnc = encrypt(input.credential, this.encSecret);
    const stmt = this.db.prepare(
      `INSERT INTO remote_hosts (label, host, port, username, auth_method, credential_enc)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      input.label,
      input.host,
      input.port || 22,
      input.username,
      input.authMethod,
      credEnc,
    );
    return this.get(result.lastInsertRowid as number)!;
  }

  get(id: number): RemoteHost | undefined {
    const row = this.db.prepare("SELECT * FROM remote_hosts WHERE id = ?").get(id) as RemoteHostRow | undefined;
    if (!row) return undefined;
    return this.rowToHost(row);
  }

  findByConnection(host: string, port: number, username: string): RemoteHost | undefined {
    const row = this.db.prepare(
      "SELECT * FROM remote_hosts WHERE host = ? AND port = ? AND username = ?"
    ).get(host, port, username) as RemoteHostRow | undefined;
    if (!row) return undefined;
    return this.rowToHost(row);
  }

  list(): RemoteHost[] {
    const rows = this.db.prepare("SELECT * FROM remote_hosts ORDER BY id").all() as RemoteHostRow[];
    return rows.map((r) => this.rowToHost(r));
  }

  update(id: number, input: Partial<CreateHostInput>): RemoteHost | undefined {
    const existing = this.db.prepare("SELECT * FROM remote_hosts WHERE id = ?").get(id) as RemoteHostRow | undefined;
    if (!existing) return undefined;

    const label = input.label ?? existing.label;
    const host = input.host ?? existing.host;
    const port = input.port ?? existing.port;
    const username = input.username ?? existing.username;
    const authMethod = input.authMethod ?? existing.auth_method;
    const credEnc = input.credential
      ? encrypt(input.credential, this.encSecret)
      : existing.credential_enc;

    this.db.prepare(
      `UPDATE remote_hosts SET label=?, host=?, port=?, username=?, auth_method=?, credential_enc=? WHERE id=?`
    ).run(label, host, port, username, authMethod, credEnc, id);

    return this.get(id);
  }

  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM remote_hosts WHERE id = ?").run(id);
    return result.changes > 0;
  }

  updateScanResult(id: number, error: string | null) {
    this.db.prepare(
      `UPDATE remote_hosts SET last_scan_at = datetime('now'), last_scan_error = ? WHERE id = ?`
    ).run(error, id);
  }

  getDecryptedCredential(id: number): string | undefined {
    const row = this.db.prepare("SELECT credential_enc FROM remote_hosts WHERE id = ?").get(id) as { credential_enc: string } | undefined;
    if (!row) return undefined;
    return decrypt(row.credential_enc, this.encSecret);
  }

  private rowToHost(row: RemoteHostRow): RemoteHost {
    return {
      id: row.id,
      label: row.label,
      host: row.host,
      port: row.port,
      username: row.username,
      authMethod: row.auth_method,
      credential: "***",
      created_at: row.created_at,
      last_scan_at: row.last_scan_at,
      last_scan_error: row.last_scan_error,
    };
  }
}
