/**
 * 洛谷记录导出 —— 给 acmer-coach 用的一个按钮。
 *
 * 它做且只做一件事：**把当前这一页里已经存在的记录数据抠出来，存成 JSON 文件。**
 *
 * ── 设计上的三个「不做」，每一个都是被逼的 ──
 *
 * 1. **不发任何网络请求。** 包括不发给你自己的 coach 插件。
 *    早期版本是 POST 给一台服务器落库，但那样要处理鉴权、端口发现、
 *    以及"扩展能往本机哪个端口发"这一堆事；而且你没法确认它到底发了什么。
 *    现在它只读当前页面 + 存文件 —— **对洛谷来说，这跟"用户自己在看页面"没有区别**。
 *
 * 2. **不自己 fetch 数据接口。** 洛谷对 `_contentOnly=1` 那种 XHR 请求会返回
 *    首页壳（HTTP 200 + text/html），换账号、换登录态都一样。
 *    但你自己打开记录页时，服务端直出的数据是**完整嵌在页面里**的
 *    （某个 <script> 里躺着 {"instance":"main","template":"record.list",…,"data":{…}}），
 *    字段和接口返回值一模一样。所以读"已经在你眼前的那份"就够了。
 *
 * 3. **不解析、不改写。** 导出的是原始记录（`status` 还是洛谷的数字码），
 *    映射成 AC / 不 AC 是插件那边的事 —— 扩展不该持有第二份判断逻辑。
 *
 * ⚠️ 风险：洛谷的服务条款不欢迎抓取，且**已有账号因此被封的先例**。
 *    本扩展做的是"读你自己屏幕上已经显示的内容"，风险显著低于爬虫，
 *    但不等于零。用不用你自己判断 —— 见同目录 README。
 */

(() => {
  if (window.__acmerCoachExportLoaded) return;
  window.__acmerCoachExportLoaded = true;

  const UI_ID = 'acmer-coach-export';

  /** 从当前页面的 <script> 里抠出记录数据。找不到返回 null。 */
  function readPageRecords() {
    for (const s of document.querySelectorAll('script')) {
      const t = (s.textContent || '').trim();
      // 只可能是内嵌的 JSON 对象；日志/统计脚本一堆，先按形状筛
      if (t.length < 200 || t[0] !== '{') continue;
      let j = null;
      try { j = JSON.parse(t); } catch { continue; }
      const recs = j?.data?.records;
      if (recs && Array.isArray(recs.result)) {
        return { records: recs.result, count: typeof recs.count === 'number' ? recs.count : null };
      }
    }
    return null;
  }

  /** 这一页是谁的？优先看 URL 的 ?user=，没有就从记录自带的 user.uid 认。 */
  function pageUid(page) {
    const u = new URLSearchParams(location.search).get('user');
    if (u && /^\d+$/.test(u)) return Number(u);
    const first = page?.records?.[0];
    return first?.user?.uid ? Number(first.user.uid) : null;
  }

  /**
   * 原始记录 → 导入格式。
   * **只搬运，不解释** —— verdict 保留洛谷的原始数字码，插件那边认 `12` 是 AC。
   */
  function toImportFormat(records) {
    return records.map((r) => ({
      platform: 'luogu',
      problem_id: r?.problem?.pid || r?.pid || '',
      verdict: String(r?.status ?? ''),
      submitted_at: r?.submitTime ? new Date(r.submitTime * 1000).toISOString() : '',
      time_ms: Number(r?.time ?? 0) || 0,
      language: String(r?.language ? `lang${r.language}` : ''),
    })).filter((r) => r.problem_id)
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ── UI：右下角一个小圆钮 ────────────────────────────────────────
  function build() {
    if (document.getElementById(UI_ID)) return;
    const box = document.createElement('div');
    box.id = UI_ID;
    box.style.cssText = [
      'position:fixed', 'right:18px', 'bottom:18px', 'z-index:2147483647',
      'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif',
    ].join(';');
    box.innerHTML = `
      <button id="${UI_ID}-btn" style="all:unset;cursor:pointer;background:#1a1a1a;color:#fff;
        padding:9px 14px;border-radius:20px;box-shadow:0 2px 10px rgba(0,0,0,.25);user-select:none">
        📥 导出洛谷记录
      </button>
      <div id="${UI_ID}-msg" style="margin-top:6px;max-width:260px;padding:6px 10px;border-radius:8px;
        background:#fff;color:#333;box-shadow:0 2px 10px rgba(0,0,0,.15);display:none;white-space:pre-wrap"></div>
    `;
    document.body.appendChild(box);

    const msg = box.querySelector(`#${UI_ID}-msg`);
    const say = (t, ms = 6000) => {
      msg.textContent = t;
      msg.style.display = 'block';
      clearTimeout(say._t);
      if (ms) say._t = setTimeout(() => { msg.style.display = 'none'; }, ms);
    };

    box.querySelector(`#${UI_ID}-btn`).addEventListener('click', () => {
      const page = readPageRecords();
      if (!page) {
        say('这个页面上没有记录数据。\n请打开「评测记录」页再点 —— \nwww.luogu.com.cn/record/list?user=你的uid');
        return;
      }
      const rows = toImportFormat(page.records);
      if (!rows.length) { say('这一页里没解析出记录。'); return; }
      const uid = pageUid(page) ?? 'unknown';
      const fname = `luogu-${uid}-${new Date().toISOString().slice(0, 10)}.json`;
      download(fname, JSON.stringify(rows));

      const total = page.count ?? '?';
      say(`已导出 ${rows.length} 条 → ${fname}\n` +
          (typeof page.count === 'number' && page.count > page.records.length
            ? `⚠️ 这个号总共有 ${total} 条记录，**这一页只是第一页**。\n` +
              `要全部的话得逐页打开再各点一次（翻页会带上 page= 参数）。`
            : `总共 ${total} 条，都在这一页里了。`) +
          `\n\n把这个文件交给教练：说一句「导入这个文件」+ 路径。`);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
