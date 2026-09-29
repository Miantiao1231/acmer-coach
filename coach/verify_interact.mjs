// 用 CDP 原生鼠标事件验交互：
//   1) 悬停节点 → 不该亮路径
//   2) 点击节点 → 该亮路径
//   3) 点空白   → 该收起
//   4) 拖一把   → 面板不该被顺手关掉
// 合成事件测不出这些（不会走原生命中测试），必须用 Input.dispatchMouseEvent。
const BASE = 'http://127.0.0.1:9222';
const NODE = process.argv[2] || '树链剖分';

const list = await (await fetch(`${BASE}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /skilltree/.test(t.url));
if (!page) { console.log('找不到 skilltree 页面'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((res) => { const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
});
await new Promise((res) => ws.addEventListener('open', res));
const { sessionId } = await send('Target.attachToTarget', { targetId: page.id, flatten: true });

const evalIn = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId))?.result?.value;
const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent',
    { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra },
    sessionId);

// 数「看得见的」高亮 —— 光数类名会把 display:none 的也算进去
const snap = () => evalIn(`JSON.stringify({
  hotNodes: [...document.querySelectorAll('.node.hot')].filter(e=>e.style.display!=='none').length,
  hotEdges: [...document.querySelectorAll('path.edge.hot')].filter(e=>e.style.display!=='none').length,
  staleEdges: [...document.querySelectorAll('path.edge.hot')].filter(e=>e.style.display==='none').length,
  panel: document.querySelector('#panel').classList.contains('on'),
})`).then(JSON.parse);

const at = async (id) => JSON.parse(await evalIn(
  `(() => { const g=[...document.querySelectorAll('.node')].find(e=>e.dataset.id===${JSON.stringify(id)});
    if(!g) return 'null'; const r=g.getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2}); })()`));

const pos = await at(NODE);
if (!pos) { console.log(`节点 ${NODE} 不在视口里`); process.exit(1); }
const out = {};

// 1) 悬停
await mouse('mouseMoved', pos.x, pos.y, { button: 'none', buttons: 0 });
await new Promise((r) => setTimeout(r, 250));
out['1_悬停'] = await snap();

// 2) 点击
await mouse('mousePressed', pos.x, pos.y);
await mouse('mouseReleased', pos.x, pos.y);
await new Promise((r) => setTimeout(r, 250));
out['2_点击后'] = await snap();

// 3) 拖一把（面板应保留）
await mouse('mousePressed', 500, 800);
for (let i = 1; i <= 8; i++) await mouse('mouseMoved', 500 + i * 12, 800 + i * 4);
await mouse('mouseReleased', 596, 832);
await new Promise((r) => setTimeout(r, 250));
out['3_拖拽后'] = await snap();

// 4) 点空白（面板应收起）
await mouse('mousePressed', 300, 900);
await mouse('mouseReleased', 300, 900);
await new Promise((r) => setTimeout(r, 250));
out['4_点空白后'] = await snap();

out['判定'] = {
  '悬停不亮': out['1_悬停'].hotEdges === 0 && out['1_悬停'].hotNodes === 0,
  '点击才亮': out['2_点击后'].hotEdges > 0 && out['2_点击后'].panel,
  '拖拽不误关': out['3_拖拽后'].panel === true,
  '点空白收起': out['4_点空白后'].panel === false && out['4_点空白后'].hotNodes === 0,
};
console.log(JSON.stringify(out, null, 2));
ws.close();
