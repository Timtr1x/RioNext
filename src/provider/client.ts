import type { Protocol } from "./types.ts";
import { headersFor } from "./transform.ts";

export type FetchFn = typeof fetch;

export interface HttpResult {
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
}

export async function postJson(opts: {
  url: string;
  protocol: Protocol;
  apiKey: string;
  body: unknown;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}): Promise<HttpResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetchFn(opts.url, {
      method: "POST",
      headers: headersFor(opts.protocol, opts.apiKey),
      body: JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}
