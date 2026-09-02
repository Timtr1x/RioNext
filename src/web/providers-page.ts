export function providerUiHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>RioNext 槽位配线</title>
<style>
  :root { --bg:#16140f; --paper:#efe6d2; --ink:#1c1810; --amber:#d97706; --ok:#3f6b4a; --bad:#8f2d2d; --mute:#7a7264; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:"IBM Plex Mono","Cascadia Mono",ui-monospace,monospace; background:var(--bg); color:var(--paper); }
  header { padding:28px 32px 12px; border-bottom:1px solid #3a3428; }
  header h1 { font-size:18px; font-weight:500; letter-spacing:.12em; text-transform:uppercase; margin:0 0 6px; }
  header p { margin:0; color:var(--mute); font-size:12px; }
  main { display:grid; grid-template-columns: 1.1fr .9fr; gap:24px; padding:24px 32px 48px; }
  @media (max-width:960px){ main { grid-template-columns:1fr; } }
  section { background:#1e1b15; border:1px solid #3a3428; padding:18px; }
  h2 { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--amber); margin:0 0 14px; }
  label { display:block; font-size:11px; color:var(--mute); margin:10px 0 4px; }
  input, select { width:100%; background:#12100c; color:var(--paper); border:1px solid #4a4336; padding:8px 10px; font:inherit; }
  button { background:var(--amber); color:#1c1408; border:0; padding:9px 14px; font:inherit; cursor:pointer; margin-top:12px; }
  button.ghost { background:transparent; color:var(--paper); border:1px solid #4a4336; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .lamp { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:#4a4336; }
  .lamp.ok { background:#6ee7a8; box-shadow:0 0 8px #6ee7a8; }
  .lamp.bad { background:#fb7185; }
  .slots { display:grid; gap:8px; }
  .jack { display:flex; justify-content:space-between; align-items:center; border:1px dashed #4a4336; padding:8px 10px; font-size:12px; }
  pre { white-space:pre-wrap; font-size:11px; color:#d6cbb3; background:#12100c; padding:10px; min-height:80px; }
  .list { font-size:12px; line-height:1.6; }
</style>
</head>
<body>
<header>
  <h1>RioNext patchbay</h1>
  <p>能力感知 · 多槽位路由 · 视觉短语探测。Key 不会回显。</p>
</header>
<main>
  <div>
    <section>
      <h2>1 添加 Provider</h2>
      <label>显示名称</label><input id="p-name" placeholder="Anthropic 官方"/>
      <label>协议</label>
      <select id="p-proto">
        <option>ANTHROPIC_MESSAGES</option>
        <option>OPENAI_CHAT_COMPLETIONS</option>
        <option>OPENAI_RESPONSES</option>
      </select>
      <label>接口地址</label><input id="p-url" placeholder="https://api.anthropic.com"/>
      <label>上游 API Key</label><input id="p-key" type="password" autocomplete="off"/>
      <button id="p-add">保存供应商</button>
    </section>
    <section style="margin-top:16px">
      <h2>2 添加 Model</h2>
      <label>供应商</label><select id="m-provider"></select>
      <label>模型名</label><input id="m-name" placeholder="claude-sonnet-4-6"/>
      <div class="row">
        <div><label>上下文窗口</label><input id="m-ctx" type="number" value="256000"/></div>
        <div><label>最大输出 token</label><input id="m-out" type="number" value="51200"/></div>
      </div>
      <label><input id="m-vision" type="checkbox"/> 视觉能力（不勾选则按模型名推断）</label>
      <button id="m-add">保存模型</button>
    </section>
  </div>
  <div>
    <section>
      <h2>3 测试连接</h2>
      <label>模型</label><select id="t-model"></select>
      <button id="t-run">测试 鉴权 / 文本 / 工具 / 视觉</button>
      <pre id="t-out">尚未测试</pre>
    </section>
    <section style="margin-top:16px">
      <h2>4 槽位分配</h2>
      <div class="slots" id="slots"></div>
      <p class="list" id="resolved"></p>
    </section>
    <section style="margin-top:16px">
      <h2>目录</h2>
      <div class="list" id="dir"></div>
    </section>
  </div>
</main>
<script>
async function api(path, body){
  const r = await fetch(path, body ? { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
let catalog = { providers:[], models:[], slots:[] };
async function refresh(){
  catalog = await api('/api/catalog');
  const ps = catalog.providers.map(p => '<option value="'+p.id+'">'+p.display_name+' ('+p.protocol+')</option>').join('');
  document.getElementById('m-provider').innerHTML = ps;
  const ms = catalog.models.map(m => '<option value="'+m.id+'">'+m.name+(m.vision?' · vision':'')+'</option>').join('');
  document.getElementById('t-model').innerHTML = ms;
  const opts = '<option value="none">none</option>' + catalog.models.map(m => '<option value="'+m.id+'">'+m.name+'</option>').join('');
  document.getElementById('slots').innerHTML = (catalog.slots||[]).map(s => {
    return '<div class="jack"><span>'+s.slot+'</span><select data-slot="'+s.slot+'">'+opts+'</select></div>';
  }).join('');
  document.querySelectorAll('select[data-slot]').forEach(sel => {
    const s = catalog.slots.find(x => x.slot === sel.dataset.slot);
    if (s && s.model_id) sel.value = s.model_id;
    sel.onchange = async () => { await api('/api/slots', { slot: sel.dataset.slot, ref: sel.value }); refresh(); };
  });
  document.getElementById('dir').innerHTML = catalog.providers.map(p => p.display_name+' · '+p.protocol+' · '+(p.api_key_set?'key set':'no key')).join('<br/>')
    + '<br/>' + catalog.models.map(m => m.name+' vis='+m.vision+' avail='+m.available).join('<br/>');
}
document.getElementById('p-add').onclick = async () => {
  await api('/api/providers', { display_name: pName.value, protocol: pProto.value, base_url: pUrl.value, api_key: pKey.value });
  pKey.value=''; refresh();
};
document.getElementById('m-add').onclick = async () => {
  const visionBox = document.getElementById('m-vision');
  await api('/api/models', {
    provider_id: document.getElementById('m-provider').value,
    name: document.getElementById('m-name').value,
    context_window: Number(document.getElementById('m-ctx').value),
    max_output_tokens: Number(document.getElementById('m-out').value),
    vision: visionBox.checked ? true : undefined
  });
  refresh();
};
document.getElementById('t-run').onclick = async () => {
  const out = document.getElementById('t-out');
  out.textContent = 'testing...';
  try {
    const model_id = document.getElementById('t-model').value;
    const model = catalog.models.find(m => m.id === model_id);
    const r = await api('/api/test', { provider_id: model.provider_id, model_id });
    const rep = r.report;
    out.textContent = ['auth','text','tools','vision'].map(k => {
      const it = rep[k];
      return (it.ok?'OK ':'FAIL ') + k + '  ' + it.detail;
    }).join('\\n');
  } catch(e){ out.textContent = String(e.message||e); }
};
const pName = document.getElementById('p-name');
const pProto = document.getElementById('p-proto');
const pUrl = document.getElementById('p-url');
const pKey = document.getElementById('p-key');
refresh();
</script>
</body>
</html>`;
}
