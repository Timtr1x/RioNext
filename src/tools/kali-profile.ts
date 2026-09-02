export const KALI_IMAGE = process.env.RIONEXT_KALI_IMAGE ?? "rionext-kali:rolling";
export const KALI_MASTER_TAG = "rionext-kali:master";
export const KALI_BASE_IMAGE = "kalilinux/kali-rolling";
/** Stopped container that pins the master image against `docker system prune -a`. Never a campaign. */
export const KALI_KEEPER_NAME = "rionext-master-keep";

export const PROTECTED_IMAGE_REFS = new Set([KALI_IMAGE, KALI_MASTER_TAG, "rionext-kali:rolling", "rionext-kali:master"]);

export function isProtectedImageRef(ref: string): boolean {
  const t = ref.trim();
  if (PROTECTED_IMAGE_REFS.has(t)) return true;
  return t === "rionext-kali" || t.startsWith("rionext-kali:");
}

export const KALI_BINARIES = new Set([
  "nmap",
  "curl",
  "wget",
  "gobuster",
  "ffuf",
  "nikto",
  "sqlmap",
  "whatweb",
  "dig",
  "whois",
  "openssl",
  "httpx",
  "httpx-toolkit",
  "httpx-pd",
  "nuclei",
  "katana",
  "dalfox",
  "cloudfox",
  "kerbrute",
  "chisel",
  "chromium",
  "chromium-browser",
  "cat",
  "head",
  "tail",
  "ls",
  "find",
  "grep",
  "rg",
  "wc",
  "file",
  "bash",
  "sh",
  "python3",
  "mkdir",
  "chmod",
  "tee",
  "rm",
  "cp",
  "mv",
]);

export const KALI_INTERPRETERS = new Set(["bash", "sh", "python3"]);
export const KALI_PATH_BINS = new Set(["mkdir", "chmod", "tee", "rm", "cp", "mv"]);
/** Scanners that must not block the Execute slot. Detached docker exec + poll. */
export const KALI_BACKGROUND_BINS = new Set([
  "nmap",
  "nuclei",
  "katana",
  "gobuster",
  "ffuf",
  "nikto",
  "sqlmap",
  "whatweb",
  "dalfox",
  "cloudfox",
  "kerbrute",
  "httpx-toolkit",
  "httpx-pd",
  "wget",
]);

export function isAllowedKaliBin(bin: string): boolean {
  if (!/^[A-Za-z0-9_.+-]+$/.test(bin)) return false;
  if (KALI_BINARIES.has(bin)) return true;
  return bin.startsWith("impacket-");
}

/** Relative path under /workspace. Absolute paths must start with /workspace/. */
export function workspaceRelPath(raw: string): string {
  const n = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!n || n === "." || n === "/workspace" || n === "/workspace/") {
    throw new Error("workspace path is empty");
  }
  if (n.split("/").includes("..") || n.includes("\0")) {
    throw new Error("workspace path escape");
  }
  if (n.startsWith("/")) {
    if (!n.startsWith("/workspace/")) throw new Error("path must be under /workspace");
    return n.slice("/workspace/".length);
  }
  if (n.startsWith("~") || n.startsWith("-")) throw new Error("workspace path escape");
  return n;
}

function hasMeta(a: string): boolean {
  return /[;|&`$<>\n]/.test(a) || a.includes("$(");
}

export const PLAYWRIGHT_OPS = new Set([
  "goto",
  "snapshot",
  "click",
  "type",
  "press",
  "screenshot",
  "content",
  "wait",
  "back",
  "status",
]);

export const DEFAULT_KALI_LIMITS = {
  memory: "4g",
  cpus: "2",
  pids: 512,
  maxOutputBytes: 1_000_000,
  maxRuntimeMs: 60_000,
  maxBackgroundRuntimeMs: 30 * 60_000,
  pollIntervalMs: 2_000,
  maxWorkspaceBytes: 512_000_000,
  ratePerHost: 20,
  rateWindowMs: 60_000,
};

export function isKaliProfile(profile: string): boolean {
  return profile === "kali" || profile === "docker-kali";
}

export function shouldBackgroundKali(bin: string, timeoutMs?: number): boolean {
  if (KALI_BACKGROUND_BINS.has(bin)) return true;
  return typeof timeoutMs === "number" && timeoutMs > DEFAULT_KALI_LIMITS.maxRuntimeMs;
}

export function assertKaliArgv(bin: string, args: string[]): void {
  if (!isAllowedKaliBin(bin)) {
    throw new Error(`kali binary not allowlisted: ${bin}`);
  }
  if (KALI_INTERPRETERS.has(bin)) {
    assertInterpreterArgv(args);
    return;
  }
  if (KALI_PATH_BINS.has(bin)) {
    assertPathBinArgv(bin, args);
    return;
  }
  for (const a of args) {
    if (hasMeta(a)) throw new Error("kali args contain shell metacharacters");
  }
}

function assertInterpreterArgv(args: string[]): void {
  const cIdx = args.indexOf("-c");
  if (cIdx >= 0) {
    if (cIdx !== args.length - 2) {
      throw new Error("interpreter -c requires a single script argument");
    }
    for (let i = 0; i < cIdx; i++) {
      if (!/^-[A-Za-z0-9]+$/.test(args[i]!)) {
        throw new Error("interpreter flags must be simple");
      }
    }
    const script = args[cIdx + 1] ?? "";
    if (script.length > 200_000) throw new Error("script too large");
    return;
  }
  const files = args.filter((a) => !a.startsWith("-"));
  if (files.length === 0) throw new Error("interpreter requires -c or a /workspace script");
  for (const f of files) workspaceRelPath(f);
  for (const a of args) {
    if (files.includes(a)) continue;
    if (hasMeta(a)) throw new Error("kali args contain shell metacharacters");
  }
}

function assertPathBinArgv(bin: string, args: string[]): void {
  for (const a of args) {
    if (a.startsWith("-") || (bin === "chmod" && /^[+=ugoa]*[rwxXst]+$/.test(a))) continue;
    if (hasMeta(a)) throw new Error("kali args contain shell metacharacters");
    workspaceRelPath(a);
  }
}
