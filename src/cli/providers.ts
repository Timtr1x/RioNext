import { createServer } from "node:http";
import { ProviderCatalog } from "../provider/catalog.ts";
import { testConnection } from "../provider/probe.ts";
import { analyzeVisual, NonVisualModelError } from "../provider/analyze-visual.ts";
import { resolveSlot } from "../provider/router.ts";
import { SLOT_LABELS, SLOTS, type SlotName } from "../provider/types.ts";
import { providerUiHtml } from "../web/providers-page.ts";

export function catalogFor(dataDir: string): ProviderCatalog {
  return new ProviderCatalog(dataDir);
}

export async function handleProviderCommand(
  rest: string[],
  flags: Record<string, string | boolean>,
  dataDir: string,
): Promise<unknown> {
  const cat = catalogFor(dataDir);
  const sub = rest[0] ?? "list";
  if (sub === "add") {
    return cat.addProvider({
      display_name: str(flags.name) || str(flags["display-name"]) || "provider",
      protocol: str(flags.protocol),
      base_url: str(flags["base-url"]) || str(flags.url),
      api_key: str(flags["api-key"]) || str(flags.key),
    });
  }
  if (sub === "list") return cat.publicSnapshot();
  if (sub === "model") {
    const action = rest[1] ?? "add";
    if (action !== "add") throw new Error("provider model add ...");
    return cat.addModel({
      provider_id: str(flags.provider),
      name: str(flags.name),
      context_window: flags.context ? Number(flags.context) : undefined,
      max_output_tokens: flags["max-output"] ? Number(flags["max-output"]) : undefined,
      vision: flags.vision === undefined ? undefined : Boolean(flags.vision),
    });
  }
  if (sub === "test") {
    const provider = cat.getProvider(str(flags.provider));
    const model = cat.listModels(provider.id).find((m) => m.id === flags.model || m.name === flags.model) ?? cat.getModel(str(flags.model));
    const key = cat.apiKey(provider.id);
    if (!key) throw new Error("missing api key");
    const report = await testConnection({ provider, model, apiKey: key });
    const available = report.auth.ok && report.text.ok;
    cat.setModelAvailable(model.id, available, report);
    return { model: model.name, available, report };
  }
  if (sub === "slots" || sub === "slot") {
    if (flags.solver || flags.reflect || flags.visual || flags.triage || flags.manager || flags.none) {
      for (const slot of SLOTS) {
        const v = flags[slot];
        if (typeof v === "string") cat.assignSlot(slot, v);
      }
      if (typeof flags.set === "string" && typeof flags.to === "string") cat.assignSlot(flags.set, flags.to);
    }
    return {
      slots: cat.slots().map((s) => ({
        slot: s.slot,
        label: SLOT_LABELS[s.slot],
        provider_id: s.provider_id,
        model_id: s.model_id,
      })),
      resolved: Object.fromEntries(
        SLOTS.map((slot) => {
          try {
            const r = resolveSlot(cat, slot);
            return [slot, { model: r.model.name, fallback_from: r.fallback_from }];
          } catch (err) {
            return [slot, { error: err instanceof Error ? err.message : String(err) }];
          }
        }),
      ),
    };
  }
  if (sub === "analyze-visual") {
    try {
      return await analyzeVisual({
        catalog: cat,
        prompt: str(flags.prompt) || "Describe the image.",
        image_png_base64: str(flags.image),
      });
    } catch (err) {
      if (err instanceof NonVisualModelError) throw err;
      throw err;
    }
  }
  if (sub === "ui") {
    const port = Number(flags.port ?? 7780);
    await serveProviderUi(dataDir, port);
    return { ui: `http://127.0.0.1:${port}` };
  }
  throw new Error(`unknown provider command ${sub}`);
}

function str(v: string | boolean | undefined): string {
  if (typeof v === "string") return v;
  return "";
}

async function serveProviderUi(dataDir: string, port: number): Promise<void> {
  const cat = () => new ProviderCatalog(dataDir);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && url.pathname === "/") {
        send(200, providerUiHtml(), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/catalog") {
        send(200, cat().publicSnapshot());
        return;
      }
      const body = await readBody(req);
      if (req.method === "POST" && url.pathname === "/api/providers") {
        send(200, cat().addProvider(JSON.parse(body) as { display_name: string; protocol: string; base_url: string; api_key: string }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/models") {
        send(200, cat().addModel(JSON.parse(body) as { provider_id: string; name: string; context_window?: number; max_output_tokens?: number; vision?: boolean }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/test") {
        const p = JSON.parse(body) as { provider_id: string; model_id: string };
        const c = cat();
        const provider = c.getProvider(p.provider_id);
        const model = c.getModel(p.model_id);
        const key = c.apiKey(provider.id);
        if (!key) throw new Error("missing api key");
        const report = await testConnection({ provider, model, apiKey: key });
        c.setModelAvailable(model.id, report.auth.ok && report.text.ok, report);
        send(200, { report, available: report.auth.ok && report.text.ok });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/slots") {
        const p = JSON.parse(body) as { slot: SlotName; ref: string };
        send(200, cat().assignSlot(p.slot, p.ref));
        return;
      }
      send(404, { error: "not found" });
    } catch (err) {
      send(400, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`provider ui http://127.0.0.1:${port}`);
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8") || "{}"));
    req.on("error", reject);
  });
}
