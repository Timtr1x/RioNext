import type { Protocol } from "./types.ts";

export interface CommonTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CommonRequest {
  model: string;
  system?: string;
  user: string | Array<Record<string, unknown>>;
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
  const content = userToAnthropicContent(req);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens,
    messages: [{ role: "user", content }],
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
  const messages: Record<string, unknown>[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  messages.push({ role: "user", content: userToOpenAIContent(req) });
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

export function extractToolCall(protocol: Protocol, json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const obj = json as Record<string, unknown>;
  if (protocol === "ANTHROPIC_MESSAGES") {
    const content = obj.content;
    if (Array.isArray(content)) return content.some((b) => b && (b as { type?: string }).type === "tool_use");
  }
  const blob = JSON.stringify(obj);
  return blob.includes("tool_calls") || blob.includes("function_call") || blob.includes("tool_use");
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
