export interface CampaignSummary {
  id: string;
  state: string;
  updated_at: string;
  pending_goal_claim: { id: string; proposition: string; fact_key: string } | null;
}

export function formatList(rows: CampaignSummary[]): string {
  if (!rows.length) return "no campaigns in this data dir. rionext run --spec <file>";
  const width = Math.max(...rows.map((r) => r.id.length), 8);
  return rows
    .map((r) => {
      const flag = r.pending_goal_claim ? `  pending ${r.pending_goal_claim.proposition}` : "";
      return `${r.id.padEnd(width)}  ${r.state}${flag}`;
    })
    .join("\n");
}

export function formatStatus(s: Record<string, unknown>): string {
  const id = String(s.campaign_id ?? "");
  const state = String(s.state ?? "");
  const lines = [`${id}  ${state}`];
  const pending = s.pending_goal_claim as { proposition?: string; fact_key?: string; id?: string } | null;
  if (state === "awaiting_verify" || pending) {
    lines.push(`pending flag  ${pending?.proposition ?? "(none)"}`);
    lines.push(`verify        rionext accept ${id}`);
    lines.push(`              rionext reject ${id} --text "flag不正确" --continue`);
  }
  if (s.root_goal_satisfied) lines.push("goal          verified");
  const budget = s.budget as Record<string, unknown> | undefined;
  if (budget) {
    lines.push(`calls         ${budget.spent_calls}/${budget.total_calls}  free ${budget.free_calls}`);
    lines.push(`tokens        ${budget.spent_tokens}/${budget.total_tokens}`);
  }
  if (s.candidates_ready != null) lines.push(`ready steps   ${s.candidates_ready}`);
  const run = s.active_run as { id?: string; mode?: string; state?: string } | null;
  if (run) lines.push(`active run    ${run.mode} ${run.state} ${run.id}`);
  return lines.join("\n");
}

export function formatVerify(result: Record<string, unknown>, id: string, accept: boolean): string {
  const state = String(result.state ?? "");
  const prop = result.proposition ? String(result.proposition) : "";
  if (accept) {
    return [`accepted  ${id}  ${state}`, prop ? `flag      ${prop}` : ""].filter(Boolean).join("\n");
  }
  const next = state === "active" ? `next      rionext start ${id}` : "";
  return [`rejected  ${id}  ${state}`, prop ? `was       ${prop}` : "", "hint injected into campaign context", next]
    .filter(Boolean)
    .join("\n");
}
