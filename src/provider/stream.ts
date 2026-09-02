import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
  createScriptedAbortStream,
  createScriptedErrorStream,
  createTextStream,
} from "../runtime/pi/scripted-stream.ts";
import type { ProviderCatalog } from "./catalog.ts";
import { postJson, type FetchFn } from "./client.ts";
import { buildProtocolBody, extractText, extractToolCalls, extractUsage, type CommonTool, type ProtocolMessage } from "./transform.ts";
import { OUTPUT_DEFAULT } from "./types.ts";
import { createToolStream } from "../runtime/pi/scripted-stream.ts";

export interface CataloguedStreamStats {
  attempts: number;
}

export interface CataloguedStreamOpts {
  catalog: ProviderCatalog;
  providerId: string;
  modelName: string;
  fetchFn: FetchFn;
  maxRetries?: number;
  timeoutMs?: number;
  apiKey?: string;
}

function campaignMaxTokens(opts: CataloguedStreamOpts, requested?: number): number {
  if (typeof requested === "number" && requested > 0) return requested;
  const rec = opts.catalog.listModels(opts.providerId).find((m) => m.name === opts.modelName);
  return rec?.max_output_tokens ?? OUTPUT_DEFAULT;
}

function userText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
        .join("");
      if (text) return text;
    }
  }
  return "";
}

function contextTools(context: Context): CommonTool[] {
  return (context.tools ?? []).map((t) => ({
    name: t.name,
    description: ("description" in t && typeof t.description === "string" ? t.description : t.name) as string,
    parameters: (t.parameters && typeof t.parameters === "object" ? (t.parameters as Record<string, unknown>) : { type: "object", properties: {} }),
  }));
}

function contextMessages(context: Context): ProtocolMessage[] {
  const out: ProtocolMessage[] = [];
  for (const m of context.messages) {
    if (m.role === "user") {
      const content =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("")
            : "";
      out.push({ role: "user", content });
      continue;
    }
    if (m.role === "assistant") {
      const calls = (Array.isArray(m.content) ? m.content : [])
        .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "toolCall")
        .map((c) => {
          const call = c as { id?: string; name?: string; arguments?: unknown };
          return { id: String(call.id ?? ""), name: String(call.name ?? ""), arguments: call.arguments ?? {} };
        })
        .filter((c) => c.name);
      const text = (Array.isArray(m.content) ? m.content : [])
        .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
        .join("");
      out.push({ role: "assistant", content: text || null, tool_calls: calls.length ? calls : undefined });
      continue;
    }
    if (m.role === "toolResult") {
      const text = (m.content ?? []).map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("");
      out.push({ role: "tool", content: text, tool_call_id: m.toolCallId, name: m.toolName });
    }
  }
  return out;
}

export function createCataloguedProviderStream(opts: CataloguedStreamOpts): {
  stream: StreamFn;
  stats: CataloguedStreamStats;
} {
  const stats: CataloguedStreamStats = { attempts: 0 };
  const maxRetries = Math.max(0, opts.maxRetries ?? 0);
  const stream: StreamFn = (model: Model<string>, context: Context, options) => {
    return (async () => {
      if (options?.signal?.aborted) {
        return createScriptedAbortStream(model, "cancelled");
      }
      const provider = opts.catalog.getProvider(opts.providerId);
      const key = opts.apiKey ?? opts.catalog.apiKey(opts.providerId) ?? "catalogued-no-live-key";
      const body = buildProtocolBody(provider.protocol, {
        model: opts.modelName,
        system: context.systemPrompt,
        user: userText(context),
        messages: contextMessages(context),
        tools: contextTools(context),
        max_tokens: campaignMaxTokens(opts, options?.maxTokens),
      });
      const cap = Math.min(maxRetries, options?.maxRetries ?? maxRetries);
      let lastErr = "provider_error";
      for (let i = 0; i <= cap; i++) {
        if (options?.signal?.aborted) {
          return createScriptedAbortStream(model, "cancelled");
        }
        stats.attempts += 1;
        try {
          const res = await postJson({
            url: provider.base_url,
            protocol: provider.protocol,
            apiKey: key,
            body,
            fetchFn: opts.fetchFn,
            timeoutMs: opts.timeoutMs ?? options?.timeoutMs ?? 5_000,
            signal: options?.signal,
          });
          if (res.ok) {
            const usage = extractUsage(res.json);
            const calls = extractToolCalls(provider.protocol, res.json);
            if (calls.length) {
              return createToolStream(model, calls, "toolUse");
            }
            const text = extractText(provider.protocol, res.json);
            return createTextStream(model, text || "ok", usage);
          }
          lastErr = `http_${res.status}`;
        } catch (err) {
          const name = err instanceof Error ? err.name : "";
          const msg = err instanceof Error ? err.message : String(err);
          if (name === "AbortError" || /abort/i.test(msg)) {
            return createScriptedAbortStream(model, options?.signal?.aborted ? "cancelled" : "timeout");
          }
          lastErr = msg;
        }
      }
      return createScriptedErrorStream(model, lastErr);
    })();
  };
  return { stream, stats };
}
