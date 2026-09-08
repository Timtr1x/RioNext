import type { Protocol } from "./types.ts";
import { requestHeaders } from "./transform.ts";

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
  signal?: AbortSignal;
  sessionId?: string;
}): Promise<HttpResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  const onAbort = (): void => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetchFn(opts.url, {
      method: "POST",
      headers: requestHeaders({
        protocol: opts.protocol,
        apiKey: opts.apiKey,
        url: opts.url,
        sessionId: opts.sessionId,
      }),
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
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
