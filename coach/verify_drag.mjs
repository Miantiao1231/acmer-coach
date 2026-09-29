// 用 CDP 原生鼠标事件做一次真实拖拽，再看有没有选出一堆文字。
// 合成事件（dispatchEvent）不会触发浏览器的原生选区，只有 Input.dispatchMouseEvent 才算数。
const BASE = 'http://127.0.0.1:9222';

const r = await (await fetch(`${BASE}/json/list`)).json();
const page = r.find((t) => t.type === 'page' && /skilltree/.test(t.url));
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

const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent',
    { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra },
    sessionId);

const evalIn = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  return r?.result?.value;
};

// 先看看拖之前图上有没有残留选区
await evalIn('getSelection().removeAllRanges()');

await mouse('mousePressed', 800, 600);
for (let i = 1; i <= 12; i++) await mouse('mouseMoved', 800 - i * 25, 600 - i * 22);  // 真实拖拽轨迹
await mouse('mouseReleased', 500, 336);

const sel = await evalIn('getSelection().toString().slice(0,120)');
const selLen = await evalIn('getSelection().rangeCount ? getSelection().getRangeAt(0).toString().length : 0');
const moved = await evalIn('document.querySelector("svg").style.transform');

console.log(JSON.stringify({
  选中文字长度: selLen,
  选中内容: sel,
  是否平移: /translate\(/.test(moved || '') && !/translate\(28px/.test(moved || ''),
  当前transform: moved,
}, null, 2));
ws.close();
