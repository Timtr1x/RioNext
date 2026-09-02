import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KALI_BASE_IMAGE, KALI_IMAGE, KALI_KEEPER_NAME, KALI_MASTER_TAG } from "../tools/kali-profile.ts";
import { ProcessDockerCli } from "../tools/docker-cli.ts";
import { dockerVolumePath, KaliRuntime } from "../tools/kali-runtime.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function kaliDockerContext(): string {
  const candidates = [
    join(process.cwd(), "docker/kali"),
    join(here, "../../../docker/kali"),
    join(here, "../../../../docker/kali"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "Dockerfile"))) return c;
  }
  return join(process.cwd(), "docker/kali");
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function handleKaliCommand(argv: string[]): unknown {
  const sub = argv[0] ?? "status";
  const docker = new ProcessDockerCli();
  const rt = new KaliRuntime(docker);
  if (sub === "status") {
    const img = docker.run(["image", "inspect", "-f", "{{.Id}} {{.Created}}", KALI_IMAGE], { timeoutMs: 8_000 });
    const master = docker.run(["image", "inspect", "-f", "{{.Id}}", KALI_MASTER_TAG], { timeoutMs: 8_000 });
    const keeper = docker.run(["inspect", "-f", "{{.State.Status}}", KALI_KEEPER_NAME], { timeoutMs: 5_000 });
    return {
      docker: docker.available(),
      image: KALI_IMAGE,
      master_tag: KALI_MASTER_TAG,
      base: KALI_BASE_IMAGE,
      context: kaliDockerContext(),
      master_present: img.code === 0,
      master_id: img.code === 0 ? img.stdout.trim() : null,
      master_tag_id: master.code === 0 ? master.stdout.trim() : null,
      keeper: KALI_KEEPER_NAME,
      keeper_present: keeper.code === 0,
      keeper_status: keeper.code === 0 ? keeper.stdout.trim() : null,
      note: "rionext-kali:master / :rolling is the retained template. Campaign clones are docker rm'd on cancel. Never docker rmi the master.",
    };
  }
  if (sub === "pull") {
    const r = spawnSync("docker", ["pull", KALI_BASE_IMAGE], { encoding: "utf8", stdio: "pipe" });
    return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, status: r.status };
  }
  if (sub === "build") {
    const r = spawnSync(
      "docker",
      ["build", "-t", KALI_IMAGE, "-t", KALI_MASTER_TAG, kaliDockerContext()],
      { encoding: "utf8", stdio: "pipe" },
    );
    let protect: unknown = null;
    if (r.status === 0) {
      try {
        protect = rt.protectMaster();
      } catch (err) {
        protect = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return {
      ok: r.status === 0,
      stdout: r.stdout,
      stderr: r.stderr,
      status: r.status,
      image: KALI_IMAGE,
      master_tag: KALI_MASTER_TAG,
      retained: true,
      protect,
    };
  }
  if (sub === "protect") {
    return { ok: true, ...rt.protectMaster(), retained: true };
  }
  if (sub === "smoke") {
    return runKaliSmoke(rt, docker);
  }
  throw new Error(`unknown kali command ${sub}`);
}

const FIXTURE_HTML = `<!doctype html>
<html>
<head><title>RioNext PW fixture</title></head>
<body>
  <h1 id="title">hello-rionext</h1>
  <a id="about" href="/about.html">About</a>
  <form id="f">
    <input id="q" name="q" type="text" />
    <button id="go" type="submit">Search</button>
  </form>
  <p id="out"></p>
  <script>
    document.getElementById("f").addEventListener("submit", function (e) {
      e.preventDefault();
      document.getElementById("out").textContent = "got:" + document.getElementById("q").value;
    });
  </script>
</body>
</html>
`;

const ABOUT_HTML = `<!doctype html><html><head><title>About</title></head><body><h1>about-page</h1></body></html>`;

const FIXTURE_SERVER = `const http=require("http");const fs=require("fs");const path=require("path");http.createServer((req,res)=>{const p=path.join("/workspace", req.url==="/"? "index.html": req.url);fs.readFile(p,(e,b)=>{if(e){res.writeHead(404);res.end("nf");return}res.writeHead(200,{"content-type":"text/html"});res.end(b)})}).listen(8765,"127.0.0.1")`;

function runKaliSmoke(rt: KaliRuntime, docker: ProcessDockerCli): unknown {
  const protect = rt.protectMaster();
  const name = "rionext-kali-camp-smoke";
  const ws = join(tmpdir(), "rionext-kali-smoke", "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "index.html"), FIXTURE_HTML);
  writeFileSync(join(ws, "about.html"), ABOUT_HTML);
  docker.run(["rm", "-f", name], { timeoutMs: 15_000 });
  const volume = `${dockerVolumePath(ws)}:/workspace:rw`;
  const started = docker.run(
    [
      "run",
      "-d",
      "--name",
      name,
      "--hostname",
      "kali",
      "--workdir",
      "/workspace",
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--pids-limit",
      "512",
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
      "--network",
      "none",
      "-v",
      volume,
      "-e",
      "HOME=/home/rionext",
      "-e",
      "PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers",
      "--label",
      "rionext.campaign=smoke",
      "--label",
      "rionext.from=master",
      KALI_MASTER_TAG,
      "sleep",
      "infinity",
    ],
    { timeoutMs: 30_000 },
  );
  if (started.code !== 0) {
    return { ok: false, error: started.stderr || "docker run failed", protect };
  }
  try {
    let healthy = false;
    for (let i = 0; i < 40; i++) {
      const h = docker.run(
        ["exec", name, "node", "-e", "fetch('http://127.0.0.1:18765/').then(r=>r.text()).then(t=>{if(!t.includes('rionext-playwright'))process.exit(1)}).catch(()=>process.exit(1))"],
        { timeoutMs: 8_000 },
      );
      if (h.code === 0) {
        healthy = true;
        break;
      }
      sleep(400);
    }
    if (!healthy) {
      const log = docker.run(["exec", name, "sh", "-c", "cat /var/log/rionext-pw.log 2>/dev/null || true"], { timeoutMs: 5_000 });
      return { ok: false, error: "playwright daemon did not start", log: log.stdout, protect };
    }
    docker.run(["exec", "-d", name, "node", "-e", FIXTURE_SERVER], { timeoutMs: 8_000 });
    sleep(400);
    const goto = pw(docker, name, { op: "goto", url: "http://127.0.0.1:8765/" });
    const typed = pw(docker, name, { op: "type", selector: "#q", text: "agent-typed" });
    const click = pw(docker, name, { op: "click", selector: "#go" });
    const content = pw(docker, name, { op: "content" });
    const about = pw(docker, name, { op: "click", selector: "#about" });
    const body = String(content.result?.text ?? "");
    const ok =
      goto.ok &&
      typed.ok &&
      click.ok &&
      content.ok &&
      about.ok &&
      body.includes("got:agent-typed") &&
      String(about.result?.title ?? "") === "About";
    const still = docker.run(["image", "inspect", "-f", "{{.Id}}", KALI_MASTER_TAG], { timeoutMs: 8_000 });
    const keeper = docker.run(["inspect", "-f", "{{.Id}}", KALI_KEEPER_NAME], { timeoutMs: 5_000 });
    return {
      ok,
      playwright: { goto: goto.result, typed: typed.result, click: click.result, content: content.result, about: about.result },
      master_retained: still.code === 0,
      master_id: still.stdout.trim(),
      keeper_present: keeper.code === 0,
      protect,
      note: "Campaign clone was used for Playwright. Master image was not removed.",
    };
  } finally {
    docker.run(["kill", name], { timeoutMs: 10_000 });
    docker.run(["rm", "-f", name], { timeoutMs: 10_000 });
  }
}

function pw(docker: ProcessDockerCli, name: string, cmd: Record<string, unknown>): { ok: boolean; result: Record<string, unknown> } {
  const r = docker.run(["exec", "-i", name, "node", "/opt/rionext/pw-ctl.mjs"], {
    input: JSON.stringify(cmd),
    timeoutMs: 30_000,
  });
  try {
    const result = JSON.parse(r.stdout || "{}") as Record<string, unknown>;
    return { ok: r.code === 0 && result.ok !== false, result };
  } catch {
    return { ok: false, result: { stdout: r.stdout, stderr: r.stderr, code: r.code } };
  }
}
