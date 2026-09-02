#!/usr/bin/env node
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = process.argv[2] || (await readStdin());
const cmd = JSON.parse(raw || "{}");
const res = await fetch("http://127.0.0.1:18765/", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(cmd),
});
const text = await res.text();
process.stdout.write(text);
if (!res.ok) process.exit(1);
const parsed = JSON.parse(text);
if (parsed && parsed.ok === false) process.exit(2);
