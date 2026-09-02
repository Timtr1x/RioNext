import type { ProviderCatalog } from "./catalog.ts";
import type { ModelRecord, ProviderRecord, SlotName } from "./types.ts";

export interface ResolvedRoute {
  slot: SlotName;
  provider: ProviderRecord;
  model: ModelRecord;
  fallback_from: string | null;
}

export function resolveSlot(catalog: ProviderCatalog, slot: SlotName): ResolvedRoute {
  const models = catalog.listModels();
  const providers = catalog.listProviders();
  if (models.length === 0) throw new Error("没有可用模型。先添加 Provider 和 Model。");

  const assigned = catalog.slots().find((s) => s.slot === slot);
  const solver = catalog.slots().find((s) => s.slot === "solver");

  const pick = (modelId: string | null): ModelRecord | undefined => {
    if (!modelId) return undefined;
    const m = models.find((x) => x.id === modelId);
    if (m && m.available) return m;
    return undefined;
  };

  const assignedModel = pick(assigned?.model_id ?? null);
  if (assignedModel) {
    return {
      slot,
      provider: catalog.getProvider(assignedModel.provider_id),
      model: assignedModel,
      fallback_from: null,
    };
  }

  const solverModel = pick(solver?.model_id ?? null);
  if (solverModel) {
    return {
      slot,
      provider: catalog.getProvider(solverModel.provider_id),
      model: solverModel,
      fallback_from: assigned?.model_id ? "slot_unavailable" : "slot_empty",
    };
  }

  const first = models.find((m) => m.available) ?? models[0]!;
  return {
    slot,
    provider: providers.find((p) => p.id === first.provider_id) ?? catalog.getProvider(first.provider_id),
    model: first,
    fallback_from: "first_available",
  };
}

export function resolveVisionRoute(catalog: ProviderCatalog): ResolvedRoute {
  const route = resolveSlot(catalog, "visual");
  if (!route.model.vision) {
    const vis = catalog.listModels().find((m) => m.available && m.vision);
    if (vis) {
      return {
        slot: "visual",
        provider: catalog.getProvider(vis.provider_id),
        model: vis,
        fallback_from: "non_visual_slot",
      };
    }
  }
  return route;
}
