// acmer-coach 浏览器端：会话头部一个「技能树」按钮，点开是全屏技能树。
//
// ── 为什么是「弹一层 iframe」而不是把图重画一遍 ──────────────────────
// 技能树页面（knowledge/skilltree.html）是 render_skilltree.py 从 MAP.yaml
// 生成的静态页，349 个节点 401 条边。在 React 里重画一遍 = 同一张图两份实现，
// 而这两份迟早会不一致（改了一处忘另一处）。
// iframe 直接复用那一份，页面自己从 ./api/progress 读进度。
//
// 页面的提供方是 **host 端的 /coach 路由**（index.js 的 registerPages）——
// 同源，所以 iframe 不需要处理跨域，也不用另起一个 Python 进程。
//
// ── 形状是照抄谁的 ───────────────────────────────────────────────
// @deepseek-ai/dsh-session-log-export（官方包，同一个 dsh 版本）：
// 同样是「header.utilities 里一个按钮 + 一个浮层」。
// 差异只有一处：它用 primitives 的 Modal/Button，那两个组件是官方的
// 内部包（@deepseek-ai/dsh-client-ui-primitives 不在第三方能 require 的
// 名单里），所以浮层和样式这里自己写 —— 颜色全走 dsh 的 CSS 变量，
// 换主题自动跟着走。
//
// ⚠️ factory 必须 return {apply, inject}。少了它 slot 系统会拿到 undefined，
// 报错信息是 "received undefined"，跟根因隔了十万八千里（踩过一次）。
window.__ModuleLoader__.load({
  id: "acmer-coach",
  factory: (require) => {
    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { createPortal } = require("react-dom");

    const CSS_ID = "acmer-coach-skilltree-css";
    const CSS = `
.dshcoach-btn {
  display: inline-flex; align-items: center; gap: 4px;
  height: 32px; padding: 6px 12px; min-width: 0;
  font-family: var(--dsw-font-family, inherit); font-size: 13px; font-weight: 400;
  line-height: 20px; white-space: nowrap;
  color: var(--dsw-alias-label-primary, #e6edf3);
  background: transparent; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.15));
  border-radius: 18px;
}
.dshcoach-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }
.dshcoach-btn span, .dshcoach-btn svg { flex: none; }

.dshcoach-mask {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .55);
  backdrop-filter: blur(2px);
}
.dshcoach-panel {
  display: flex; flex-direction: column; overflow: hidden;
  width: min(1400px, 94vw); height: 90vh;
  background: var(--dsw-alias-bg-base, #0d1117);
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.15));
  border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, .5);
}
.dshcoach-bar {
  display: flex; align-items: center; gap: 8px; flex: none;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.08));
}
.dshcoach-title {
  display: flex; align-items: center; gap: 7px;
  flex: 1; min-width: 0;
  font-family: var(--dsw-font-family, inherit); font-size: 14px;
  color: var(--dsw-alias-label-primary, #e6edf3);
}
.dshcoach-title svg { flex: none; }
.dshcoach-action {
  font: inherit; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary, #8b949e);
  background: transparent; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.15));
  border-radius: 6px; padding: 3px 10px;
}
.dshcoach-action:hover { color: var(--dsw-alias-label-primary, #e6edf3); }
.dshcoach-frame { flex: 1; width: 100%; border: 0; display: block; }
`;

    function injectStyle() {
      if (document.getElementById(CSS_ID)) return;
      const style = document.createElement("style");
      style.id = CSS_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const PAGE_URL = "/coach/skilltree.html";

    // VP（CompetitionWhale）的品牌标：**拱**是露出水面的鲸背，**波浪**是水面，两笔。
    //
    // 为什么不是 emoji：🐋 在不同系统上画风不一（Windows 是蓝色写实鲸、Mac 是另一个样），
    // 而且它自带颜色 —— 深色/浅色主题切换时不会跟着走。线框 SVG 走 currentColor，
    // 主题怎么变它怎么变。
    //
    // 形状是照着一张位图标描的（338×72 的鲸鱼 logo 截图）：
    // 把图标区域二值化后按**原始分辨率**打成字符网格读出控制点 ——
    // 拱顶在 (16.5,3)、两腿撇到 (7.5,11)/(25.5,11)；波浪是
    // 起(2,17.5) → 峰(9,14) → 谷(16,17.5) → 峰(23,14) → 收(30,17.5)。
    // 两腿往外撇（像「人」字）是描图时才看出来的细节，垂直腿一眼就假。
    function WhaleMark({ size = 15 }) {
      return jsxs("svg", {
        width: Math.round(size * (34 / 22)),
        height: size,
        viewBox: "0 0 34 22",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
        children: [
          jsx("path", { d: "M7.5 11 C8.5 5.5 11.5 3 16.5 3 C21.5 3 24.5 5.5 25.5 11" }),
          jsx("path", { d: "M2 17.5 C5.5 17.5 6 14 9 14 C12 14 12.8 17.5 16 17.5 C19.2 17.5 20 14 23 14 C26 14 26.5 17.5 30 17.5" }),
        ],
      });
    }

    /** 全屏浮层：一条窄栏 + 撑满的 iframe。 */
    function SkillTreeOverlay({ onClose }) {
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [onClose]);

      return jsx("div", {
        className: "dshcoach-mask",
        // 点背景关（点面板内部不关 —— 判据是 target 就是遮罩本身）
        onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
        children: jsxs("div", {
          className: "dshcoach-panel",
          children: [
            jsxs("div", {
              className: "dshcoach-bar",
              children: [
                jsxs("div", {
                  className: "dshcoach-title",
                  children: [jsx(WhaleMark, { size: 17 }), jsx("span", { children: "技能树" })],
                }),
                jsx("button", {
                  type: "button",
                  className: "dshcoach-action",
                  onClick: () => window.open(PAGE_URL, "_blank", "noopener"),
                  children: "新标签页打开",
                }),
                jsx("button", {
                  type: "button",
                  className: "dshcoach-action",
                  onClick: onClose,
                  children: "✕ 关闭",
                }),
              ],
            }),
            jsx("iframe", {
              className: "dshcoach-frame",
              src: PAGE_URL,
              title: "技能树",
            }),
          ],
        }),
      });
    }

    /** 头部那个按钮 + 它开出来的浮层。 */
    function SkillTreeHeaderButton() {
      const [open, setOpen] = React.useState(false);
      return jsxs(React.Fragment, {
        children: [
          jsxs("button", {
            type: "button",
            className: "dshcoach-btn",
            title: "看当前知识点地图与进度",
            onClick: () => setOpen(true),
            children: [jsx(WhaleMark, { size: 15 }), jsx("span", { children: "技能树" })],
          }),
          // 关掉 = 卸载。iframe 跟着销毁，下次开是新拉的页面 ——
          // 进度是页面向 host 要的，不会因此读到过期数据。
          //
          // ⚠️ 必须 portal 到 body，**不能**就地渲染。踩过：header 元素上挂着
          // `transform: matrix(1,0,0,1,0,0)`（看着"没位移"，但它照样建立了
          // containing block），于是 `position: fixed` 的遮罩改成相对 **header**
          // 定位 —— 755px 高的面板在 75px 高的 header 里居中，y 算出来是 -340，
          // 整个弹层跑到屏幕外面去了。CDP 实测：panel y=-340。
          // 这是 CSS 的规矩，不是 dsh 的 bug：transform 非 none 的祖先就是
          // fixed 后代的包含块。portal 到 body 是标准解法。
          open ? createPortal(jsx(SkillTreeOverlay, { onClose: () => setOpen(false) }), document.body) : null,
        ],
      });
    }

    // 服务名注入（不是模块名）：等 slots 服务到位再注册。
    const inject = ["slots"];

    function apply(ctx) {
      injectStyle();
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
        name: "conversation.session.header.utilities",
        id: "acmer-coach:skilltree",
        order: 20,
        registrant: "acmer-coach",
      }, SkillTreeHeaderButton));
    }

    return { apply, inject };
  },
});
