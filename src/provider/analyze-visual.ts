import type { ProviderCatalog } from "./catalog.ts";
import { postJson, type FetchFn } from "./client.ts";
import { resolveVisionRoute } from "./router.ts";
import { buildProtocolBody, extractText } from "./transform.ts";

export class NonVisualModelError extends Error {
  readonly code = "non_visual_model";
  constructor(modelName: string) {
    super(`analyze_visual 拒绝非视觉模型: ${modelName}`);
    this.name = "NonVisualModelError";
  }
}

export async function analyzeVisual(opts: {
  catalog: ProviderCatalog;
  prompt: string;
  image_png_base64: string;
  fetchFn?: FetchFn;
}): Promise<{ model: string; text: string; fallback_from: string | null }> {
  const route = resolveVisionRoute(opts.catalog);
  if (!route.model.vision) {
    throw new NonVisualModelError(route.model.name);
  }
  const key = opts.catalog.apiKey(route.provider.id);
  if (!key) throw new Error("visual slot provider missing API key");
  const body = buildProtocolBody(route.provider.protocol, {
    model: route.model.name,
    max_tokens: Math.min(512, route.model.max_output_tokens),
    user: opts.prompt,
    image_png_base64: opts.image_png_base64,
    thinking: "off",
  });
  const res = await postJson({
    url: route.provider.base_url,
    protocol: route.provider.protocol,
    apiKey: key,
    body,
    fetchFn: opts.fetchFn,
  });
  if (!res.ok) throw new Error(`analyze_visual HTTP ${res.status}`);
  return {
    model: route.model.name,
    text: extractText(route.provider.protocol, res.json),
    fallback_from: route.fallback_from,
  };
}
