import { generateVisionProbePng, VISION_PHRASE, visionPassed, visionProbePrompt } from "./visual-runtime.ts";
import { postJson, type FetchFn } from "./client.ts";
import { buildProtocolBody, ECHO_TOOL, extractText, extractToolCall, type CommonRequest } from "./transform.ts";
import type { ModelRecord, ProbeItem, ProbeReport, Protocol, ProviderRecord } from "./types.ts";

export async function testConnection(opts: {
  provider: ProviderRecord;
  model: ModelRecord;
  apiKey: string;
  fetchFn?: FetchFn;
}): Promise<ProbeReport> {
  const { provider, model, apiKey, fetchFn } = opts;
  const url = provider.base_url;
  const protocol = provider.protocol;
  const variants: ProbeItem[] = [];

  const auth = await runAuth(protocol, url, model.name, apiKey, fetchFn);
  variants.push(auth);

  const textProbes = textProbeSpecs(protocol);
  const textResults: ProbeItem[] = [];
  for (const spec of textProbes) {
    const item = await runOnce(protocol, url, apiKey, { ...spec, model: model.name }, fetchFn);
    textResults.push(item);
    variants.push(item);
  }
  const textOk = textResults.some((t) => t.ok);
  const text: ProbeItem = {
    name: "text",
    ok: textOk,
    detail: textOk
      ? `passed ${textResults.filter((t) => t.ok).map((t) => t.name).join(",")}`
      : textResults.map((t) => `${t.name}:${t.detail}`).join("; "),
  };

  const toolReq: CommonRequest = {
    model: model.name,
    max_tokens: 1024,
    user: "Call echo_probe with token=ok. Do not answer in prose.",
    tools: [ECHO_TOOL],
    thinking: protocol === "ANTHROPIC_MESSAGES" ? "off" : "off",
  };
  const toolRaw = await runOnce(protocol, url, apiKey, toolReq, fetchFn, "tools");
  const tools: ProbeItem = {
    ...toolRaw,
    name: "tools",
    ok: toolRaw.ok && (extractToolCall(protocol, (toolRaw as ProbeItem & { json?: unknown }).json) || /echo_probe/.test(toolRaw.detail)),
    detail: toolRaw.ok ? toolRaw.detail : toolRaw.detail,
  };
  variants.push(tools);

  const reasoning = await runReasoningProbe(protocol, url, model.name, apiKey, fetchFn);
  variants.push(...reasoning.variants);

  let vision: ProbeItem = { name: "vision", ok: false, detail: "model has no vision capability" };
  if (model.vision) {
    const png = generateVisionProbePng();
    const visReq: CommonRequest = {
      model: model.name,
      max_tokens: 1024,
      user: visionProbePrompt(),
      image_png_base64: png.toString("base64"),
      thinking: "off",
    };
    const visRaw = await runOnce(protocol, url, apiKey, visReq, fetchFn, "vision");
    const reply = visRaw.detail;
    vision = {
      name: "vision",
      ok: visRaw.ok && visionPassed(reply),
      status: visRaw.status,
      detail: visRaw.ok
        ? visionPassed(reply)
          ? `read ${VISION_PHRASE}`
          : `reply did not contain ${VISION_PHRASE}: ${reply.slice(0, 180)}`
        : visRaw.detail,
    };
  }
  variants.push(vision);

  return {
    at: new Date().toISOString(),
    auth,
    text,
    tools,
    vision,
    reasoning: reasoning.summary,
    variants,
  };
}

function textProbeSpecs(protocol: Protocol): CommonRequest[] {
  const ping = "Reply with exactly the word pong.";
  if (protocol === "ANTHROPIC_MESSAGES") {
    return [
      { model: "", max_tokens: 32, user: ping, thinking: "adaptive" },
      { model: "", max_tokens: 32, user: ping, thinking: "enabled" },
      { model: "", max_tokens: 32, user: ping, thinking: "off" },
    ];
  }
  return [
    { model: "", max_tokens: 256, user: ping, thinking: "on" },
    { model: "", max_tokens: 256, user: ping, thinking: "off" },
    { model: "", max_tokens: 512, user: ping, thinking: "on", tools: [ECHO_TOOL] },
    { model: "", max_tokens: 512, user: ping, thinking: "off", tools: [ECHO_TOOL] },
  ];
}

async function runReasoningProbe(
  protocol: Protocol,
  url: string,
  model: string,
  apiKey: string,
  fetchFn?: FetchFn,
): Promise<{ summary: ProbeItem; variants: ProbeItem[] }> {
  const levels = ["low", "high", "max"] as const;
  const variants: ProbeItem[] = [];
  const passed: string[] = [];
  const failed: string[] = [];
  for (const thinking_level of levels) {
    const req: CommonRequest = {
      model,
      max_tokens: 65536,
      user: "Reply with exactly the word pong.",
      thinking: "on",
      thinking_level,
    };
    const item = await runOnce(protocol, url, apiKey, req, fetchFn, `reasoning:${thinking_level}`);
    variants.push(item);
    if (item.ok) passed.push(thinking_level);
    else failed.push(`${thinking_level}:${item.detail.slice(0, 120)}`);
  }
  const summary: ProbeItem = {
    name: "reasoning",
    ok: passed.length > 0,
    detail: passed.length
      ? `supported ${passed.join(",")}${failed.length ? `; rejected ${failed.join("; ")}` : ""}`
      : `no reasoning level accepted: ${failed.join("; ")}`,
  };
  return { summary, variants };
}

async function runAuth(
  protocol: Protocol,
  url: string,
  model: string,
  apiKey: string,
  fetchFn?: FetchFn,
): Promise<ProbeItem> {
  const req: CommonRequest = { model, max_tokens: 64, user: "hi", thinking: "off" };
  const r = await runOnce(protocol, url, apiKey, req, fetchFn, "auth");
  if (r.status === 401 || r.status === 403) return { ...r, ok: false, detail: "authentication failed" };
  return r;
}

async function runOnce(
  protocol: Protocol,
  url: string,
  apiKey: string,
  req: CommonRequest,
  fetchFn?: FetchFn,
  name?: string,
): Promise<ProbeItem & { json?: unknown }> {
  const label = name ?? `text:${req.thinking ?? "off"}${req.tools ? "+tools" : ""}`;
  try {
    const body = buildProtocolBody(protocol, req);
    const res = await postJson({ url, protocol, apiKey, body, fetchFn, timeoutMs: 60_000 });
    const text = extractText(protocol, res.json);
    return {
      name: label,
      ok: res.ok,
      status: res.status,
      detail: res.ok ? text.slice(0, 400) : `HTTP ${res.status} ${res.text.slice(0, 240)}`,
      json: res.json,
    };
  } catch (err) {
    return { name: label, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
