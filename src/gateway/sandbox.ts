import { realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { DomainError } from "../domain/errors.ts";

export interface SandboxRoots {
  workspace: string;
  db_path: string;
  secrets_path: string;
  artifact_root: string;
}

export function assertSafeToolPath(roots: SandboxRoots, requested: string): string {
  const raw = String(requested ?? "");
  if (!raw) throw deny("empty_path", "tool path is empty");
  if (raw.includes("\0")) throw deny("nul_path", "nul in path");
  const abs = isAbsolute(raw) ? normalize(raw) : resolve(roots.workspace, raw);
  let resolved = abs;
  try {
    resolved = realpathSync(abs);
  } catch {
    resolved = normalize(abs);
  }
  const ws = safeReal(roots.workspace);
  if (!isInside(ws, resolved)) {
    throw deny("path_escape", `path outside workspace: ${requested}`);
  }
  const forbidden = [roots.db_path, roots.secrets_path].filter(Boolean).map((p) => normalize(p));
  for (const f of forbidden) {
    if (pathsEqual(resolved, f) || isInside(f, resolved)) {
      throw deny("secret_path", "tool cannot read controller db or secrets");
    }
  }
  return resolved;
}

export function isPolicyInjectionText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("ignore the task") ||
    t.includes("raise budget") ||
    t.includes("enlarge scope") ||
    t.includes("set_state(completed)") ||
    t.includes("disable admission")
  );
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return normalize(resolve(p));
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function pathsEqual(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase() || normalize(a) === normalize(b);
}

function deny(code: string, message: string): DomainError {
  return new DomainError(code, message, "denied", { code });
}

export { sep };
