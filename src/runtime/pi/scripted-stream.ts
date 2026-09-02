import type { StreamFn } from "@earendil-works/pi-agent-core";
export type { StreamFn };
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";

export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const SCRIPTED_MODEL: Model<"openai-completions"> = {
  id: "scripted",
  name: "scripted",
  api: "openai-completions",
  provider: "scripted",
  baseUrl: "http://scripted.local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

export interface ScriptedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id?: string;
}

export type ScriptedTurn =
  | { type: "tool_calls"; calls: ScriptedToolCall[] }
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "aborted"; message: string }
  | { type: "truncated_tools"; calls: ScriptedToolCall[] };

export type TurnChooser = (context: { systemPrompt?: string; messages: unknown[]; tools?: { name: string }[] }) => ScriptedTurn;

export function createScriptedStreamFn(chooser: TurnChooser): StreamFn {
  let n = 0;
  return (model, context) => {
    const turn = chooser({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      tools: context.tools,
    });
    n += 1;
    void n;
    if (turn.type === "error") return createScriptedErrorStream(model, turn.message);
    if (turn.type === "aborted") return createScriptedAbortStream(model, turn.message);
    if (turn.type === "text") return createTextStream(model, turn.text);
    if (turn.type === "truncated_tools") return createToolStream(model, turn.calls, "length");
    return createToolStream(model, turn.calls, "toolUse");
  };
}

export function createQueuedStreamFn(turns: ScriptedTurn[]): StreamFn {
  let i = 0;
  return createScriptedStreamFn(() => turns[i++] ?? { type: "text", text: "script exhausted" });
}

export function createTextStream(
  model: Model<string>,
  text: string,
  usage?: Partial<Usage>,
): AssistantMessageEventStream {
  const msg = baseAssistant(model, [{ type: "text", text }], "stop", undefined, usage);
  return emit(msg, "stop");
}

let toolCallSeq = 0;

export function createToolStream(
  model: Model<string>,
  calls: ScriptedToolCall[],
  reason: "toolUse" | "length",
): AssistantMessageEventStream {
  const content = calls.map((c, i) => ({
    type: "toolCall" as const,
    id: c.id ?? `tc_${++toolCallSeq}_${i}_${c.name}`,
    name: c.name,
    arguments: c.arguments,
  }));
  const msg = baseAssistant(model, content, reason);
  return emit(msg, reason);
}

export function createScriptedErrorStream(model: Model<string>, message: string): AssistantMessageEventStream {
  const msg = baseAssistant(model, [{ type: "text", text: "" }], "error", message);
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "error", reason: "error", error: msg });
  });
  return stream;
}

export function createScriptedAbortStream(model: Model<string>, message: string): AssistantMessageEventStream {
  const msg = baseAssistant(model, [{ type: "text", text: "" }], "aborted", message);
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "error", reason: "aborted", error: msg });
  });
  return stream;
}

function baseAssistant(
  model: Model<string>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
  usage?: Partial<Usage>,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      ...EMPTY_USAGE,
      input: usage?.input ?? 8,
      output: usage?.output ?? 4,
      totalTokens: usage?.totalTokens ?? 12,
      cost: usage?.cost ?? EMPTY_USAGE.cost,
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function emit(msg: AssistantMessage, reason: "stop" | "toolUse" | "length"): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: msg });
    stream.push({ type: "done", reason, message: msg });
  });
  return stream;
}
