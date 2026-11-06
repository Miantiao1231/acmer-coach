# 主动 worker（B1）

小鲸自己找训练员说话，不借 DSH 的 `ctx.schedule`。

`2.12.0-rc.23`：后台生活与反思模型调用默认关闭，页面 `backgroundLlm` 或 `COACH_BACKGROUND_LLM=1` 可显式开启（`0` 强制关闭）。主动发消息与 Hindsight 提炼另有各自授权和费用；关闭后台生活不代表关闭这两项。本地生活结算不调用模型。普通观察只存摘要，旧截图原件保持兼容，不在升级时清空。

## 为什么不是 B2/B3

- **B2 直接追加 assistant 消息**：UI 能显示，但重启后 session 持久化解码报 `turn/start does not open the expected turn` / `step/start does not match...`，会写坏会话。
- **B3 plugin record + 自定义 conversation node**：当前页面能渲染，刷新后聊天回放不显示 `ignorable` 记录。
- **B1**：自定义 source 的唤醒消息 + 正规 `turn-trigger` renderer。刷新/重启都保留，UI 不显示「自动化任务」。

代价：session 里有一条用户看不见的唤醒消息；模型能看到。Hindsight 把这一轮按 `companion-followup` 归档，但不会把唤醒指令当用户原话。

## 链路

```
proactive-worker tick
  → rhythm/everyday/quiet/idle 检查
  → sources 选候选
  → compose draft（LLM；太冷则按小鲸口吻重写一次）
  → judge（LLM，优先 tool-call，文本 JSON 兜底；fail-closed）
  → deliverProactive：agent.followup(custom source) + sessions.flush
  → session/event 收到这条唤醒消息 = 送达回执（queued/unknown → confirmed）
  → 模型回复 = 她真正说出的消息
```

## 文件

| 文件 | 职责 |
|---|---|
| `lib/proactive-state.js` | contact ledger、额度、未回复、inflight、burst、pendingReply |
| `lib/proactive-rhythm.js` | 静默、间隔、idle、每日上限、未回复降频、强度档位 |
| `lib/proactive-sources.js` | 目标/押卷/续课/检测/承诺/断更/纪念日/共同经历/书架/生活/上课/VP/问候/偏好 |
| `lib/proactive-compose.js` | draft + 冷稿重写 + judge（tool-call/JSON）、失败关闭 |
| `lib/warmth.js` | 「像不像助手」的轻量检查；只触发重写/下一轮提醒，不拦消息 |
| `lib/external-sources.js` | IP 定位、和风/Open-Meteo 天气、NewsNow/HN 新闻；失败返回 null |
| `lib/screen-observer.js` | 本机截图 → 视觉模型一句概括；只存概括，不把原图写进对话 |
| `lib/proactive-send.js` | 自定义 source 唤醒、flush |
| `lib/proactive-worker.js` | 定时 tick、inflight、burst、DND、失败退避、租约 |
| `lib/proactive-lock.js` | 跨进程租约，避免 web/desktop 双发 |
| `lib/client.js` | `turn-trigger` renderer：只隐藏 `plugin:acmer-coach/proactive` |

## 状态

`proactive-state.json` v2：`enabled`、`sessionId`、`route`、`lastUserAt`、`lastUserText`、`activeSince`、`lastContactAt`、`sentToday`、`occupiedToday`、`unanswered`、`failures`、`nextAt`、`burst`、`pendingReplies`、`pendingReceipts`、`screenPeekAt`、`screenPeekDay`、`screenPeekCount`、`judgeCache`、`recent`、`contacts`。`settings` 里还有 `external`、`weatherCity`、`weatherKey`、`newsSources`、`screenVision`。

- `sentToday` 只统计确认送达（confirmed）的联系；`occupiedToday` 还包含 queued/unknown，每日上限按占用算。
- contact 的 `delivery`：`confirmed / queued / unknown / failed`；只有 confirmed 才排 burst。
- 回执：主动唤醒消息真正出现在 `session/event` 时才算 confirmed。回执可能比 contact 记账先到，先存 `pendingReceipts`，发送成功后认领。
- contact 的 `warmed` 表示这条初稿太冷、被重写过一次；`judgeCached`、`duplicate` 仍各自记录。
- `judgeCache` 按人格/档案/由头/正文/他最后说的话/她此刻状态/最近对话/最近正文签名，TTL 180 分钟；judge 失败不缓存。
- judge 优先调用 `judge_proactive` 工具拿结构化结论；适配器不支持 tool-call 时退回纯文本 JSON。
- `person-events.jsonl` 超过 2MB 会自动压缩成 snapshot，旧文件归档为 `person-events.archive-*.jsonl`，默认保留最近 3 份。人格面板的「主动联系」里可以下载这些归档（原始 JSONL）。
- 日常接话不再调用在线记忆仲裁；Hindsight 结果保留主体、时间和出处供主回复判断。旧仲裁字段仅作兼容，不作为当前聊天能力开关。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `COACH_PROACTIVE_INTENSITY` | `standard` | light/standard/strong |
| `COACH_PROACTIVE_MAX_PER_DAY` | 档位 | 覆盖每日上限 |
| `COACH_PROACTIVE_INTERVAL_MIN` | 档位 | 最短间隔 |
| `COACH_PROACTIVE_IDLE_MIN` | 档位 | 他说话后至少隔多久 |
| `COACH_PROACTIVE_UNANSWERED_PAUSE` | 2 | 连续未回复几次后放慢 |
| `COACH_PROACTIVE_BURST_MAX` | 档位 | 0/1，strong/standard 默认 1 |
| `COACH_PROACTIVE_BURST_GAP` | 45 | 秒 |
| `COACH_PROACTIVE_BURST_WINDOW` | 180 | 秒 |
| `COACH_EXTERNAL_SOURCES` | 开 | 设为 `0` 关闭全部外部话题 |
| `COACH_WEATHER_CITY` | 空 | 手动城市；空则 IP 定位 |
| `COACH_QWEATHER_KEY` | 空 | 和风天气免费 Key；空则 Open-Meteo |
| `COACH_QWEATHER_HOST` | 空 | 控制台里的个人 API Host（`xxx.qweatherapi.com`） |

也可以把 Key 和 Host 分别写进数据目录的 `qweather-key.txt`、`qweather-host.txt`（各一行），面板和环境变量都不用填。
| `COACH_NEWS_SOURCES` | 见下 | 逗号分隔的 NewsNow 源 ID |

## 开关

对话里：

- 「以后主动找我」→ `coach_proactive arm`
- 「别主动找我了」→ `coach_proactive disarm`
- 「你现在主动联系的节奏怎样」→ `coach_proactive status`

人格面板 → 状态与身体 →「主动联系」也可以开关、看下次时间、最近记录、judge 均分、温柔重写次数，以及切换记忆仲裁。

## 外部话题

- **天气**：默认 IP 定位（ipwho.is → ipinfo.io 备用），也可在面板填城市；同时有 `COACH_QWEATHER_KEY` 和 `COACH_QWEATHER_HOST` 时先用和风免费接口，失败自动退 Open-Meteo。和风旧版 `devapi.qweather.com` 已停用，必须填控制台里的个人 API Host。天气候选只看当前/未来几小时，不下诊断、不报预警。
- **新闻**：NewsNow 公共接口，默认轮换 `ithome / solidot / aihot / github-trending-today / hackernews / v2ex / sspai / juejin / zhihu / weibo`；只取 24h 内一条，带来源和链接。公共实例可能限流，失败就跳过。
- **饭点**：本地时间 11:30–13:15 / 17:30–19:15；是“她自己也在吃饭”的背景，不查训练员三餐。
- **屏幕**：连续对话 ≥30 分钟且最近 15 分钟还在说话时才截一次；本机截图 → 视觉模型 → 一句概括。每天最多 3 次、冷却 2 小时；截图只用一次，解读完尽力删除，概括才进入候选。模型不支持图片时直接跳过，不塞占位符。
- **健康**：这版没有接小米/华为健康；不猜步数、睡眠、心率。
- 讲课/上课/押卷/他说忙累时，外部话题全部不取。

## 不打扰

- 静默 22:30–08:00
- 讲课 / 上课时段：只放行目标和承诺
- 只押着卷：额外允许一次 `pending` 轻问；他刚说忙/累/别催时压住
- 他刚说过话：先等 idle
- 连续未回复：放慢，不追
- burst 窗口内他回话：立刻取消
- web/desktop 同时开：租约只让一个 worker 发

## 测试

`dev/proactive-worker-check.mjs` 覆盖：状态、节奏、来源、compose/judge、冷稿重写、tool-call judge、送达回执、发送、burst、DND、租约、失败回填、timer。`dev/companion-fixes-check.mjs` 还覆盖：生活线证据、归档读取、记忆仲裁开关。
