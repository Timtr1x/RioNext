import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { DURABILITY_NOTES } from "./db.ts";

export interface BackupReport {
  db_path: string;
  artifact_count: number;
  missing_files: string[];
  wal_present: boolean;
  used_sqlite_backup: true;
  durability: typeof DURABILITY_NOTES;
}

export interface RestoreReport {
  ok: boolean;
  dest_dir: string;
  db_path: string;
  artifact_count: number;
  broken_refs: string[];
  admission_closed: true;
  integrity_ok: boolean;
}

export async function backupStore(opts: {
  db: DatabaseSync;
  dbPath: string;
  artifactRoot: string;
  destDir: string;
}): Promise<BackupReport> {
  mkdirSync(opts.destDir, { recursive: true });
  const destDb = join(opts.destDir, "rionext.sqlite");
  const walPresent = existsSync(`${opts.dbPath}-wal`) || existsSync(`${opts.dbPath}-shm`);
  await backup(opts.db, destDb);
  const snap = new DatabaseSync(destDb, { readOnly: true });
  const rows = snap.prepare("SELECT id, campaign_id, hash, path FROM artifacts").all() as {
    id: string;
    campaign_id: string;
    hash: string;
    path: string;
  }[];
  snap.close();
  const missing: string[] = [];
  const artRoot = join(opts.destDir, "artifacts");
  for (const row of rows) {
    const dest = join(artRoot, row.campaign_id, row.hash.slice(0, 2), row.hash);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(row.path)) {
      missing.push(row.id);
      continue;
    }
    copyFileSync(row.path, dest);
  }
  writeFileSync(
    join(opts.destDir, "backup-manifest.json"),
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        source_db: opts.dbPath,
        artifact_count: rows.length,
        missing_files: missing,
        used_sqlite_backup: true,
        durability: DURABILITY_NOTES,
      },
      null,
      2,
    ),
  );
  return {
    db_path: destDb,
    artifact_count: rows.length,
    missing_files: missing,
    wal_present: walPresent,
    used_sqlite_backup: true,
    durability: DURABILITY_NOTES,
  };
}

export function restoreStore(opts: { backupDir: string; destDir: string }): RestoreReport {
  mkdirSync(opts.destDir, { recursive: true });
  const srcDb = join(opts.backupDir, "rionext.sqlite");
  const destDb = join(opts.destDir, "rionext.sqlite");
  if (!existsSync(srcDb)) {
    return {
      ok: false,
      dest_dir: opts.destDir,
      db_path: destDb,
      artifact_count: 0,
      broken_refs: ["backup_db_missing"],
      admission_closed: true,
      integrity_ok: false,
    };
  }
  copyFileSync(srcDb, destDb);
  const db = new DatabaseSync(destDb);
  db.exec("PRAGMA foreign_keys = ON;");
  const rows = db.prepare("SELECT id, campaign_id, hash, path FROM artifacts").all() as {
    id: string;
    campaign_id: string;
    hash: string;
    path: string;
  }[];
  const destArt = join(opts.destDir, "artifacts");
  const broken: string[] = [];
  for (const row of rows) {
    const backupFile = join(opts.backupDir, "artifacts", row.campaign_id, row.hash.slice(0, 2), row.hash);
    const destFile = join(destArt, row.campaign_id, row.hash.slice(0, 2), row.hash);
    mkdirSync(dirname(destFile), { recursive: true });
    const src = existsSync(backupFile) ? backupFile : row.path;
    if (!existsSync(src)) {
      broken.push(row.id);
      continue;
    }
    copyFileSync(src, destFile);
    db.prepare("UPDATE artifacts SET path = ? WHERE id = ?").run(destFile, row.id);
    const buf = readFileSync(destFile);
    const hash = createHash("sha256").update(buf).digest("hex");
    if (hash !== row.hash) broken.push(row.id);
  }
  db.prepare("UPDATE campaigns SET admission_open = 0, updated_at = ?").run(new Date().toISOString());
  db.close();
  const integrity_ok = broken.length === 0;
  return {
    ok: integrity_ok,
    dest_dir: opts.destDir,
    db_path: destDb,
    artifact_count: rows.length,
    broken_refs: broken,
    admission_closed: true,
    integrity_ok,
  };
}
