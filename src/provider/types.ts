export const PROTOCOLS = [
  "ANTHROPIC_MESSAGES",
  "OPENAI_CHAT_COMPLETIONS",
  "OPENAI_RESPONSES",
] as const;

export type Protocol = (typeof PROTOCOLS)[number];

export const SLOTS = ["solver", "reflect", "visual", "triage", "manager"] as const;
export type SlotName = (typeof SLOTS)[number];

export const SLOT_LABELS: Record<SlotName, string> = {
  solver: "主求解",
  reflect: "反思",
  visual: "视觉",
  triage: "Triage",
  manager: "Manager",
};

export interface ProviderRecord {
  id: string;
  display_name: string;
  protocol: Protocol;
  base_url: string;
  created_at: string;
}

export interface ModelRecord {
  id: string;
  provider_id: string;
  name: string;
  context_window: number;
  max_output_tokens: number;
  vision: boolean;
  vision_inferred: boolean;
  vision_override: boolean | null;
  available: boolean;
  last_probe: ProbeReport | null;
}

export interface SlotAssignment {
  slot: SlotName;
  provider_id: string | null;
  model_id: string | null;
}

export interface ProbeItem {
  name: string;
  ok: boolean;
  status?: number;
  detail: string;
}

export interface ProbeReport {
  at: string;
  auth: ProbeItem;
  text: ProbeItem;
  tools: ProbeItem;
  vision: ProbeItem;
  variants: ProbeItem[];
}

export const CONTEXT_MIN = 1024;
export const CONTEXT_MAX = 10_000_000;
export const CONTEXT_DEFAULT = 256_000;
export const OUTPUT_MIN = 64;
export const OUTPUT_MAX = 1_000_000;
export const OUTPUT_DEFAULT = 51_200;
export const STREAM_TIMEOUT_DEFAULT_MS = 600_000;

export function isProtocol(v: string): v is Protocol {
  return (PROTOCOLS as readonly string[]).includes(v);
}

export function isSlot(v: string): v is SlotName {
  return (SLOTS as readonly string[]).includes(v);
}
