export function nextSeq(store: { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown } } }, campaignId: string): number {
  const row = store.db.prepare("SELECT event_head FROM campaigns WHERE id = ?").get(campaignId) as
    | { event_head: number }
    | undefined;
  if (!row) throw new Error(`campaign not found: ${campaignId}`);
  const seq = row.event_head + 1;
  store.db.prepare("UPDATE campaigns SET event_head = ?, updated_at = ? WHERE id = ?").run(seq, new Date().toISOString(), campaignId);
  return seq;
}
