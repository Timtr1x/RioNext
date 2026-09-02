import { spawnSync } from "node:child_process";
import { isProtectedImageRef, KALI_KEEPER_NAME } from "./kali-profile.ts";

export interface DockerExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface DockerRunOpts {
  timeoutMs?: number;
  maxBytes?: number;
  input?: string;
}

export interface DockerCli {
  available(): boolean;
  run(argv: string[], opts?: DockerRunOpts): DockerExecResult;
}

export class ProcessDockerCli implements DockerCli {
  available(): boolean {
    const r = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 8_000 });
    return r.status === 0;
  }

  run(argv: string[], opts?: DockerRunOpts): DockerExecResult {
    if (argv[0] === "rmi" && argv.some((a) => isProtectedImageRef(a))) {
      return { stdout: "", stderr: "refusing to rmi master image rionext-kali", code: 1, timedOut: false };
    }
    if ((argv[0] === "rm" || argv[0] === "kill") && argv.includes(KALI_KEEPER_NAME)) {
      return { stdout: "", stderr: "refusing to remove master keeper rionext-master-keep", code: 1, timedOut: false };
    }
    const maxBytes = opts?.maxBytes ?? 1_000_000;
    const r = spawnSync("docker", argv, {
      encoding: "utf8",
      timeout: opts?.timeoutMs ?? 60_000,
      maxBuffer: maxBytes,
      windowsHide: true,
      input: opts?.input,
    });
    const timedOut = r.error?.name === "ETIMEDOUT" || /ETIMEDOUT/.test(String(r.error ?? ""));
    const stdout = String(r.stdout ?? "").slice(0, maxBytes);
    const stderr = String(r.stderr ?? "").slice(0, maxBytes);
    return { stdout, stderr, code: r.status ?? (timedOut ? 124 : 1), timedOut };
  }
}

export class FakeDockerCli implements DockerCli {
  readonly calls: string[][] = [];
  lastInput: string | undefined;
  next: DockerExecResult = { stdout: "", stderr: "", code: 0, timedOut: false };
  alive = new Set<string>();
  created = new Set<string>();
  images = new Set(["rionext-kali:rolling", "rionext-kali:master"]);

  available(): boolean {
    return true;
  }

  run(argv: string[], opts?: DockerRunOpts): DockerExecResult {
    this.calls.push([...argv]);
    this.lastInput = opts?.input;
    const maxBytes = opts?.maxBytes ?? 1_000_000;
    if (argv[0] === "image" && argv[1] === "inspect") {
      const ref = argv[argv.length - 1] ?? "";
      if (this.images.has(ref) || [...this.images].some((i) => argv.includes(i))) {
        return { stdout: "sha256:master", stderr: "", code: 0, timedOut: false };
      }
      return { stdout: "", stderr: "No such image", code: 1, timedOut: false };
    }
    if (argv[0] === "exec" && argv.includes("-d")) {
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    }
    if (argv[0] === "run" && argv.includes("-d")) {
      const name = nameFrom(argv);
      if (name) {
        this.alive.add(name);
        this.created.add(name);
      }
      return { stdout: name ?? "cid", stderr: "", code: 0, timedOut: false };
    }
    if (argv[0] === "create") {
      const name = nameFrom(argv);
      if (name) this.created.add(name);
      return { stdout: name ?? "cid", stderr: "", code: 0, timedOut: false };
    }
    if (argv[0] === "rmi") {
      return { stdout: "", stderr: "master image is retained", code: 1, timedOut: false };
    }
    if (argv[0] === "kill") {
      const name = argv[argv.length - 1];
      if (name === KALI_KEEPER_NAME) {
        return { stdout: "", stderr: "refusing to remove master keeper rionext-master-keep", code: 1, timedOut: false };
      }
      if (name) this.alive.delete(name);
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    }
    if (argv[0] === "rm") {
      const name = argv[argv.length - 1];
      if (name === KALI_KEEPER_NAME) {
        return { stdout: "", stderr: "refusing to remove master keeper rionext-master-keep", code: 1, timedOut: false };
      }
      if (name) {
        this.alive.delete(name);
        this.created.delete(name);
      }
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    }
    if (argv[0] === "inspect") {
      const name = argv[argv.length - 1] ?? "";
      const exists = this.alive.has(name) || this.created.has(name);
      if (!exists) return { stdout: "", stderr: "No such object", code: 1, timedOut: false };
      return { stdout: this.alive.has(name) ? "true" : "false", stderr: "", code: 0, timedOut: false };
    }
    return {
      stdout: this.next.stdout.slice(0, maxBytes),
      stderr: this.next.stderr.slice(0, maxBytes),
      code: this.next.code,
      timedOut: this.next.timedOut,
    };
  }
}

function nameFrom(argv: string[]): string | null {
  const i = argv.indexOf("--name");
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return null;
}
