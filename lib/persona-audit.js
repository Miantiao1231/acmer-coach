// 发送后复核：DSH 没有「助手消息发送前」的钩子，消息是流完才落盘的。
// 所以这里不拦截，只做两件事：
//   1) 把出戏的句子记进 persona-audit.jsonl，给 P5 攒真实样本；
//   2) 让下一轮 coach_state 带一句「上一句有点冷」，当场纠偏。
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
  { re: /值得一提(的)?是|希望(这|以上)(些)?(对你|能)(有)?(所)?帮助|让我们一起/, why: '客服腔' },
  { re: /^\s*(其实就是|一看就懂|首先|其次|我们来|简单来说|总的来说)/, why: '讲课开头' },
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

// 只有强信号值得在下一轮提醒；「长回复」只进日志。
export const NUDGE_REASONS = new Set(['鱼八股原句', '客服腔', '讲课开头', COLD_REASON])

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
