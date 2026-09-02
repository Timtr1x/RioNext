import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
  createScriptedAbortStream,
  createScriptedErrorStream,
  createTextStream,
} from "../runtime/pi/scripted-stream.ts";
import type { ProviderCatalog } from "./catalog.ts";
import { postJson, type FetchFn } from "./client.ts";
import { buildProtocolBody, extractText, extractUsage } from "./transform.ts";

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
        max_tokens: options?.maxTokens ?? 64,
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
            const text = extractText(provider.protocol, res.json);
            const usage = extractUsage(res.json);
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
