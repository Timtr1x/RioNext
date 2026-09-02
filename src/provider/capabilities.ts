const VISION_NAME =
  /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|o4-mini|o3(?!\d)|claude-3|claude-4|claude-sonnet-4|claude-opus-4|gemini|qwen-vl|qwen2.?5-vl|qwen2-vl|llava|pixtral|grok-2-vision|grok-4|vision|vl-|omni)/i;

export function inferVision(modelName: string): boolean {
  return VISION_NAME.test(modelName);
}

export function resolveVision(modelName: string, override: boolean | null | undefined): {
  vision: boolean;
  vision_inferred: boolean;
  vision_override: boolean | null;
} {
  const inferred = inferVision(modelName);
  if (override === true || override === false) {
    return { vision: override, vision_inferred: inferred, vision_override: override };
  }
  return { vision: inferred, vision_inferred: inferred, vision_override: null };
}
