export interface DeadlineResult<T> {
  ok: boolean;
  value?: T;
  residual: "none" | "uncertain" | "timeout";
}

export async function runWithOuterDeadline<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>,
  ignoresAbort = false,
): Promise<DeadlineResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const work = fn(ctrl.signal);
    const raced = await Promise.race([
      work.then((value) => ({ tag: "ok" as const, value })),
      new Promise<{ tag: "timeout" }>((resolve) => {
        ctrl.signal.addEventListener("abort", () => resolve({ tag: "timeout" }));
      }),
    ]);
    if (raced.tag === "timeout") {
      if (!ignoresAbort) {
        return { ok: false, residual: "timeout" };
      }
      return { ok: false, residual: "uncertain" };
    }
    return { ok: true, value: raced.value, residual: "none" };
  } finally {
    clearTimeout(timer);
  }
}
