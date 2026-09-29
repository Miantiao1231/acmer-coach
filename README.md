# acmer-coach · 小鲸教练

一个给 ACMer 用的算法训练教练插件，跑在 [dsh](https://github.com/deepseek-ai/deepseek-harness) 上。

**它解决的问题**：不是「不知道学什么」——那是搜一下就有答案的。
是「**不知道现在该学哪一个、该投多少精力**」。

这两件事的差别值得说清楚：

- 网站给的是**池子**（可以无限，你自己挑）
- 教练给的是**位置**（必须唯一，有人替你担责）

所以这个插件不给你候选列表。你问「今天干什么」，答案**是一个动作**，
带时间盒和交付物。

## 它到底做了什么

20 个工具，两条轴：

| 轴 | 含义 |
|---|---|
| `tier` | 这个知识点在赛场上重不重要 |
| `entry` | 什么水平**学得起**（题池 p25 ≈ 入门段位） |

核心闭环：

```
coach_setup     首次：体检 → 建目录建库 → 灌题池 → 从 CF 同步数据
coach_import    洛谷/牛客的记录从这里进（CF 不用，有公开接口）
  ↓
coach_next      看游标能开哪些节点（前置满足的）
  ↓
coach_assign    布置**一个**动作：做什么 + 时间盒 + 交付物
  ↓
coach_diagnose  没过 → 读代码判因（不会 / 不熟 / 不认真），每条要引你代码原文
coach_log       过了 → 记一条，然后夸
  ↓
coach_pool → coach_test → coach_grade    章节检测，过了才标「已验证」
  ↓
coach_schedule → coach_plan              排课
```

`coach_wiki` 是知识来源：讲任何知识点之前先查本地 OI Wiki，**别凭记忆讲**。

**「学过」和「已验证」是两级，绝不合并。** 自评 ≠ 掌握 ——
合成一个「会/不会」就等于退回「从数据推断掌握度」，而数据能说「花了很久」，
说不出「卡在哪」。所以 `verified` 手标不了，它只能由检测产生。

## 装

```bash
# 1. 装 dsh（需要 Node ≥ 24）
npm i -g @deepseek-ai/dsh

# 2. 装插件（二选一）
dsh plugin --profile web add acmer-coach                        # 从 npm（推荐）
dsh plugin --profile web add github:Miantiao1231/acmer-coach    # 或从 GitHub

# 3. 重启 dsh，然后跟小鲸说「初始化」
```

> npm 上搜 `acmer-coach`，或者直接开 <https://www.npmjs.com/package/acmer-coach>。

**初始化流程**（说话就行，不用敲命令）：

1. `coach_setup { action: "status" }` —— 体检，看缺什么
2. `coach_setup { action: "init" }` —— 建数据目录、铺地图、建训练库
3. 它会问你 CF handle，然后 `coach_setup { action: "sync", handle: "..." }`

**同步不需要 CF 登录、不需要 API key** —— 用的都是 CF 的公开接口
（`user.info` / `user.status` / `problemset.problems`）。
同步只搬运**事实**：你过了哪些题、什么难度。**它不推断你会什么。**

> ⚠️ **改完代码必须重启**：cordis 的 HMR 只重载配置，不重新 import 模块本体。
> ESM 模块在进程里只求值一次，之后永远命中缓存 —— 旧代码继续跑，
> **不报错、不报警**。唯一例外是只改浏览器端（`lib/client.js`），刷新页面即可。

### 首次使用：前两周它就是在瞎猜

**说清楚这一点**：装完它对你一无所知。没有检测记录、没有判因台账，
它给的判断只能靠猜。这不是 bug，是数据不够。

大概做几次检测之后才开始准。别在前两周就下结论。

**定位不是"推断"，是二分搜索。** 349 个节点，第一次怎么知道你在哪：

```
拉 CF 的 AC 记录 + 标签
  → 映射到地图节点，算「接触证据」（相关题过了几道、什么难度）
  → 挑「有证据、且前置也都有证据」的**最深**节点当起点候选
  → 出卷考一次确认
      过了 → 往前走
      不过 → 往回退一层
  → 几次收敛
```

为什么不做成「拉数据自动算出你会什么」：**试过，证伪了。**
一个人某题提交 11 次，数据能说"花了很久"，说不出"缺哪个机制"。
"他碰过"和"他会"是两件事，前者能从数据看出来，后者只能靠检测。

## 三个平台怎么接

**题池是随包发的**（41,518 道，三个平台），`coach_setup init` 时灌进本地库。
没有它 `coach_pool` 挑不出「他没做过」的题 —— 那个条件永远满足不了。

**提交记录**是另一回事，三个平台难度差很多：

| 平台 | 题池 | 提交记录 | 怎么拿 |
|---|---|---|---|
| **Codeforces** | ✓ | ✓ | **官方公开接口**，`coach_setup { action: "sync", handle: "..." }` 一条命令，不需要登录 |
| **Nowcoder** | ✓ | — | 没有公开的记录接口。走 `coach_import`（自己导出 / 手敲） |
| **Luogu** | ✓ | — | 同上。仓库里带了个**可选**的浏览器扩展，见下 |

### ⚠️ 洛谷：先说风险

洛谷的服务条款不欢迎抓取，而且**这个项目的原版有账号因爬取被封的真实先例**。
题池里那 16,483 道洛谷题是爬来的（见 `assets/pool/LICENSE`）。

`assets/extension/luogu/` 里带了一个扩展，它**不发任何网络请求** ——
只读你屏幕上已经显示的内容，然后让你下载一个文件。比爬虫轻得多，**但不等于零**。

**用不用你自己判断。** 不想担风险的话：只关注 CF（零风险），
或者手动记几道题。详见 `assets/extension/luogu/README.md`。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件本体（host 端，20 个工具 + 规则注入） |
| `lib/setup.js` | 环境搭建 + CF 公开数据同步 |
| `lib/client.js` | 浏览器端：会话头部「技能树」按钮 + 弹层 |
| `package.json` | 声明 `dsh.bundle.patch` + `dsh.client` |
| `cordis.patch.yml` | bundle 层的 insert 行 |
| `progress-cli.mjs` | 进度 CLI。**它不自己实现规则**，只翻译 argv |
| `verify.mjs` | 验收（几百条机器检查）。跑的是**已安装副本**，不是源码 |
| `verify-shape.mjs` | 形状扫描：把每个工具的返回值喂回它自己的 `output.schema`，抓「返回里有、schema 里没有」这类只在运行时才炸的错 |
| `dev.sh` | 开发回路：同步 + 验收，一条命令 |
| `build-node-meta.mjs` | 算每个节点的 `entry`（跑题池，离线） |
| `assets/rules/` | **教练规则** —— 由插件注入 system prompt |
| `assets/knowledge/` | 地图与元数据 |
| `assets/oiwiki/` | OI Wiki 本地检索库 |
| `assets/pool/` | 随包发的题池（41,518 道，三平台）—— 见该目录下的 LICENSE（有风险说明） |
| `assets/extension/` | 可选的浏览器扩展（洛谷记录导出） |
| `coach/` | 地图工具链（Python）+ 指标脚本 |

### 三层

| 层 | 内容 | 怎么生效 |
|---|---|---|
| **规则** | `assets/rules/coach-rules.md` | 插件用 `systemPrompt.section()` 注进 system prompt（和人设同一条路）。**改它要重启 dsh** |
| **知识** | 地图 4 份 + OI Wiki 检索库 | `coach_setup init` 铺到数据目录；OI Wiki 直接从包里读 |
| **工具** | 19 个 | 装完就在 |

规则进的是 **system prompt，不是消息流**：行为约束每轮都得在场，
而消息流会被长对话把尾巴挤掉。文本是**静态**的（只在加载时读一次）——
每轮现算会打穿 prompt cache。

### assets/knowledge/

| 文件 | 内容 |
|---|---|
| `MAP.yaml` | 349 个知识点 / 401 条前置边。**由 `coach/build_map.py` 生成，别手改** |
| `DEPENDS.yaml` | 前置关系的**唯一真相源**（人维护），改它再重跑 `build_map.py` |
| `NODE_ENTRY.yaml` | 每个节点的入门段位（题池 p25），机器算 |
| `NODE_META.yaml` | `tier` 标注（core / normal / rare / skip），人维护 |

`PROGRESS.yaml` 和 `SCHEDULE.yaml` **不随包发** —— 它们是你的进度和日程，
首次写入时由插件自己生成（带正确的文件头）。发模板等于给文件头造第二份真相。

## 开发回路

```bash
bash dev.sh          # 同步副本 + 验收 + 形状扫描 + 比账本指纹
```

单独跑：

```bash
node verify.mjs && node verify-shape.mjs      # 主验收
node dev/w1-check.mjs                          # 解绑 + 闸门 + 规则注入
node dev/wiki-check.mjs                        # OI Wiki 检索
node dev/setup-check.mjs                       # 冷启动（离线）
COACH_TEST_NET=1 node dev/setup-check.mjs <handle>   # 冷启动（真打 CF）
bash dev/trace-scan.sh                         # 开源前反证：没留私人痕迹
```

同步用 `cp`，**不走 `dsh plugin remove/add`** —— 那条路实测不可靠
（pnpm 可能只复制 store 里的缓存版本，于是 add 打印成功、副本却仍是旧的）。

`verify.mjs` 第 0 关是第二道保险：源码和副本不一致就 `exit 1`，不许往下测。

## 设计上的几个坑（都踩过，写下来）

**1. `file:` 依赖装出来的是硬链接，不是拷贝。**
原地写两边同变，但**改名式写入**（Edit 工具、VS Code 原子保存、
`vim backupcopy=no`）会断开链接 —— 断开后两边分家，而 `dsh plugin add`
认不出分家、**不重链也不报错**。于是「改完 → 重装 → 测试绿」能一路绿到底，
验的却是老代码。这是静默的，所以 `dev.sh` 逐个文件比 inode，
`verify.mjs` 第 0 关再比一次内容。

**2. 同一件事别写两遍。**
夹具写接口的闸门，判据和 `DATA_DIR` **必须同源、同一时刻捕获**。
早先判据是"调用时读环境变量"、而 `DATA_DIR` 是"加载时定"——
两个时刻的事实可以不一样，于是出现「数据目录是默认的、闸门却放行」。
闸门自己长出了它要防的那种 bug。

**3. 查不到的时候，不许硬凑。**
`coach_wiki` 的检索把查询词分两档：整串/词（**必须命中**）和中文二元组
（**只参与打分**）。二元组太松 ——「不存在的知识点」能切出「知识」「存在」，
满库都是，于是随便输点什么都能返回 5 条**看着像结果**的东西。
那比返回空更坏：空结果会让人换个词，假结果会让人直接开讲。

> 闸门只能拦住**机械可判**的那一半。剩下的（该不该复习、这块讲没讲过、
> 这个节点是不是他其实早不想学了）只能靠判断，写不进代码。
> 别指望工具把教练的活全干了。

## 对外暴露的 HTTP 路由

`/coach` 一棵子树（`ctx.webServer.register`，prefix 一条，内部再分发）：

| 路径 | 干什么 |
|---|---|
| `/coach` | 302 → `/coach/skilltree.html`（不给目录列表） |
| `/coach/skilltree.html` | 吐技能树页面 |
| `/coach/api/progress` | GET 读进度 / POST 写（`mark` / `cursor`） |
| `/coach/api/schedule` | GET 读日程 / POST 写。日程视图读写 `SCHEDULE.yaml` 的唯一通道 |

**鉴权交给 dsh 自己**：主闸是 `connection.requestRejection(req)` ——
dsh 的签名 cookie + Host fence。**不自己抄一套 loopback 检查**：
抄的话 dsh 改鉴权规则这边就落后了。

---

## 致谢与许可

### 知识点地图来自 OI Wiki

`MAP.yaml` 的知识点与分类取自 [**OI Wiki**](https://github.com/OI-wiki/OI-wiki)
的导航结构（`mkdocs.yml`，351 条），前置关系由人工维护的 `DEPENDS.yaml` 补充。
`assets/oiwiki/` 直接是 OI Wiki 正文的本地检索副本。

OI Wiki 是个了不起的社区项目 —— 如果你觉得这里的地图有用，
**请去给上游点个 star**：<https://github.com/OI-wiki/OI-wiki>

> ⚠️ **前置边是人工整理的，首轮未经全面校对。** 出现「为什么 X 依赖 Y」
> 这种疑问是正常的，欢迎提 issue 修正。地图说「**允许**学什么」，
> 不说「**合适**学什么」—— 后者是教练的判断，不是地图的。

### 许可分层

| 部分 | 许可 |
|---|---|
| 代码（`index.js` / `lib/` / `*.mjs` / `coach/*.py` 等） | MIT（见根目录 `LICENSE`） |
| `assets/knowledge/` | **CC BY-SA 4.0** —— 衍生自 OI Wiki |
| `assets/oiwiki/` | **CC BY-SA 4.0** —— OI Wiki 正文 |
| `assets/pool/` | **来源与风险见该目录下的 `LICENSE`** —— CF 部分是官方公开接口（无风险），洛谷部分是爬取的（有风险），仓库不对它主张权利 |

OI Wiki 的内容部分采用 **CC BY-SA 4.0**（署名 + 相同方式共享）及附加的
[The Star And Thank Author License](https://github.com/zTrix/sata-license)。
本仓库对衍生部分沿用同一许可，署名 **OI Wiki Team**。
分层声明见各目录下的 `LICENSE`。
