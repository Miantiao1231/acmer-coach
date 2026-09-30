# whale-notes

把你的 **Obsidian 笔记库** × **教练地图** 接起来。dsh 插件，配合 [acmer-coach](../..) 使用。

## 它解决什么

讲一道题要的上下文散在三个地方：

| 在哪 | 是什么 |
|---|---|
| `MAP.yaml` | 这个知识点的前置、后继（依赖图） |
| `PROGRESS.yaml` | 你学到哪了 |
| 你的笔记 `.md` | 你自己怎么写的、代码长什么样 |

没这个插件，AI 每次要三次读取 + 一次自己的目录遍历，而且**每次拼法可能不一样**。
装了它，一次调用全拿到。

顺带一层：教练讲新知识点时会附一份「你的风格」的板子 —— 板子的样例来源就是这里。

## 装

前置：acmer-coach 已经初始化过（数据目录里有 `MAP.yaml`）。

```bash
# 1. 拿到本仓库（已有就跳过）
git clone https://github.com/Miantiao1231/acmer-coach

# 2. 装笔记插件（spec 用 file: 协议，指向这个目录）
dsh plugin --profile web add "file:<仓库路径>/assets/extension/notes"
#    Windows 示例：file:C:/Users/you/acmer-coach/assets/extension/notes

# 3. 配置你的 Obsidian 库路径（必需，见下）

# 4. 重启 dsh
```

## 配置

| 环境变量 | 必需？ | 说明 |
|---|---|---|
| `OBSIDIAN_VAULT` | **必需** | 你的 Obsidian 库根目录。**没设时工具会明确报错，不会猜一个路径** |
| `COACH_DATA_DIR` | 可选 | 教练数据目录。默认 `~/.dsh/knowledge`，跟 acmer-coach 一致 |

设置方式（设完要重启 dsh）：

```bash
# Windows
setx OBSIDIAN_VAULT "D:\your-vault"        # 设完重开终端
# macOS / Linux（写进 ~/.zshrc 或 ~/.bashrc）
export OBSIDIAN_VAULT=~/Notes
```

## 三个工具

| 工具 | 干什么 |
|---|---|
| `note_context` | 给知识点名（「区间 DP」）或笔记名/路径 → **笔记正文 + 图上前置和后继 + 你的进度**，一次给全 |
| `note_map_status` | 映射登记到什么程度了：哪些笔记挂上了、哪些没挂、图上哪些节点还没有笔记 |
| `note_map_set` | 把「这篇笔记讲的是图上哪些节点」落盘。节点名逐个校验，写错会被拒并给出相近候选 |

## 映射要建，但不用一次建完

不登记也能用 —— 笔记名和节点名对得上时（「区间 DP」 ↔ `5.区间dp.md`），
插件自己靠归一化兜底命中。**遇到对不上的再挂**：笔记叫 `Dijkstra 单源最短路`、
图上只有「最短路」这种，让 AI 用 `note_map_set` 挂一次，之后一直准。

不知道自己差哪些？`note_map_status` 会报
（「登记」和「挂上图节点」分开计数 —— 登记了但节点空着的那批也会如实点出来）。

## 只读承诺

这个插件**只读你的笔记，从不写**。唯一会写的文件是数据目录下的
`NOTE_MAP.yaml`（插件自己的映射账本）。你的原文一个字都不动。

## 验收

```bash
node verify.mjs
```

自造 fixture 跑全链路（不碰你的真数据）；如果你配了真实环境，
会额外做一次「真账本 + 真笔记前后指纹比对」，证明跑完什么都没动。
