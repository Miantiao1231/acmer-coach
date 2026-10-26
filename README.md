# acmer-coach · 小鲸教练

[![npm](https://img.shields.io/npm/v/acmer-coach)](https://www.npmjs.com/package/acmer-coach)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.2-blueviolet)](https://github.com/deepseek-ai/deepseek-harness)

一个给 ACMer 用的算法训练教练插件，跑在 [dsh](https://github.com/deepseek-ai/deepseek-harness) 上。

随包提供小鲸人设、教练预设和可选的 **Hindsight 记忆桥**。记忆桥默认关闭；接上自己的 Hindsight 服务和记忆库后，小鲸可以跨会话召回训练偏好与经历。见 [启用方法](#给教练接持久记忆可选)。

**它解决的问题**：不是「不知道学什么」——那是搜一下就有答案的。
是「**不知道现在该学哪一个、该投多少精力**」。

这两件事的差别值得说清楚：

- 网站给的是**池子**（可以无限，你自己挑）
- 教练给的是**位置**（必须唯一，有人替你担责）

所以这个插件不给你候选列表。你问「今天干什么」，答案**是一个动作**，
带时间盒和交付物。

## 它到底做了什么

31 个训练工具 + 1 个记忆工具，三条轴：知识图、比赛能力、训练证据。

| 轴 | 含义 |
|---|---|
| `tier` | 这个知识点在赛场上重不重要 |
| `entry` | 什么水平**学得起**（题池 p25 ≈ 入门段位） |
| `role` | 能否独立考核；`integrated` 是随题融合的基础概念/技巧，重要但不单独开卷 |

核心闭环：

```
coach_curriculum  assess 查真实记录 → 目标与前置排序 → 建有依据的阶段
  ↓                缺依据先诊断；保存本周主线；产生新证据并验收后推进
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
coach_schedule → coach_plan              看日程、设置固定上课时段、排练习
  ↓
coach_target → coach_vp_import → coach_postmortem → coach_focus
  ↓                         比赛目标、VP 复盘、当前重点
coach_lesson                 短回合讲课：先讲核心、听回应、再决定下一步
coach_note                   续课笔记：教到哪里、尚待确认什么、下次接哪里
```

`coach_wiki` 是知识来源：讲任何知识点之前先查本地 OI Wiki，**别凭记忆讲**。

### 目标驱动训练

知识图只回答“有哪些知识点”，不回答“为什么现在学它”。先用
`coach_target` 设置比赛、日期、目标结果、团队模式、可用时间和能力优先级，
再用 `coach_vp_import` 导入 VP，`coach_postmortem` 写复盘，`coach_focus` 计算当前
训练重点。每次布置都要能说清楚它服务哪个比赛能力、适用范围、迁移题和退出条件。

VP 记录格式是 JSON 数组，每场至少包含 `eventId`、`contest`、`date` 和 `problems`：

```json
[{"eventId":"vp-西安-01","contest":"区域赛 VP","date":"2026-10-10",
  "durationMinutes":300,"teamMode":"team","problems":[
    {"problemId":"A","status":"AC","readMinutes":8,"solveMinutes":22,
     "attempts":1,"competencies":["contest-reading"]}]}]
```

讲知识点时先用一句人话讲核心与必要条件，停下来听学生怎么理解；`coach_lesson`
记录真实回应；上一条误记时用 `action=correct` 更正，不追加一条假回应。收课时用简短的
教练判断写入现有续课笔记，不强迫逐关走完五步。只有独立尝试的题目与结果才能记
`independent`。具体题目与边界按真实题面和可靠资料核对。

想固定每天的上课时间，可以告诉小鲸“周一到周六 19:00–19:30 上课”：它会用
`coach_schedule` 的 `set_class_window` 保存一次，之后每轮会看到当前是否在上课时段。
时段外以练习或原定休息为主；临时想讲课可以直接说。时间按运行 dsh 的本机时间判断，
插件不会自行唤醒会话或发送提醒。`clear_class_window` 可撤销设置。

能力排名只是取舍参考。排在前三之外、尚未映射到目标能力的节点也能布置，由小鲸解释
为什么现在练；课程版本、当前阶段和真实前置的检查继续保留。

### 长期学习路线

`coach_curriculum assess` 从已有检测、代码判因、做题记录和日程实际完成中列出
可引用的证据；VP 题目与复盘里的 `competencies` 也会生成稳定证据 id，不会把 rating、学习状态或取消的卷子当成短板。每条记录带内容引用
`id` 和事件身份 `eventId`。训练阶段的每个节点必须有真实记录：`finding=gap`
引用失败/超时/依赖提示等短板，`finding=extension` 引用已独立做出或过卷的能力起点。

缺记录时先建 `diagnostic` 阶段，写明要确认的问题与取证方法，不能直接宣布弱项。
远期设想用 `provisional` 保留，补足依据前不能执行。每个阶段除能力成果和验收条件外，
还要写 `basis`、`goalContribution`、`priorityReason`、`estimatedHours`、`evidenceRefs`、
`finding`、`kind`、`uncertainty`、`diagnosticMethod`。前置必须来自显式的
learned/verified 记录，或路线中在此前安排的必验训练，不能从游标位置推定已经学会。

`CURRICULUM.yaml` 保存路线与修订历史：`read` 查看，`create` 建立，`revise` 调整，
`advance` 推进。阶段可以只绑定比赛能力（读题、决策、团队沟通），这类阶段用 VP/复盘证据验收，不必伪装成地图节点。进入阶段时保存证据事件快照；诊断阶段每个节点需有新的真实观察，训练阶段所有节点必须 verified，能力目标必须有阶段后的新 baseline 证据。改旧备注、成绩或
把同次做题从课表迁入进度，不算新训练。当前诊断也不能通过改种类或删节点逃过验收。
写操作带 `expectedRevision` 和理由，避免旧上下文覆盖新计划。
路线按剩余 `estimatedHours`、每周预算和目标日期提示容量不足或估算缺失；这只是
调整范围的提示，不会把周平均当成精确日程，也不阻止执行。

每轮注入比赛目标、能力重点、长期阶段和未完成单元。`coach_assign` 带课程版本，普通训练
限于当前主线；补漏/复习需声明目的和返回依据。完成记录仍归原进度文件，
不会因一题 AC 或日历到期自动跳阶段。没有建立课程的用户保持原有工具行为。

本周主线可设置 `focusUntil`，到期先复盘修订。路线不提前占用数月日程，
`coach_plan` 继续管理近期时间块。旧 v1 路线可读，会标记 `needsReview`；需明确
修订当前及后续阶段后迁移 v3，插件不会自动重写。优先级与教学方案仍由模型判断，
程序现在会要求目标和 VP 证据先进入策略层；能力卡片仍由仓库维护，未知卡片不会自动臆造。
现在可以直接连接 VP：`coach_vp_connect start` 打开授权页，登录并允许只读访问后，
把一次性 code 交给 `coach_vp_connect finish`。然后用 `coach_vp_sync` 增量同步比赛、
提交、事件和个人历史；同步会自动生成带账号前缀的 VP 训练证据，仍由复盘和检测决定
能力结论。小鲸先用 `coach_vp_contests` 按比赛名称选场，再调用 `coach_vp_replay`，不需要你记 Contest ID。
`VP 回放`按钮会打开可视化页面，
把 AC、WA/TLE/RE 和比赛分钟画在同一条时间轴上。

每个 VP 账号都放在 `~/.dsh/knowledge/vp-accounts/<user_id>/`，token 单独保存，
同步游标、原始安全投影、回放缓存和 `VP_EVENTS.yaml` 都按账号分开。个人训练数据
`PROGRESS.yaml`、`CURRICULUM.yaml`、`SCHEDULE.yaml`、`TARGET.yaml` 始终留在
`~/.dsh/knowledge/`，切换 VP 账号不会换教练。2.4.0 对旧账号目录只补齐缺失的个人文件；主目录已存在时保留它，冲突账号版本另存为 `.from-vp-account-<user_id>`。完成标记防止以后反复迁移覆盖，原账号文件保留；2.3.1 已产生的 `.pre-vp-account-<user_id>` 备份也保留。
服务端
返回的账号 id 与当前账号不一致时，客户端拒绝写入。同步和回放都不返回提交代码或 judge 输出。
`disconnect` 只删除本地 token，保留缓存，方便重新连接同一个账号。

详见 [长期课程机制](docs/长期课程机制.md)。

### 2.9.10：修复 CI 发布检查

- 发布流水线在 GitHub runner 上检查当前仓库的工具形状，本地仍检查 dsh 已安装副本；`v2.9.9` 因 runner 没有本地 dsh 目录而未发布到 npm。

### 2.9.9：短回合教学与可续课记录

- 讲课先用一句人话讲核心，再根据学生回应补一个卡点、给小例子或收课转练；可设置每周固定上课时段，临时要求讲课仍可直接开始。
- 收课把简短判断写进既有续课笔记；口头推导与独立做题分开。误记上一条课堂回应时用 `coach_lesson correct` 更正，不制造一条新的学生回答。
- 课程、训练日志与 VP 页面沿用同一份个人账本；新增发布前 CI、工具形状和安装包烟测。

### 2.9.8：今天这一件、VP 一键复盘与随题融合

- 技能树首页从现有未完成动作和课程阶段生成“今天这一件”：显示任务、原因和预计时长；没有待办时一键请小鲸根据当前阶段拍板，不编造训练内容。
- VP 回放选中比赛后可直接从当前 DSH 会话请小鲸复盘；交接会核对账号、比赛编号和标题，切号的旧页面拒绝提交。输入框已有草稿时不覆盖。
- 将动态规划基础、离散化等跨题概念标为“随题融合”：地图仍保留其前置与旧进度，但新课程不能拿它们做独立训练阶段，不能单独开章节卷。小鲸要在具体题型或比赛能力中教学、观察和验收。

### 2.9.7：账本安全与赛场判断

- 写入目标、进度、课程和 VP 记录失败时保留旧文件；已有损坏账本直接报错，不伪装成空白新学生。
- VP 同步结束时不抢回已切换的账号；事实引用不随备注改写，实质变化会提示复核。
- 出卷先查题池；缺标签时可核实题面后使用 `source=web`，不编造题号。「独立 AC」可按学生原话记录。
- 复盘可选填赛中决策快照；新增隔离教学验收场景，检查小鲸会不会把正常的铜牌队取舍误判成错误。

### 2.9.5：部署源与课程历史

- 开发同步同时核对 `.dsh/plugins/acmer-coach` 和 web/desktop 运行副本，避免下次重新安装时从旧部署源覆盖 Hindsight 修复。开发与自测请在 Git 仓库运行；部署目录不维护独立的 `node_modules`。
- 训练日志依据当前阶段 ID 判定过去阶段，避免缺少序号时误标“未开始”；当前及后续阶段留在主视图，已完成、已跳过阶段折叠进「历史阶段」，跳过时保留未完成验收。
- 只修订阶段的依据文字或失效证据引用时保留进入阶段的时间和证据快照；改变训练目标或验收条件仍重建快照。
- `coach_pool` 缺标签时明确提示 `coach_test` 的已核实外部题通道；补齐 ST 表范围卡片，其他缺卡节点继续要求先查原始资料。
- `note_context` 缺学习状态时只报告“未记录”，不再推断学生从未接触；打包的笔记扩展和本机副本同步更新。

### 2.9.4：记忆桥单一入口与可诊断召回

- 移除旧的独立桥依赖后，`acmer-coach` 是唯一记忆桥；不会再和 `whale-hindsight` 重复召回或重复归档。
- `coach_recall` 始终注册。未启用或配置不合法时返回明确原因并保持零网络请求，避免工具表出现 `unknown tool`。
- 记忆优先级固定为：Hindsight 召回用于偏好与跨会话连续性；`PROGRESS` / `CURRICULUM` / `TARGET` / `SCHEDULE` 是训练事实；训练日志只在查看当天或阶段历史时作为辅助，不自动替代账本。

### 2.8.0：记忆可追溯与真实教学验收

- 随包桥保留可取得的原生会话、消息、轮次和时间出处；召回结果提供 Hindsight 的记忆 ID、来源和日期。旧记忆无出处就保持未知，不把模型提炼的事件时间当成原生消息时间。
- 只读 `coach_recall` 始终可见：桥未启用或配置错误时只返回诊断，不发起网络请求；桥启用后小鲸可按当前教学需要查询同一个 bank。自动少量召回继续保留。工具不提供切换 bank、修改或删除记忆的入口。
- 增加手动运行的 [真实教学验收](docs/真实教学验收.md)：串行检查新会话续课、错误理解后的讲法调整、复测后的计划调整。使用独立小鲸和 bank，保留回复、工具与账本证据；机械检查与人工教学判定分别记录。普通回归和 CI 不调用付费模型。

### 2.9.0：训练日志与阶段仪表盘

- 技能树页面新增「训练日志」视图，支持查看最近 7 / 14 / 30 天每天的计划、实际用时、练习、讲课、检测、判因和状态变更。
- 日志是 `SCHEDULE.yaml`、`PROGRESS.yaml` 和 `CURRICULUM.yaml` 的只读汇总：没有 `actual` 记录时显示「待补实际」，不会替你猜成“没完成”，也不会复制出第二套进度。
- 阶段区显示已完成 / 当前 / 未开始的路线、当前阶段成果、验收条件、主线、证据缺口和剩余预算；阶段推进仍只能由 `coach_curriculum advance` 根据证据决定。
- 页面对应的只读接口是 `/coach/api/training-log?days=14`，也接受 `from=YYYY-MM-DD&to=YYYY-MM-DD`；最多返回 90 天。接口按当前教练工作区读取，VP 账号目录只提供 VP 数据，不会替换个人训练日志。

### 2.9.3：跳过阶段不再卡住后续训练

- 长期课程新增 `coach_curriculum action=skip`：训练员明确放弃当前阶段时，记录未验证节点、缺新记录、未过验收、未完成动作和未判检测卷，再进入下一阶段；跳过最后阶段会结束路线。
- 旧课程建立前留下的无课程绑定待办仍保留并写进跳过记录，但不会继续阻断新阶段；同日新布置的动作仍会阻断，避免把刚布置的训练误当成旧任务。
- `CURRICULUM.yaml` 重载后保留跳过标记与缺口；课程仪表盘可查看历史，日常教练上下文只提示当前阶段与验收进度。

### 2.7.0：Hindsight 记忆桥随包

- 原有独立桥的召回、时间戳与异步归档接进主插件；`COACH_HINDSIGHT=1` 才启用，必须指定自己的 `HINDSIGHT_BANK`。安装不会联网读取或写入记忆。
- 兼容 dsh `0.2.0-rc.2` 的原生消息格式，归档学生原话和小鲸的最终回复；排除插件注入、思维链、工具调用与失败轮次。不同会话分别收集。
- 已有 bank 的设置保持原样，仅缺失时创建。日志只含状态元数据，服务故障时继续对话。普通测试强制关闭桥，避免连接开发者的正式记忆。
- 不随包分发后端、密钥或个人记忆。原有 `whale-hindsight` 用户可在原生插件页关闭旧组件，再用相同服务与 bank 启用随包桥。

### 2.6.4：训练事实与隔离回归

- 原生 `coach_log` 用 `studentQuote` 核对学生报告，记录消息出处；接受过提示不能记成独立，实际分钟必须有原话依据。没有报告的时长和独立性可以省略，保持未知。
- 同源报告改题名只更新一次；两题分别引用各自报告。课程证据使用稳定事件身份，改备注或改题名不增加验收次数。旧账本保留，不自动猜测修正。
- 本轮联网限制、可用时间与已核对的学生讲法优先于默认模板。续课偏好复用 `coach_note` 和宿主记忆；最小反例、输入范围与哨兵边界需要核对。
- 默认知识目录和 SQLite 都遵循原生 `DSH_HOME`；`COACH_DATA_DIR` / `COACH_DB` 显式覆盖继续支持。测试采用专用 Hindsight bank，正式记忆不参与。

### 2.6.3：回放与知识地图对齐 VP 平台

VP 回放、知识地图和日程沿用 CompetitionWhale VP v5 的深蓝／浅蓝主题、Geist 字体、鲸鱼图标、胶囊控件和细边框面板。两页共用已有 `coach.theme` 选择，首次默认深色；支持窄屏布局、键盘焦点和减少动效。字体随包分发并带 OFL 许可，无外部字体 CDN。

技能树页面使用新版插件模板显示原有生成页中的图数据，因此更新界面无需重建个人地图或覆盖账本。非标准或无法解析的旧 HTML 保留原页；直接以文件方式预览时字体可回退到系统字体。进度、日程与 VP 账号缓存继续走原有接口和隔离规则。

这次统一的是平台标准明暗主题与组件风格；VP 网站账号的自定义配色／背景图没有同步到 dsh，两者属于不同站点。

### 2.6.2：小鲸人设与原生预设随包

现在插件内置 `assets/persona/xiaojing-coach.md`，默认提供小鲸鱼娘的外观、性格、训练员称呼、语气词、颜文字和小动作。新用户安装后无需另建本机 `personas` 文件。互动、讲题、复盘和赛时都保留可爱风格，公式及代码内部保持干净。

在 dsh `0.2.1-rc.2` 中，安装并启用插件后，新会话的预设菜单可选择 **小鲸教练**（`acmer-coach-xiaojing`）。它沿用 dsh 标准预设的文件、终端、联网、技能、计划、委派和对话压缩；教练工具仍只注册一次。现有默认预设和个人 `xiaojing` 预设保留，插件不会自动改选默认。

人设通过 dsh 已有 `systemPrompt.section()` 静态加载，位于宿主人设之前；当前用户偏好和宿主自定义风格优先。训练选题、长期计划、来源及验收继续遵循 `coach:rules`，不把旧人设里的 rating 门槛或固定工具步骤带回来，也不携带个人账号与训练记录。插件不会自行改写已有本机人设文件；如个人预设仍包含旧教学规则，需单独更新它的 `persona.config.prefix`，避免覆盖新版教练规则。

没有提示词服务、人设文件缺失或人设注册失败时，教练规则和工具继续独立加载。更新后重启 dsh 并创建新会话；已有会话可能保留旧预设的一代配置。随包与注入验证不等于实际模型口吻评测。

### 2.6.1：中国区多赛站资料

`regional-diagnostic` 现在有五站六场、七十道已核对题意与官方题解的样本：南京2022十三题与2023六题、西安2025十三题、杭州2024十三题、上海2025十三题、香港2025十二题。每题保留教学模型、现有能力ID及真实PDF页码。

西安配置继续使用旧 `xian-pending` ID，内容已补为2025全卷十三题，已有目标不用迁移。更多比赛保留在[56场中国区资料索引](docs/china-contest-sources.md)，按需核验，不把候选链接数量当审核覆盖。杭州的浙江省赛错配已更正为UCup Stage25、场次1893；原始工作表未修改。

资料扩充不增加工具、课程引擎或评分权重。小鲸根据个人和团队训练证据选择重点；样本不是完整考纲、出题概率、学生掌握记录或金牌保证。尚未运行全部题目解法、交互器或完整核验现场奖牌榜。

### 2.6：独立验收、灵活训练与逐题依据

章节分数及限时通过仍记为 `passed`，但只有本次做出的题都明确报告 `independent: true`，才新增 `verified` 和验证段位。独立性未知或有帮助时，保留实际成绩，不能自动认证；旧证书保留，不补造独立事实。独立性来自明确记录，不是工具能从 AC 猜出的结论。延迟保持与迁移仍由既有课程 `exitChecks` 单独验收。

训练沿用 `coach_assign` / `coach_log` / `coach_plan`：短诊断和整场 VP 可以直接绑定比赛能力，时长由教练明确给出；旧知识点练习和默认时长继续支持。计划只记录安排，不证明训练完成。

`coach_target profiles` 和 `coach_focus` 返回逐题 `samples` 与 `coverage`。2.6最初包含南京2022十三题与2023六题，2.6.1扩至五站七十题并补齐西安样本；NWERC十三题仅作扩展参考，WF的三题仍是题面诊断。覆盖数字不产生专题频率、奖牌线或预测；小鲸结合个人证据决定重点。

### 2.5：接着教，判断仍归小鲸

`coach_note` 只做一件事：把一个知识点的教学判断和接续点留在现有
`PROGRESS.yaml` 的 `nodes.<id>.lessonNotes`。`read` 查看最近笔记，`write` 保存
`summary` 与 `nextStep`；不新增课程状态机、聊天数据库或另一份掌握记录。
`coach_status` 的 `teachingContext` 和每轮首步状态会带上短笔记，需要原话时再查原生会话。
未指定节点时，读取优先显示最近有笔记的未完动作，再看游标；没有游标则看最近笔记。
写入默认使用游标，显式 `node` 优先，不会为了写笔记移动游标。

`studentQuote` 可选。填写时核对当前 dsh 会话中的真实学生消息，自动记录来源；
插件消息、压缩摘要和其他会话不能冒充学生回答。核对原话存在不等于判断学生理解，
没有原话的笔记也可保存，但标作教练判断。笔记不会改进度状态、游标、待办或检测结果。
旧宿主没有原生会话查询时，普通笔记可用，带原话的写入会明确拒绝。

`teachMinutes` 现在只保存讲授计划，不再自动写“已经教过”的日期。实际进入学习由
教练显式 `coach_mark studying` 记录；已有接触记录继续可用，但不证明理解。
这版验证的是记录、来源和续课机制；真实小鲸对话的教学效果仍需观察。

### 2.4：证据、验收与教学依据

`coach_focus` 分开近30天的独立成功、待确认观察、已确认短板，按不同场次计数。
成功不会增加“问题次数”；WA 不直接证明不会。`coach_postmortem findings` 用
`hypothesis/confirmed/resolved` 区分判断，必须引用 `coach_curriculum assess` 返回的本场
原始事实；原始内容变化后旧确认引用失效。旧文字复盘保留为观察，不删除。
仅修改备注文字时事实引用保持稳定；题目结果等实质信息变化时，`coach_focus` 会提示旧结论引用失效。
可选的 `decisionSnapshot` 只记录当时可选题、手上进度和剩余分钟，不把未看过的高难题自动归因成扫题失败。

新训练阶段必须提供结构化 `exitChecks`，例如
`[{node: "区间 DP", minEvents: 2, minDistinctDays: 2, independent: true, maxMinutes: 45}]`。
只有满足条件、本阶段发生的不同成功事件才计数，缺独立性或用时记录不会被猜成通过。
`read` 返回每项 `exitCheckResults` 和缺口；旧 v1/v2 课程只读保留，先 `revise` 补齐条件
后升级 v3。通过检测证明的是该次条件下的表现，不能解释成永久掌握。

`coach_target profiles` 提供 `regional-diagnostic`、`nwerc-reference`、`wf-extension`、`xian-pending` 四个
有来源、采样范围和限制的配置，选定后可通过 `profileId` 保存。它们都仍是 provisional，
不是西安考纲、专题频率或奖牌保证。讲具体边界时核对 OI Wiki 和真实题面；
`coach_lesson` 记录学生回应，不用预写节点卡代替小鲸的教学判断。
详见 [比赛与教学依据](docs/比赛与教学依据.md)。

近期安排需解释“长期能力 → 本次比赛 → 当前阶段 → 今天一个动作”的取舍。
VP 增量同步会累计各分页记录，`hasMore` 告诉教练是否继续拉下一页；不会把累计缓存冒充新增记录，也不会覆盖教练补充的独立性和能力标签。平台无时区的时间按服务端 UTC 约定解释，训练日期按本机日期记录；不更改 VP 服务端。

`coach_curriculum assess` 支持 `evidenceEventIds` 查询旧场次，不受全局最近200条的影响。
事件级 `measurements` 可记录 `competency/metric/value/passed/independent/occurredAt`；例如
已核对回放后的零漏读测量。工具要求有限数值与显式验收、独立性，不能从一个 AC 自动推断。
同场同指标不会凑成“两场通过”；修改旧记录也不会变成新阶段的新表现。

**「学过」和「已验证」是两级，绝不合并。** 自评 ≠ 掌握 ——
合成一个「会/不会」就等于退回「从数据推断掌握度」，而数据能说「花了很久」，
说不出「卡在哪」。所以 `verified` 手标不了，它只能由检测产生。

## 装

```bash
# 1. 装 dsh（需要 Node ≥ 24）
npm i -g @deepseek-ai/dsh@0.2.1-rc.2

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

> 💡 **别同时开 web 和 desktop 写同一份教练数据**：两个进程共用 `~/.dsh/knowledge`
> 下的账本。插件保存前会比对文件指纹，发现被另一个进程改过就**拒绝覆盖**
> 并提示重试 —— 不会静默丢记录，但同一时间只开一个窗口写最省事。

### 首次使用：先诊断，不把猜测当短板

**说清楚这一点**：装完它对你一无所知。没有检测记录、没有判因台账，
它应明确哪些未知，先安排能取得证据的小诊断；数据不足不能编造掌握度或弱项。

检测和实际训练记录逐步减少不确定性，不承诺“用满两周就一定准”。

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

## 可选扩展：接上你的 Obsidian 笔记

如果你用 Obsidian 记竞赛笔记，`assets/extension/notes/` 是一个**可选**的 dsh 插件，
把笔记库和教练地图接起来：给一个知识点名，一次拿到「你为它写的笔记正文 +
图上的前置 / 后继 + 你的学习进度」。

最直接的收益在讲知识点那一步 —— 教练讲完会附一份板子，**接上笔记后，
这份板子能对着你自己的写法来**（宏、命名、大括号、注释密度，照你的笔记全套对齐）。

纯附加，不装不影响任何功能。装法、配置（一个必需的环境变量：你的库路径）、
「映射怎么建」的说明都在 [`assets/extension/notes/README.md`](assets/extension/notes/README.md)。

## 给教练接持久记忆（可选）

**从 2.7.0 起，桥已包含在 acmer-coach 中，不用再写或安装另一个桥插件。**
[Hindsight](https://github.com/vectorize-io/hindsight) 服务需要单独部署或使用已有服务；安装 acmer-coach 不会自动启动后端或启用记忆。

启用后，每轮第一步用学生当前原话召回 Hindsight 整合后的 observation，连同本地时间附给小鲸；原始历史记忆仍可通过 `coach_recall` 按需查询。完成一轮对话后，异步发送学生原话和小鲸最终回复供 Hindsight 提炼。思维链、工具调用和插件注入不归档。记忆用于续课与偏好参考，不能替代 `PROGRESS` / `CURRICULUM` / `TARGET` / `SCHEDULE` 账本，也不能证明掌握。旧教练建议与学生最新纠正冲突时，以纠正和原始记录为准。

始终提供一个只读工具 **`coach_recall`**：由小鲸按需写查询，例如“上次二分课卡在哪里、学生明确说过什么讲法偏好”。它复用同一个服务与 bank，不让模型指定其他账号的 bank；桥未启用或服务失败时说明原因，不装作记得。插件共 32 个工具，其中 31 个训练工具和 1 个记忆查询工具。

2.8.0 起，新的归档附带能取得的原生会话、消息和轮次出处，召回返回记忆 ID、日期和来源。Hindsight 提炼的事件时间与实际归档时间分别标明；旧记忆没有字段就保持未知。对具体学习结论仍要核对原话和训练账本，来源信息本身不等于“已经掌握”。

### 1. 安装或更新插件

```bash
dsh plugin --profile web add acmer-coach@latest
```

桌面用户仍在 dsh 的插件页安装／更新同一个 npm 包。已有独立 **`whale-hindsight`** 的用户，先在侧栏 **插件 → 该插件详情 → 组件开关** 关闭旧组件，再启用下面的桥，避免双重召回和重复归档。可以继续使用原有服务地址和 bank，桥不会重写已有 bank 的 mission。

### 2. 准备 Hindsight 服务

**已有服务就跳过部署。** 没有的话，安装 Docker 后在 PowerShell 运行下面的示例；模型配置可按 [官方配置说明](https://hindsight.vectorize.io/developer/configuration) 换成其他提供商。

```powershell
$env:HINDSIGHT_API_LLM_PROVIDER = 'openai'
$env:HINDSIGHT_API_LLM_MODEL = 'gpt-4o'
$env:HINDSIGHT_API_LLM_API_KEY = '填你自己的模型服务 API Key'
docker run -d --name acmer-coach-hindsight --shm-size=1g `
  -p 127.0.0.1:18888:8888 -p 127.0.0.1:19999:9999 `
  -e HINDSIGHT_API_LLM_PROVIDER -e HINDSIGHT_API_LLM_MODEL -e HINDSIGHT_API_LLM_API_KEY `
  -e HINDSIGHT_API_WORKER_ID=acmer-coach-local `
  -v acmer-coach-hindsight-data:/home/hindsight/.pg0 `
  ghcr.io/vectorize-io/hindsight:latest
```

本地 API 地址是 `http://127.0.0.1:18888`，管理界面是 `http://127.0.0.1:19999`。数据保存在 Docker volume 中。首次启动需要等模型与服务就绪；完整部署步骤见 [官方 Quick Start](https://hindsight.vectorize.io/developer/api/quickstart)。Hindsight 的提炼会调用你配置的模型，可能产生模型费用，安装桥并不包含这些服务。

### 3. 在启动 dsh 的环境里启用

PowerShell：

```powershell
$env:COACH_HINDSIGHT = '1'
$env:HINDSIGHT_URL = 'http://127.0.0.1:18888'
$env:HINDSIGHT_BANK = 'my-training'
dsh --profile web
```

macOS／Linux：

```bash
COACH_HINDSIGHT=1 HINDSIGHT_URL=http://127.0.0.1:18888 HINDSIGHT_BANK=my-training dsh --profile web
```

`HINDSIGHT_BANK` **必填**，使用英文字母、数字、点、短横线或下划线，且以字母或数字开头。每个人、每个测试小鲸分别用不同的 bank。更换 bank 会使用另一个记忆库，不会自动搬运记忆；切换 VP 登录账号不会替你更换这个人的记忆库。

如果服务启用了 Bearer 鉴权，再设置 `HINDSIGHT_API_KEY`。这是**访问 Hindsight 服务的凭据**，和后端的 `HINDSIGHT_API_LLM_API_KEY`、dsh 聊天模型 Key 是不同配置。

**Windows 桌面版**：在「编辑账户的环境变量」中添加上面三个变量，完全退出 dsh，再重新打开；若新进程未继承变量，注销 Windows 后重新登录。只在某个 PowerShell 窗口里设置变量，不会影响已经打开的桌面进程。启用范围是该 dsh 进程的会话，不限于小鲸预设；对话文本会发给你配置的 Hindsight 服务，桥不会在发送前自动脱敏。

### 4. 确认生效与停用

打开 Hindsight 管理界面，选择你配置的 bank；完成一轮对话后，等后台提炼任务完成再检查新记忆。桥不会把整个聊天记录当作完整备份，单轮最多发送 20,000 字符。

日志在 `$DSH_HOME/data/acmer-coach/hindsight.log`，未设置 `DSH_HOME` 时是 `~/.dsh/data/acmer-coach/hindsight.log`。只记录状态、数量与错误类型，不记录对话正文、Key 或召回查询。

| 日志 | 含义 |
|---|---|
| `enabled` / `bank-ready` | 已启用／服务中的 bank 已就绪 |
| `recall-ok` / `recall-empty` | 本轮召回了相关记忆／没有匹配内容 |
| `retain-accepted` | 后端已接收归档请求；异步提炼完成后才能召回 |
| `bank-fail` / `recall-fail` / `retain-fail` | 检查服务状态、地址或鉴权；小鲸仍可继续对话 |

停用：把 `COACH_HINDSIGHT` 设为 `0` 或删除该变量，重启 dsh。已有远端记忆保留。测试时指定新 bank 和独立 `DSH_HOME`，不要复用自己的正式 bank。仓库及 npm 包不包含任何人的 bank、服务密钥或记忆内容。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件本体（host 端，32 个工具 + 规则注入） |
| `lib/setup.js` | 环境搭建 + CF 公开数据同步 |
| `lib/curriculum.js` | 持久课程路线、阶段验收门槛、版本与修订历史 |
| `lib/curriculum-evidence.js` | 从实际记录派生证据引用与事件身份，去重课表和训练记录 |
| `lib/curriculum-planning.js` | 阶段编排依据、前置顺序与进入阶段后的新证据检查 |
| `lib/teaching.js` | 节点续课笔记，复用进度文件与 dsh 原生会话查询 |
| `lib/hindsight.js` | 随包可选记忆桥：首次召回、时间注入、完成轮次归档；环境变量显式启用 |
| `lib/client.js` | 浏览器端：会话头部「技能树」按钮 + 弹层 |
| `package.json` | 声明 `dsh.bundle.patch` + `dsh.client` |
| `cordis.patch.yml` | bundle 层的 insert 行 |
| `progress-cli.mjs` | 进度 CLI。**它不自己实现规则**，只翻译 argv |
| `verify.mjs` | 验收（几百条机器检查）。跑的是**已安装副本**，不是源码 |
| `verify-shape.mjs` | 形状扫描：把每个工具的返回值喂回它自己的 `output.schema`，抓「返回里有、schema 里没有」这类只在运行时才炸的错 |
| `dev.sh` | 开发回路：同步 + 验收，一条命令 |
| `build-node-meta.mjs` | 算每个节点的 `entry`（跑题池，离线） |
| `assets/rules/` | **教练规则** —— 由插件注入 system prompt |
| `assets/persona/` | **小鲸人设** —— 默认随包，静态注入 system prompt |
| `assets/knowledge/` | 地图与元数据 |
| `assets/oiwiki/` | OI Wiki 本地检索库 |
| `assets/pool/` | 随包发的题池（41,518 道，三平台）—— 见该目录下的 LICENSE（有风险说明） |
| `assets/extension/` | **可选**扩展：洛谷记录导出（浏览器扩展）+ Obsidian 笔记桥（dsh 插件） |
| `coach/` | 地图工具链（Python）+ 指标脚本 |

### 人设与三层教练能力

| 层 | 内容 | 怎么生效 |
|---|---|---|
| **人设** | `assets/persona/xiaojing-coach.md` | 默认静态加载，宿主自定义风格和当前用户偏好可覆盖；改后重启dsh |
| **规则** | `assets/rules/coach-rules.md` | 插件用 `systemPrompt.section()` 注进 system prompt（和人设同一条路）。**改它要重启 dsh** |
| **知识** | 地图 4 份 + OI Wiki 检索库 | `coach_setup init` 铺到数据目录；OI Wiki 直接从包里读 |
| **工具** | 32 个 | 装完就在；`coach_recall` 未启用时只显示诊断 |

规则进的是 **system prompt，不是消息流**：行为约束每轮都得在场，
而消息流会被长对话把尾巴挤掉。文本是**静态**的（只在加载时读一次）——
每轮现算会打穿 prompt cache。

教练规则只保留少量判断原则；本机 `~/.dsh/AGENTS.md` 放个人事实与边界，预设只指向随包人设，不再复制规则全文。每轮动态注入只报当前目标、阶段与待办；旧阶段依据和复盘历史用工具按需查。比赛复盘把“快速扫描、细读、开写、提交”分开记录：未提交与长间隔不能直接判为漏读或决策失败，只有本队当时可做的题才可能构成错失机会。

### assets/knowledge/

| 文件 | 内容 |
|---|---|
| `MAP.yaml` | 349 个知识点 / 401 条前置边。**由 `coach/build_map.py` 生成，别手改** |
| `DEPENDS.yaml` | 前置关系的**唯一真相源**（人维护），改它再重跑 `build_map.py` |
| `NODE_ENTRY.yaml` | 每个节点的入门段位（题池 p25），机器算 |
| `NODE_META.yaml` | `tier` 与 `role` 标注，人维护；`integrated` 随题融合，未标注默认可独立考核 |

`PROGRESS.yaml`、`SCHEDULE.yaml` 和 `CURRICULUM.yaml` **不随包发** —— 它们是你的进度、日程和课程，
首次写入时由插件自己生成（带正确的文件头）。发模板等于给文件头造第二份真相。

## 开发回路

真实教学另有一个**手动**入口，默认显示帮助，不调用模型：

```bash
npm run eval:teaching -- --prepare
npm run eval:teaching -- --run <上一步输出的验收目录>
```

它用三个独立小鲸串行验收，并输出人工检查表；准备数据只来自随包公开知识和题池。运行前需配置自己的 dsh CLI 与模型凭据环境变量，见 [真实教学验收](docs/真实教学验收.md)。普通 `npm test` / CI 只检查入口和隔离边界，不运行付费教学对话。

```bash
bash dev.sh          # 同步副本 + 验收 + 形状扫描 + 课程/证据测试 + 比账本指纹
```

单独跑：

```bash
node verify.mjs && node verify-shape.mjs      # 主验收
node dev/w1-check.mjs                          # 解绑 + 闸门 + 规则注入
node dev/wiki-check.mjs                        # OI Wiki 检索
node dev/setup-check.mjs                       # 冷启动（离线）
node --test dev/curriculum-check.mjs            # 长期课程（隔离数据）
node --test dev/curriculum-evidence-check.mjs   # 证据目录、事件身份与重复记录
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
| `/coach/api/training-log` | GET 汇总每日训练事实与课程阶段，只读；默认最近 14 天 |

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
