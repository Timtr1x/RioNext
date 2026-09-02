import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../domain/ids.ts";
import { resolveVision } from "./capabilities.ts";
import { completeBaseUrl } from "./paths.ts";
import {
  CONTEXT_DEFAULT,
  CONTEXT_MAX,
  CONTEXT_MIN,
  OUTPUT_DEFAULT,
  OUTPUT_MAX,
  OUTPUT_MIN,
  SLOTS,
  isProtocol,
  isSlot,
  type ModelRecord,
  type ProbeReport,
  type Protocol,
  type ProviderRecord,
  type SlotAssignment,
  type SlotName,
} from "./types.ts";

interface CatalogFile {
  providers: ProviderRecord[];
  models: ModelRecord[];
  slots: SlotAssignment[];
}

interface SecretFile {
  keys: Record<string, string>;
}

export class ProviderCatalog {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    if (!this.exists()) this.save(emptyCatalog());
    if (!this.secretsExist()) this.saveSecrets({ keys: {} });
  }

  private catalogPath(): string {
    return join(this.dir, "providers.json");
  }

  private secretsPath(): string {
    return join(this.dir, "provider-secrets.json");
  }

  private exists(): boolean {
    try {
      readFileSync(this.catalogPath());
      return true;
    } catch {
      return false;
    }
  }

  private secretsExist(): boolean {
    try {
      readFileSync(this.secretsPath());
      return true;
    } catch {
      return false;
    }
  }

  private load(): CatalogFile {
    const raw = JSON.parse(readFileSync(this.catalogPath(), "utf8")) as CatalogFile;
    raw.providers ??= [];
    raw.models ??= [];
    raw.slots ??= SLOTS.map((slot) => ({ slot, provider_id: null, model_id: null }));
    for (const s of SLOTS) {
      if (!raw.slots.some((x) => x.slot === s)) raw.slots.push({ slot: s, provider_id: null, model_id: null });
    }
    return raw;
  }

  private save(data: CatalogFile): void {
    writeFileSync(this.catalogPath(), JSON.stringify(data, null, 2));
  }

  private loadSecrets(): SecretFile {
    try {
      return JSON.parse(readFileSync(this.secretsPath(), "utf8")) as SecretFile;
    } catch {
      return { keys: {} };
    }
  }

  private saveSecrets(s: SecretFile): void {
    writeFileSync(this.secretsPath(), JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  listProviders(): ProviderRecord[] {
    return this.load().providers;
  }

  listModels(providerId?: string): ModelRecord[] {
    const models = this.load().models;
    return providerId ? models.filter((m) => m.provider_id === providerId) : models;
  }

  getProvider(id: string): ProviderRecord {
    const p = this.load().providers.find((x) => x.id === id);
    if (!p) throw new Error(`provider not found: ${id}`);
    return p;
  }

  getModel(id: string): ModelRecord {
    const m = this.load().models.find((x) => x.id === id);
    if (!m) throw new Error(`model not found: ${id}`);
    return m;
  }

  apiKey(providerId: string): string | undefined {
    return this.loadSecrets().keys[providerId];
  }

  addProvider(input: { display_name: string; protocol: string; base_url: string; api_key: string }): ProviderRecord {
    if (!isProtocol(input.protocol)) throw new Error(`未知协议 ${input.protocol}`);
    const protocol = input.protocol as Protocol;
    const base_url = completeBaseUrl(input.base_url, protocol);
    if (!input.api_key.trim()) throw new Error("上游 API Key 不能为空");
    const rec: ProviderRecord = {
      id: newId("prv"),
      display_name: input.display_name.trim() || "unnamed",
      protocol,
      base_url,
      created_at: new Date().toISOString(),
    };
    const cat = this.load();
    cat.providers.push(rec);
    this.save(cat);
    const secrets = this.loadSecrets();
    secrets.keys[rec.id] = input.api_key.trim();
    this.saveSecrets(secrets);
    return rec;
  }

  addModel(input: {
    provider_id: string;
    name: string;
    context_window?: number;
    max_output_tokens?: number;
    vision?: boolean;
  }): ModelRecord {
    this.getProvider(input.provider_id);
    const ctx = input.context_window ?? CONTEXT_DEFAULT;
    const out = input.max_output_tokens ?? OUTPUT_DEFAULT;
    if (!Number.isInteger(ctx) || ctx < CONTEXT_MIN || ctx > CONTEXT_MAX) {
      throw new Error(`上下文窗口必须是 ${CONTEXT_MIN}–${CONTEXT_MAX} 的整数`);
    }
    if (!Number.isInteger(out) || out < OUTPUT_MIN || out > OUTPUT_MAX) {
      throw new Error(`最大输出 token 必须是 ${OUTPUT_MIN}–${OUTPUT_MAX} 的整数`);
    }
    const vis = resolveVision(input.name, input.vision === undefined ? null : input.vision);
    const rec: ModelRecord = {
      id: newId("mdl"),
      provider_id: input.provider_id,
      name: input.name.trim(),
      context_window: ctx,
      max_output_tokens: out,
      vision: vis.vision,
      vision_inferred: vis.vision_inferred,
      vision_override: vis.vision_override,
      available: true,
      last_probe: null,
    };
    const cat = this.load();
    cat.models.push(rec);
    this.save(cat);
    return rec;
  }

  setModelAvailable(modelId: string, available: boolean, probe?: ProbeReport): void {
    const cat = this.load();
    const m = cat.models.find((x) => x.id === modelId);
    if (!m) throw new Error(`model not found: ${modelId}`);
    m.available = available;
    if (probe) m.last_probe = probe;
    this.save(cat);
  }

  slots(): SlotAssignment[] {
    return this.load().slots;
  }

  assignSlot(slot: string, ref: string | "none"): SlotAssignment {
    if (!isSlot(slot)) throw new Error(`未知槽位 ${slot}`);
    const cat = this.load();
    const row = cat.slots.find((s) => s.slot === slot)!;
    if (ref === "none" || ref === "") {
      row.provider_id = null;
      row.model_id = null;
      this.save(cat);
      return row;
    }
    const model = cat.models.find((m) => m.id === ref || `${m.provider_id}/${m.name}` === ref || m.name === ref);
    if (!model) throw new Error(`槽位模型不存在: ${ref}`);
    row.provider_id = model.provider_id;
    row.model_id = model.id;
    this.save(cat);
    return row;
  }

  publicSnapshot(): unknown {
    const cat = this.load();
    const secrets = this.loadSecrets();
    return {
      providers: cat.providers.map((p) => ({ ...p, api_key_set: Boolean(secrets.keys[p.id]) })),
      models: cat.models,
      slots: cat.slots,
    };
  }
}

function emptyCatalog(): CatalogFile {
  return {
    providers: [],
    models: [],
    slots: SLOTS.map((slot) => ({ slot, provider_id: null, model_id: null })),
  };
}
