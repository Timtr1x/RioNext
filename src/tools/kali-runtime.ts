import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DomainError } from "../domain/errors.ts";
import type { DockerCli, DockerExecResult } from "./docker-cli.ts";
import { ProcessDockerCli } from "./docker-cli.ts";
import { checkEgress, checkRedirect, parseAllowList, parseDestination, type AllowEntry, type ResolveFn } from "./egress.ts";
import { assertKaliArgv, DEFAULT_KALI_LIMITS, KALI_IMAGE, KALI_KEEPER_NAME, KALI_MASTER_TAG, PLAYWRIGHT_OPS, workspaceRelPath } from "./kali-profile.ts";

export interface KaliStartOpts {
  campaignId: string;
  workspaceHost: string;
  dbPath: string;
  secretsPath: string;
  artifactRoot: string;
  dataDir: string;
  allowAssets: string[];
  network: "none" | "allowlist" | "bridge";
  image?: string;
  resolve?: ResolveFn;
}

export interface ContainerSpec {
  name: string;
  argv: string[];
  mounts: { host: string; container: string; mode: "rw" | "ro" }[];
  env: Record<string, string>;
  network: string;
  image: string;
}

export function containerName(campaignId: string): string {
  return `rionext-kali-${campaignId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40)}`;
}

export function dockerVolumePath(hostPath: string): string {
  const n = hostPath.replace(/\\/g, "/");
  const m = n.match(/^([A-Za-z]):(.*)$/);
  if (m) return `/${m[1]!.toLowerCase()}${m[2]}`;
  return n;
}

function forbiddenMount(host: string, forbidden: string[]): boolean {
  const a = host.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return forbidden.some((f) => {
    const b = f.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!b) return false;
    // Mounting the secret itself, or a parent of it, would leak controller files.
    return a === b || b.startsWith(`${a}/`);
  });
}

export function buildContainerSpec(opts: KaliStartOpts): ContainerSpec {
  const name = containerName(opts.campaignId);
  mkdirSync(opts.workspaceHost, { recursive: true });
  const workspace = dockerVolumePath(opts.workspaceHost);
  const forbidden = [opts.dbPath, opts.secretsPath, opts.artifactRoot, opts.dataDir].filter(Boolean);
  if (forbiddenMount(opts.workspaceHost, forbidden.filter((p) => p !== opts.workspaceHost))) {
    throw new DomainError("kali_mount", "workspace collides with controller paths", "denied");
  }
  const env: Record<string, string> = {
    HOME: "/home/rionext",
    LANG: "C.UTF-8",
    RIONEXT_CAMPAIGN: opts.campaignId,
    PLAYWRIGHT_BROWSERS_PATH: "/opt/pw-browsers",
    DISABLE_UPDATE_CHECK: "true",
  };
  const mounts = [{ host: opts.workspaceHost, container: "/workspace", mode: "rw" as const }];
  const argv: string[] = [
    "run",
    "-d",
    "--name",
    name,
    "--hostname",
    "kali",
    "--workdir",
    "/workspace",
    "--memory",
    DEFAULT_KALI_LIMITS.memory,
    "--cpus",
    DEFAULT_KALI_LIMITS.cpus,
    "--pids-limit",
    String(DEFAULT_KALI_LIMITS.pids),
    "--cap-drop",
    "ALL",
    "--cap-add",
    "NET_RAW",
    "--cap-add",
    "NET_BIND_SERVICE",
    "--security-opt",
    "no-new-privileges=true",
    "--tmpfs",
    "/tmp:rw,nosuid,size=512m",
    "--tmpfs",
    "/dev/shm:rw,size=512m",
    "--shm-size",
    "512m",
    "-v",
    `${workspace}:/workspace:rw`,
  ];
  const network = opts.network === "none" ? "none" : "bridge";
  argv.push("--network", network);
  if (opts.network === "allowlist") {
    argv.push("--cap-add", "NET_ADMIN");
    const ips = collectAllowIps(opts.allowAssets, opts.resolve ?? defaultResolve);
    env.RIONEXT_ALLOW_IPS = ips.join(",");
  }
  for (const [k, v] of Object.entries(env)) {
    argv.push("-e", `${k}=${v}`);
  }
  argv.push("--label", `rionext.campaign=${opts.campaignId}`);
  argv.push("--label", "rionext.from=master");
  argv.push(opts.image ?? KALI_IMAGE, "sleep", "infinity");
  assertNoSecretEnv(env);
  assertMountsSafe(mounts, forbidden);
  return { name, argv, mounts, env, network, image: opts.image ?? KALI_IMAGE };
}

function collectAllowIps(assets: string[], resolve: ResolveFn): string[] {
  const allow = parseAllowList(assets);
  const ips = new Set<string>();
  for (const e of allow) {
    if (e.cidr) {
      const base = e.cidr.split("/")[0];
      if (base) ips.add(base);
    }
    if (e.host) {
      try {
        for (const ip of resolve(e.host)) ips.add(ip);
      } catch {
        // host-only entries still go through gateway DNS check at exec time
      }
    }
  }
  return [...ips];
}

function defaultResolve(host: string): string[] {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return [host];
  const script = `require("node:dns").resolve4(${JSON.stringify(host)},(e,a)=>{if(e){process.stderr.write(String(e.message||e));process.exit(1)}process.stdout.write(a.join("\\n"))})`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  if (r.status !== 0) throw new Error(String(r.stderr || "dns_failed"));
  return String(r.stdout)
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function assertNoSecretEnv(env: Record<string, string>): void {
  const banned = /^(AWS_|OPENAI|ANTHROPIC|API_KEY|TOKEN|SECRET|PASSWORD|RIONEXT_PROVIDER)/i;
  for (const k of Object.keys(env)) {
    if (banned.test(k) || /key|secret|token|password/i.test(k)) {
      if (k !== "HOME" && k !== "LANG" && k !== "RIONEXT_CAMPAIGN" && k !== "RIONEXT_ALLOW_IPS" && k !== "DISABLE_UPDATE_CHECK") {
        throw new DomainError("kali_env", `refusing to pass ${k} into the container`, "denied");
      }
    }
  }
}

export function assertMountsSafe(
  mounts: { host: string; container: string }[],
  forbidden: string[],
): void {
  for (const m of mounts) {
    if (m.container !== "/workspace") {
      throw new DomainError("kali_mount", `unexpected container mount ${m.container}`, "denied");
    }
    if (forbiddenMount(m.host, forbidden)) {
      throw new DomainError("kali_mount", "refusing to mount controller db/secrets/artifacts", "denied");
    }
  }
}

export function workspaceBytes(root: string): number {
  if (!existsSync(root)) return 0;
  let n = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else n += st.size;
    }
  };
  walk(root);
  return n;
}

export class HostRateLimit {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max = DEFAULT_KALI_LIMITS.ratePerHost,
    private readonly windowMs = DEFAULT_KALI_LIMITS.rateWindowMs,
  ) {}

  admit(host: string, now = Date.now()): boolean {
    const cut = now - this.windowMs;
    const prev = (this.hits.get(host) ?? []).filter((t) => t > cut);
    if (prev.length >= this.max) return false;
    prev.push(now);
    this.hits.set(host, prev);
    return true;
  }
}

export class KaliRuntime {
  private readonly rate = new HostRateLimit();
  private readonly last = new Map<string, DockerExecResult & { truncated: boolean; container: string }>();

  private readonly docker: DockerCli;

  constructor(docker?: DockerCli) {
    this.docker = docker ?? new ProcessDockerCli();
  }

  takeLast(campaignId: string): (DockerExecResult & { truncated: boolean; container: string }) | undefined {
    const r = this.last.get(campaignId);
    this.last.delete(campaignId);
    return r;
  }

  spec(opts: KaliStartOpts): ContainerSpec {
    return buildContainerSpec(opts);
  }

  requireMasterImage(image = KALI_IMAGE): string {
    const r = this.docker.run(["image", "inspect", "-f", "{{.Id}}", image], { timeoutMs: 8_000 });
    if (r.code !== 0 || !r.stdout.trim()) {
      throw new DomainError(
        "kali_master_missing",
        `master image ${image} is not present. Build once with: rionext kali build`,
        "protocol_error",
      );
    }
    return r.stdout.trim();
  }

  protectMaster(image = KALI_IMAGE): { image_id: string; master_id: string; keeper: string; created: boolean } {
    const image_id = this.requireMasterImage(image);
    const master_id = this.requireMasterImage(KALI_MASTER_TAG);
    const inspect = this.docker.run(["inspect", "-f", "{{.Id}}", KALI_KEEPER_NAME], { timeoutMs: 5_000 });
    if (inspect.code === 0 && inspect.stdout.trim()) {
      return { image_id, master_id, keeper: KALI_KEEPER_NAME, created: false };
    }
    const created = this.docker.run(
      ["create", "--name", KALI_KEEPER_NAME, "--label", "rionext.role=master-keep", image, "true"],
      { timeoutMs: 15_000 },
    );
    if (created.code !== 0 && !/already in use|Conflict/i.test(created.stderr)) {
      throw new DomainError("kali_keeper", created.stderr || "failed to pin master image", "protocol_error");
    }
    return { image_id, master_id, keeper: KALI_KEEPER_NAME, created: created.code === 0 };
  }

  ensure(opts: KaliStartOpts): ContainerSpec {
    this.requireMasterImage(opts.image ?? KALI_IMAGE);
    const spec = this.spec(opts);
    const inspect = this.docker.run(["inspect", "-f", "{{.State.Running}}", spec.name], { timeoutMs: 5_000 });
    if (inspect.code === 0 && inspect.stdout.trim() === "true") return spec;
    this.docker.run(["rm", "-f", spec.name], { timeoutMs: 10_000 });
    const created = this.docker.run(spec.argv, { timeoutMs: 30_000 });
    if (created.code !== 0) {
      throw new DomainError("kali_start", created.stderr || "docker run failed", "protocol_error");
    }
    return spec;
  }

  exec(
    opts: KaliStartOpts,
    bin: string,
    args: string[],
    extra?: { url?: string; redirects?: string[] },
  ): DockerExecResult & { truncated: boolean; container: string } {
    assertKaliArgv(bin, args);
    const allow = parseAllowList(opts.allowAssets);
    const resolve = opts.resolve ?? ((h: string) => defaultResolve(h));
    if (extra?.url) this.admitNet(extra.url, allow, resolve, extra.redirects ?? []);
    else if (looksLikeHostArg(args)) {
      const dest = args.find((a) => a.includes(".") && !a.startsWith("-"));
      if (dest) this.admitNet(dest, allow, resolve, []);
    }
    const used = workspaceBytes(opts.workspaceHost);
    if (used > DEFAULT_KALI_LIMITS.maxWorkspaceBytes) {
      throw new DomainError("disk_cap", "workspace disk occupancy exceeds limit", "denied");
    }
    const spec = this.ensure(opts);
    const argv = ["exec", "-w", "/workspace", spec.name, "timeout", String(Math.ceil(DEFAULT_KALI_LIMITS.maxRuntimeMs / 1000)), bin, ...args];
    const result = this.docker.run(argv, {
      timeoutMs: DEFAULT_KALI_LIMITS.maxRuntimeMs + 5_000,
      maxBytes: DEFAULT_KALI_LIMITS.maxOutputBytes,
    });
    const truncated =
      result.stdout.length >= DEFAULT_KALI_LIMITS.maxOutputBytes ||
      result.stderr.length >= DEFAULT_KALI_LIMITS.maxOutputBytes;
    if (result.timedOut) this.kill(opts.campaignId);
    const out = { ...result, truncated, container: spec.name };
    this.last.set(opts.campaignId, out);
    return out;
  }

  writeWorkspace(
    opts: KaliStartOpts,
    path: string,
    content: string,
  ): DockerExecResult & { truncated: boolean; container: string } {
    const rel = workspaceRelPath(path);
    if (content.length > DEFAULT_KALI_LIMITS.maxOutputBytes) {
      throw new DomainError("disk_cap", "workspace write exceeds output cap", "denied");
    }
    mkdirSync(opts.workspaceHost, { recursive: true });
    const used = workspaceBytes(opts.workspaceHost);
    if (used + content.length > DEFAULT_KALI_LIMITS.maxWorkspaceBytes) {
      throw new DomainError("disk_cap", "workspace disk occupancy exceeds limit", "denied");
    }
    const dest = join(opts.workspaceHost, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content, "utf8");
    const spec = this.ensure(opts);
    const body = JSON.stringify({ ok: true, path: `/workspace/${rel.replace(/\\/g, "/")}`, bytes: Buffer.byteLength(content, "utf8") });
    const out = {
      stdout: body,
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: false,
      container: spec.name,
    };
    this.last.set(opts.campaignId, out);
    return out;
  }

  playwright(
    opts: KaliStartOpts,
    cmd: { op: string; url?: string; ref?: string; selector?: string; text?: string; key?: string; timeout_ms?: number; redirects?: string[] },
  ): DockerExecResult & { truncated: boolean; container: string } {
    if (!PLAYWRIGHT_OPS.has(cmd.op)) {
      throw new DomainError("playwright_op", `unknown playwright op ${cmd.op}`, "invalid_input");
    }
    if (cmd.op === "goto" && cmd.url) {
      const allow = parseAllowList(opts.allowAssets);
      const resolve = opts.resolve ?? ((h: string) => defaultResolve(h));
      this.admitNet(cmd.url, allow, resolve, cmd.redirects ?? []);
    }
    const spec = this.ensure(opts);
    const result = this.docker.run(["exec", "-i", spec.name, "node", "/opt/rionext/pw-ctl.mjs"], {
      input: JSON.stringify(cmd),
      timeoutMs: Math.max(DEFAULT_KALI_LIMITS.maxRuntimeMs, cmd.timeout_ms ?? 0) + 5_000,
      maxBytes: DEFAULT_KALI_LIMITS.maxOutputBytes,
    });
    const truncated =
      result.stdout.length >= DEFAULT_KALI_LIMITS.maxOutputBytes ||
      result.stderr.length >= DEFAULT_KALI_LIMITS.maxOutputBytes;
    const out = { ...result, truncated, container: spec.name };
    this.last.set(opts.campaignId, out);
    return out;
  }

  kill(campaignId: string): void {
    const name = containerName(campaignId);
    if (name === KALI_KEEPER_NAME) {
      throw new DomainError("kali_keeper", "refusing to kill the master keeper", "denied");
    }
    this.docker.run(["kill", name], { timeoutMs: 10_000 });
    this.docker.run(["rm", "-f", name], { timeoutMs: 10_000 });
  }

  inspectCampaign(campaignId: string): "running" | "exited" | "missing" {
    const name = containerName(campaignId);
    const r = this.docker.run(["inspect", "-f", "{{.State.Running}}", name], { timeoutMs: 5_000 });
    if (r.code !== 0 || !r.stdout.trim()) return "missing";
    return r.stdout.trim() === "true" ? "running" : "exited";
  }

  query(campaignId: string): "unknown" | "completed" | "failed" {
    const box = this.inspectCampaign(campaignId);
    if (box === "missing" || box === "exited") return "failed";
    return "unknown";
  }

  private admitNet(raw: string, allow: AllowEntry[], resolve: ResolveFn, redirects: string[]): void {
    const dest = parseDestination(raw);
    const first = checkEgress(dest, allow, resolve);
    if (!first.ok) throw new DomainError("egress_denied", first.reason, "denied");
    if (!this.rate.admit(dest.host)) throw new DomainError("rate_limited", `rate limit for ${dest.host}`, "denied");
    for (const loc of redirects) {
      const hop = checkRedirect(loc, allow, resolve);
      if (!hop.ok) throw new DomainError("redirect_denied", hop.reason, "denied");
      if (!this.rate.admit(hop.dest.host)) throw new DomainError("rate_limited", `rate limit for ${hop.dest.host}`, "denied");
    }
  }
}

function looksLikeHostArg(args: string[]): boolean {
  return args.some(
    (a) =>
      /^https?:\/\//.test(a) ||
      /^\d{1,3}(\.\d{1,3}){3}/.test(a) ||
      (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(a) && !a.startsWith("-")),
  );
}
