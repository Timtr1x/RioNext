import type { Protocol } from "./types.ts";

export interface CommonTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProtocolMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  tool_calls?: { id: string; name: string; arguments: unknown }[];
  tool_call_id?: string;
  name?: string;
}

export interface CommonRequest {
  model: string;
  system?: string;
  user: string | Array<Record<string, unknown>>;
  messages?: ProtocolMessage[];
  max_tokens: number;
  tools?: CommonTool[];
  thinking?: "off" | "on" | "adaptive" | "enabled";
  image_png_base64?: string;
}

export function buildProtocolBody(protocol: Protocol, req: CommonRequest): Record<string, unknown> {
  if (protocol === "ANTHROPIC_MESSAGES") return anthropicBody(req);
  if (protocol === "OPENAI_RESPONSES") return responsesBody(req);
  return chatCompletionsBody(req);
}

function anthropicBody(req: CommonRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens,
    messages: req.messages?.length ? toAnthropicMessages(req) : [{ role: "user", content: userToAnthropicContent(req) }],
  };
  if (req.system) body.system = req.system;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    body.tool_choice = { type: "auto" };
  }
  if (req.thinking === "adaptive") body.thinking = { type: "adaptive" };
  if (req.thinking === "enabled" || req.thinking === "on") {
    body.thinking = { type: "enabled", budget_tokens: Math.min(2048, Math.max(256, Math.floor(req.max_tokens / 2))) };
  }
  return body;
}

function chatCompletionsBody(req: CommonRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = req.messages?.length ? toOpenAIMessages(req) : [];
  if (!req.messages?.length) {
    if (req.system) messages.push({ role: "system", content: req.system });
    messages.push({ role: "user", content: userToOpenAIContent(req) });
  }
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
  };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }
  if (req.thinking === "on" || req.thinking === "enabled" || req.thinking === "adaptive") {
    body.reasoning_effort = "medium";
  }
  return body;
}

function toOpenAIMessages(req: CommonRequest): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (req.system) out.push({ role: "system", content: req.system });
  for (const m of req.messages ?? []) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      out.push({
        role: "assistant",
        content: m.content ?? null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) },
        })),
      });
      continue;
    }
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.tool_call_id, content: m.content ?? "" });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

function toAnthropicMessages(req: CommonRequest): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of req.messages ?? []) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      out.push({
        role: "assistant",
        content: m.tool_calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} })),
      });
      continue;
    }
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") }],
      });
      continue;
    }
    if (m.role === "system") continue;
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  return out;
}

function responsesBody(req: CommonRequest): Record<string, unknown> {
  const content = userToResponsesContent(req);
  const body: Record<string, unknown> = {
    model: req.model,
    input: [{ role: "user", content }],
    max_output_tokens: req.max_tokens,
  };
  if (req.system) body.instructions = req.system;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
  if (req.thinking === "on" || req.thinking === "enabled" || req.thinking === "adaptive") {
    body.reasoning = { effort: "medium" };
  }
  return body;
}

function userToAnthropicContent(req: CommonRequest): unknown {
  if (req.image_png_base64) {
    const text = typeof req.user === "string" ? req.user : "Describe the image.";
    return [
      { type: "image", source: { type: "base64", media_type: "image/png", data: req.image_png_base64 } },
      { type: "text", text },
    ];
  }
  return typeof req.user === "string" ? req.user : req.user;
}

function userToOpenAIContent(req: CommonRequest): unknown {
  if (req.image_png_base64) {
    const text = typeof req.user === "string" ? req.user : "Describe the image.";
    return [
      { type: "text", text },
      { type: "image_url", image_url: { url: `data:image/png;base64,${req.image_png_base64}` } },
    ];
  }
  return typeof req.user === "string" ? req.user : req.user;
}

function userToResponsesContent(req: CommonRequest): unknown {
  if (req.image_png_base64) {
    const text = typeof req.user === "string" ? req.user : "Describe the image.";
    return [
      { type: "input_text", text },
      { type: "input_image", image_url: `data:image/png;base64,${req.image_png_base64}` },
    ];
  }
  return [{ type: "input_text", text: typeof req.user === "string" ? req.user : "ping" }];
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

export function openaiHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
}

export function headersFor(protocol: Protocol, apiKey: string): Record<string, string> {
  return protocol === "ANTHROPIC_MESSAGES" ? anthropicHeaders(apiKey) : openaiHeaders(apiKey);
}

export function extractText(protocol: Protocol, json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const obj = json as Record<string, unknown>;
  if (protocol === "ANTHROPIC_MESSAGES") {
    const content = obj.content;
    if (Array.isArray(content)) {
      return content
        .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
        .join("");
    }
  }
  if (protocol === "OPENAI_RESPONSES") {
    const output = obj.output;
    if (Array.isArray(output)) {
      return JSON.stringify(output);
    }
    if (typeof obj.output_text === "string") return obj.output_text;
  }
  const choices = obj.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
    const msg = (choices[0] as { message?: { content?: unknown; tool_calls?: unknown } }).message;
    if (msg?.content && typeof msg.content === "string") return msg.content;
    if (msg?.tool_calls) return JSON.stringify(msg.tool_calls);
  }
  return JSON.stringify(obj).slice(0, 2000);
}

export function extractUsage(json: unknown): { input: number; output: number; totalTokens: number } {
  if (!json || typeof json !== "object") return { input: 0, output: 0, totalTokens: 0 };
  const obj = json as Record<string, unknown>;
  const usage = obj.usage;
  if (!usage || typeof usage !== "object") return { input: 0, output: 0, totalTokens: 0 };
  const u = usage as Record<string, unknown>;
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? u.input ?? 0) || 0;
  const output = Number(u.output_tokens ?? u.completion_tokens ?? u.output ?? 0) || 0;
  const total = Number(u.total_tokens ?? input + output) || input + output;
  return { input, output, totalTokens: total };
}

export function extractToolCall(protocol: Protocol, json: unknown): boolean {
  return extractToolCalls(protocol, json).length > 0;
}

export function extractToolCalls(protocol: Protocol, json: unknown): { id: string; name: string; arguments: Record<string, unknown> }[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  if (protocol === "ANTHROPIC_MESSAGES") {
    const content = obj.content;
    if (!Array.isArray(content)) return [];
    return content
      .filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_use")
      .map((b, i) => {
        const block = b as { id?: string; name?: string; input?: unknown };
        return {
          id: String(block.id ?? `tool_${i}`),
          name: String(block.name ?? ""),
          arguments: (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>,
        };
      })
      .filter((c) => c.name);
  }
  if (protocol === "OPENAI_RESPONSES") {
    const output = obj.output;
    if (!Array.isArray(output)) return [];
    return output
      .filter((b) => b && typeof b === "object" && ((b as { type?: string }).type === "function_call" || (b as { type?: string }).type === "tool_call"))
      .map((b, i) => {
        const block = b as { call_id?: string; id?: string; name?: string; arguments?: unknown };
        let args: Record<string, unknown> = {};
        if (typeof block.arguments === "string") {
          try {
            args = JSON.parse(block.arguments) as Record<string, unknown>;
          } catch {
            args = { raw: block.arguments };
          }
        } else if (block.arguments && typeof block.arguments === "object") {
          args = block.arguments as Record<string, unknown>;
        }
        return { id: String(block.call_id ?? block.id ?? `tool_${i}`), name: String(block.name ?? ""), arguments: args };
      })
      .filter((c) => c.name);
  }
  const choices = obj.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return [];
  const msg = (choices[0] as { message?: { tool_calls?: unknown } }).message;
  const calls = msg?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map((c, i) => {
      const call = c as { id?: string; function?: { name?: string; arguments?: unknown }; name?: string };
      const raw = call.function?.arguments ?? "{}";
      let args: Record<string, unknown> = {};
      if (typeof raw === "string") {
        try {
          args = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          args = { raw };
        }
      } else if (raw && typeof raw === "object") {
        args = raw as Record<string, unknown>;
      }
      return { id: String(call.id ?? `tool_${i}`), name: String(call.function?.name ?? call.name ?? ""), arguments: args };
    })
    .filter((c) => c.name);
}

export const ECHO_TOOL: CommonTool = {
  name: "echo_probe",
  description: "Echo a token to prove tool calling works. Call this once.",
  parameters: {
    type: "object",
    properties: { token: { type: "string", description: "echo this" } },
    required: ["token"],
  },
};
