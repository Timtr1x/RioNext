import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PI_DECLARED_VERSION } from "../version.ts";

const LOCKED_PACKAGES = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"] as const;

export interface IntegrityCheck {
  ok: boolean;
  failures: string[];
  expected: Record<string, { version: string; integrity: string }>;
  actual: Record<string, { version: string; integrity: string }>;
}

export function parseIntegrityDoc(text: string): Record<string, { version: string; integrity: string }> {
  const out: Record<string, { version: string; integrity: string }> = {};
  const re = /@(earendil-works\/pi-(?:agent-core|ai))@([\d.]+)\s+(sha512-[A-Za-z0-9+/=]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out[`@${m[1]}`] = { version: m[2]!, integrity: m[3]! };
  }
  return out;
}

export function lockfileIntegrity(lockJson: string, pkg: string): { version: string; integrity: string } | null {
  const lock = JSON.parse(lockJson) as {
    packages?: Record<string, { version?: string; integrity?: string }>;
  };
  const row = lock.packages?.[`node_modules/${pkg}`];
  if (!row?.version || !row.integrity) return null;
  return { version: row.version, integrity: row.integrity };
}

export function checkLockedDependencyIntegrity(rootDir: string): IntegrityCheck {
  const doc = readFileSync(join(rootDir, "docs/dependency-integrity.md"), "utf8");
  const lock = readFileSync(join(rootDir, "package-lock.json"), "utf8");
  const expected = parseIntegrityDoc(doc);
  const actual: IntegrityCheck["actual"] = {};
  const failures: string[] = [];
  for (const pkg of LOCKED_PACKAGES) {
    const exp = expected[pkg];
    const got = lockfileIntegrity(lock, pkg);
    if (!exp) {
      failures.push(`${pkg} missing from docs/dependency-integrity.md`);
      continue;
    }
    if (!got) {
      failures.push(`${pkg} missing from package-lock.json`);
      continue;
    }
    actual[pkg] = got;
    if (got.version !== exp.version || got.version !== PI_DECLARED_VERSION) {
      failures.push(`${pkg} version drifted: lock=${got.version} doc=${exp.version} declared=${PI_DECLARED_VERSION}`);
    }
    if (got.integrity !== exp.integrity) {
      failures.push(`${pkg} integrity drifted from docs/dependency-integrity.md`);
    }
  }
  return { ok: failures.length === 0, failures, expected, actual };
}

export function sequentialToolExecutionRequired(mode: string | undefined | null): boolean {
  return mode === "sequential";
}
