// 发送后复核：DSH 没有「助手消息发送前」的钩子，消息是流完才落盘的。
// 所以这里不拦截，只做两件事：
//   1) 把出戏的句子记进 persona-audit.jsonl，给 P5 攒真实样本；
//   2) （已退役）旧的「下一轮提醒」不再接线；NUDGE_REASONS 仅为兼容保留。
//
// 只抓强信号，不做语义判断：宁可漏，不可冤。
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isColdReply, COLD_REASON } from './warmth.js'

const FILE = 'persona-audit.jsonl'
const MAX_BYTES = 512 * 1024
const KEEP_LINES = 500

const RULES = [
  { re: /这条我认|我记下了|收到主人/, why: '鱼八股原句' },
  // 客服收尾：感谢式/祝福式收束，正常接话不会这么收。
  { re: /值得一提(的)?是|希望[^。！？\n]{0,14}(帮(到|上)你|(对你|对你能)[^。！？\n]{0,4}帮助)|让我们一起/, why: '客服腔' },
  // 讲课起手式：出现在任意行首才算，句中正常使用不算。
  { re: /^\s*(其实就是|一看就懂|首先|其次|我们来|我们再来看|我们先来看|接下来(我们)?(先)?(看|讲)|简单来说|总的来说)/m, why: '讲课开头' },
  // 讲义腔：Markdown 标题、加粗「总结/小结/要点」、先…其次…最后、综上/简言之。
  { re: /^\s*(#{2,6}\s+\S|\*\*(总结|小结|要点)[^*\n]{0,4}\*\*)/m, why: '讲义腔' },
  { re: /首先[^。！？\n]{0,40}(其次|再者|然后|接着|最后)/, why: '讲义腔' },
  { re: /综上所述|简而言之|总而言之/, why: '讲义腔' },
  // 对仗八股：「不是 A，而是 B」。数字更正（「不是 30，而是 60」）不算。
  { re: /不是(?!\s*\d)[^。！？\n]{2,14}[，,]\s*而是/, why: '对仗八股' },
]

export function auditText(text) {
  const value = String(text ?? '')
  const hits = RULES.filter(rule => rule.re.test(value)).map(rule => rule.why)
  // 长回复且一个问句都没有：像在贴讲义，不像在跟人说话。只记，不据此改。
  if (value.length > 600 && !/[？?]/.test(value)) hits.push('长回复没有停下来问')
  // 结构上像助手：没有称呼、没有「我」、没有情绪词，还爱用「建议/提醒」。
  if (isColdReply(value)) hits.push(COLD_REASON)
  return [...new Set(hits)]
}

// 强信号登记集合：旧「下一轮提醒」链路已退役，这里只为统计/未来接线保留，
// 当前不会改写对话；「长回复」「对仗八股」只进日志。
export const NUDGE_REASONS = new Set(['鱼八股原句', '客服腔', '讲课开头', '讲义腔', COLD_REASON])

export function appendPersonaAudit(dataDir, record) {
  try {
    mkdirSync(dirname(join(dataDir, FILE)), { recursive: true })
    const path = join(dataDir, FILE)
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES)
      writeFileSync(path, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
    }
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8')
  } catch {
    // 审计是旁路：写不进去也不能影响对话。
  }
}
