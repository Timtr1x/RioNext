import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.ts";

export const DURABILITY_NOTES = {
  journal_mode: "WAL",
  synchronous: "NORMAL",
  assumption:
    "WAL + synchronous=NORMAL is durable across process crash on a functioning local volume; it is not a power-loss guarantee on all hardware. Do not copy the main DB file alone as a backup while WAL exists.",
};

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  private txDepth = 0;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.path = path;
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  migrate(): void {
    this.db.exec(SCHEMA_SQL);
    const row = this.db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as
      | { version: number }
      | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, nowIso());
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as
      | { version: number }
      | undefined;
    return row?.version ?? 0;
  }

  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    if (depth === 0) this.db.exec("BEGIN IMMEDIATE");
    else this.db.exec(`SAVEPOINT sp${depth}`);
    this.txDepth += 1;
    try {
      const result = fn();
      this.txDepth -= 1;
      if (depth === 0) this.db.exec("COMMIT");
      else this.db.exec(`RELEASE sp${depth}`);
      return result;
    } catch (err) {
      this.txDepth -= 1;
      try {
        if (depth === 0) this.db.exec("ROLLBACK");
        else this.db.exec(`ROLLBACK TO sp${depth}`);
      } catch {
        // ignore
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function asJson(value: unknown): string {
  return JSON.stringify(value);
}

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  return JSON.parse(text) as T;
}
