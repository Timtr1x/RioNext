import type { ScriptedTurn, TurnChooser } from "../runtime/pi/scripted-stream.ts";

function lastToolResults(messages: unknown[]): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const m of messages) {
    const msg = m as { role?: string; toolName?: string; content?: { type: string; text?: string }[] };
    if (msg.role === "toolResult") {
      const text = (msg.content ?? []).map((c) => c.text ?? "").join("");
      out.push({ name: String(msg.toolName), text });
    }
  }
  return out;
}

function payloadOf(messages: unknown[]): Record<string, unknown> {
  const first = messages[0] as { role?: string; content?: unknown };
  if (!first || first.role !== "user") return {};
  const content = first.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? (content as { text?: string }[]).map((c) => c.text ?? "").join("") : "";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stepQuestions(payload: Record<string, unknown>): string[] {
  const graph = payload.graph as { steps?: { question?: string; status?: string }[] } | undefined;
  return (graph?.steps ?? []).map((s) => String(s.question ?? ""));
}

export function decideChooser(): TurnChooser {
  return (ctx) => {
    const results = lastToolResults(ctx.messages);
    const payload = payloadOf(ctx.messages);
    if (results.some((r) => r.name === "propose_plan") && !results.some((r) => r.name === "finish_decision")) {
      return { type: "tool_calls", calls: [{ name: "finish_decision", arguments: { summary: "plan submitted or no change" } }] };
    }
    if (!results.some((r) => r.name === "graph_query")) {
      return { type: "tool_calls", calls: [{ name: "graph_query", arguments: { entity: "steps" } }] };
    }
    if (!results.some((r) => r.name === "propose_plan")) {
      const ops: unknown[] = [];
      const questions = stepQuestions(payload);
      const has = (q: string) => questions.some((x) => x.includes(q));
      if (!has("inspect desk")) {
        ops.push({
          op: "propose_step",
          step: {
            kind: "explore",
            question: "inspect desk and note",
            methodFamily: "inspect-desk",
            expectedObservations: ["desk", "note"],
            completionCriteria: "note text observed",
            preconditions: { op: "all", of: [] },
            goalRefs: [],
            inputRefs: [],
            resourceClaims: [],
            budgetHint: {},
            reopenRule: { kind: "never" },
          },
        });
      }
      if (!has("badge")) {
        ops.push({
          op: "propose_step",
          step: {
            kind: "explore",
            question: "use badge reader to unlock drawer",
            methodFamily: "badge",
            expectedObservations: ["badge"],
            completionCriteria: "drawer unlocked",
            preconditions: { op: "all", of: [] },
            goalRefs: [],
            inputRefs: [],
            resourceClaims: [],
            budgetHint: {},
            reopenRule: { kind: "always" },
          },
        });
      }
      if (!has("take key")) {
        ops.push({
          op: "propose_step",
          step: {
            kind: "acquire_prerequisite",
            question: "take key from drawer",
            methodFamily: "take-key",
            expectedObservations: ["key"],
            completionCriteria: "key in hand",
            preconditions: { op: "atom", key: "drawer_open" },
            goalRefs: [],
            inputRefs: [],
            resourceClaims: [],
            budgetHint: {},
            reopenRule: { kind: "fact_key", key: "drawer_open" },
          },
        });
      }
      if (!has("open cabinet")) {
        ops.push({
          op: "propose_step",
          step: {
            kind: "explore",
            question: "open cabinet with key",
            methodFamily: "open-cabinet",
            expectedObservations: ["cabinet"],
            completionCriteria: "sample recovered",
            preconditions: { op: "atom", key: "has_key" },
            goalRefs: [],
            inputRefs: [],
            resourceClaims: [],
            budgetHint: {},
            reopenRule: { kind: "fact_key", key: "has_key" },
          },
        });
      }
      if (!has("try cabinet code")) {
        ops.push({
          op: "propose_step",
          step: {
            kind: "explore",
            question: "try cabinet code 0000 from the note",
            methodFamily: "try-code",
            expectedObservations: ["cabinet_code"],
            completionCriteria: "code accepted or rejected",
            preconditions: { op: "all", of: [] },
            goalRefs: [],
            inputRefs: [],
            resourceClaims: [],
            budgetHint: {},
            reopenRule: { kind: "never" },
          },
        });
      }
      if (ops.length === 0) {
        return {
          type: "tool_calls",
          calls: [{ name: "propose_plan", arguments: { operations: [], no_change_reason: "frontier already populated" } }],
        };
      }
      return { type: "tool_calls", calls: [{ name: "propose_plan", arguments: { operations: ops } }] };
    }
    return { type: "tool_calls", calls: [{ name: "finish_decision", arguments: { summary: "plan submitted or no change" } }] };
  };
}

export function executeChooser(): TurnChooser {
  return (ctx) => {
    const payload = payloadOf(ctx.messages);
    const step = payload.current_step as { question?: string; method_family?: string; kind?: string } | undefined;
    const q = `${step?.question ?? ""} ${step?.method_family ?? ""}`.toLowerCase();
    const results = lastToolResults(ctx.messages);
    const submitted = results.some((r) => r.name === "submit_observation" || r.name === "submit_fact");
    const acted = results.some((r) => r.name === "world_act" || r.name === "world_inspect");

    const plan = planForQuestion(q);
    if (!acted) {
      return { type: "tool_calls", calls: plan.actions };
    }
    if (!submitted) {
      const last = results[results.length - 1];
      let body: unknown = last?.text ?? "";
      try {
        body = JSON.parse(last?.text ?? "{}");
      } catch {
        body = last?.text;
      }
      const calls: ScriptedTurn = {
        type: "tool_calls",
        calls: [
          {
            name: "submit_observation",
            arguments: { subject: plan.subject, body },
          },
        ],
      };
      return calls;
    }
    if (plan.fact && !results.some((r) => r.name === "submit_fact")) {
      const obs = findObservationId(results);
      if (obs && plan.factWhen(results)) {
        return {
          type: "tool_calls",
          calls: [
            {
              name: "submit_fact",
              arguments: {
                proposition: plan.fact.proposition,
                fact_key: plan.fact.key,
                support_refs: [obs],
                source_grade: "observed",
              },
            },
          ],
        };
      }
    }
    const transient = results.some((r) => r.text.includes("transient failure"));
    const missing = results.some((r) => r.text.includes("missing key") || r.text.includes("drawer locked") || r.text.includes("Cannot take key"));
    let reason: "resolved" | "deferred" | "blocked" = "resolved";
    if (transient) reason = "deferred";
    else if (missing || (plan.blocked && !plan.factWhen(results))) reason = "blocked";
    return {
      type: "tool_calls",
      calls: [
        {
          name: "finish_step",
          arguments: {
            reason,
            summary: plan.summary,
            blocked_on: reason === "blocked" ? plan.blocked ?? "missing_precondition" : undefined,
          },
        },
      ],
    };
  };
}

function findObservationId(results: { name: string; text: string }[]): string | undefined {
  const sub = [...results].reverse().find((r) => r.name === "submit_observation");
  if (!sub) return undefined;
  try {
    const parsed = JSON.parse(sub.text) as { canonical_ids?: { observation_id?: string } };
    return parsed.canonical_ids?.observation_id;
  } catch {
    return undefined;
  }
}

function planForQuestion(q: string): {
  actions: { name: string; arguments: Record<string, unknown> }[];
  subject: string;
  summary: string;
  blocked?: string;
  fact?: { key: string; proposition: string };
  factWhen: (results: { name: string; text: string }[]) => boolean;
} {
  const textHas = (results: { name: string; text: string }[], s: string) => results.some((r) => r.text.includes(s));
  if (q.includes("desk") || q.includes("note")) {
    return {
      actions: [
        { name: "world_inspect", arguments: { target: "desk" } },
        { name: "world_inspect", arguments: { target: "note" } },
      ],
      subject: "note",
      summary: "recorded misleading note",
      factWhen: () => false,
    };
  }
  if (q.includes("code")) {
    return {
      actions: [{ name: "world_act", arguments: { action: "try_code", arg: "0000" } }],
      subject: "cabinet_code",
      summary: "code 0000 rejected",
      factWhen: () => false,
    };
  }
  if (q.includes("badge") || q.includes("drawer unlock")) {
    return {
      actions: [{ name: "world_act", arguments: { action: "use_badge" } }],
      subject: "badge",
      summary: "badge attempt",
      fact: { key: "drawer_open", proposition: "drawer is open" },
      factWhen: (r) => textHas(r, "Drawer latch releases") || textHas(r, "Badge accepted"),
    };
  }
  if (q.includes("take key") || q.includes("take-key")) {
    return {
      actions: [{ name: "world_act", arguments: { action: "take_key" } }],
      subject: "key",
      summary: "key attempt",
      blocked: "has_key",
      fact: { key: "has_key", proposition: "operator holds cabinet key" },
      factWhen: (r) => textHas(r, "Took brass key"),
    };
  }
  if (q.includes("cabinet")) {
    return {
      actions: [{ name: "world_act", arguments: { action: "open_cabinet" } }],
      subject: "cabinet",
      summary: "cabinet attempt",
      blocked: "has_key",
      fact: { key: "sample_recovered", proposition: "sample SAMPLE-42 recovered" },
      factWhen: (r) => textHas(r, "Sample ID"),
    };
  }
  if (q.includes("clock") || q.includes("side")) {
    return {
      actions: [
        { name: "world_inspect", arguments: { target: "clock" } },
        { name: "world_act", arguments: { action: "open_side_panel" } },
      ],
      subject: "clock",
      summary: "environment advanced",
      factWhen: () => false,
    };
  }
  if (q.includes("verify")) {
    return {
      actions: [{ name: "world_inspect", arguments: { target: "cabinet" } }],
      subject: "verify",
      summary: "verification inspect",
      factWhen: () => false,
    };
  }
  return {
    actions: [{ name: "world_inspect", arguments: { target: "desk" } }],
    subject: "desk",
    summary: "generic inspect",
    factWhen: () => false,
  };
}

export function reactChooser(): TurnChooser {
  let step = 0;
  const sequence: ScriptedTurn[] = [
    { type: "tool_calls", calls: [{ name: "world_inspect", arguments: { target: "desk" } }] },
    { type: "tool_calls", calls: [{ name: "world_inspect", arguments: { target: "note" } }] },
    { type: "tool_calls", calls: [{ name: "world_act", arguments: { action: "try_code", arg: "0000" } }] },
    { type: "tool_calls", calls: [{ name: "world_act", arguments: { action: "use_badge" } }] },
    { type: "tool_calls", calls: [{ name: "world_act", arguments: { action: "use_badge" } }] },
    { type: "tool_calls", calls: [{ name: "world_act", arguments: { action: "use_badge" } }] },
    { type: "tool_calls", calls: [{ name: "world_act", arguments: { action: "take_key" } }] },
    { type: "tool_calls", calls: [{ name: "world_act", arguments: { action: "open_cabinet" } }] },
    { type: "text", text: "done" },
  ];
  return () => sequence[Math.min(step++, sequence.length - 1)] ?? { type: "text", text: "done" };
}
