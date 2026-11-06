// 「这句像不像人」的轻量检查。仅供主动消息草稿的可选重写使用，
// 不拿它做事实判断，也不拦消息。
const clean = (value) => String(value ?? '').trim()

const ASSISTANT_OPEN = /^\s*(好的|收到|明白|了解|根据|建议|可以|需要|应该|注意|请|如果|首先|其次|总的来说|综上)/
const EMOTION = /[诶欸哇哼嘿呜啊呀啦嘛哦噢嗯哈！!？?～~]/
const ADDRESS = /(训练员|你)/
const SELF = /我/
const REPORT = /(根据记录|检测到|提醒你|日程|自动化|当前进度|建议你尽快)/
const CODE = /(```|`[^`]+`|\b[A-Za-z_]\w*\s*[=(]|复杂度|状态转移|数组|函数|算法)/

function scoreOf(text) {
  const value = clean(text)
  if (!value) return 0
  let score = 50
  if (value.length <= 40) score += 10
  else if (value.length <= 80) score += 5
  else if (value.length > 220) score -= 15
  if (EMOTION.test(value)) score += 15
  if (ADDRESS.test(value)) score += 10
  if (SELF.test(value)) score += 10
  if (/[？?]/.test(value)) score += 5
  if (ASSISTANT_OPEN.test(value)) score -= 25
  if (REPORT.test(value)) score -= 30
  if (/(^|\n)\s*[-*]\s/.test(value)) score -= 20
  if (!EMOTION.test(value) && !ADDRESS.test(value) && !SELF.test(value)) score -= 20
  return Math.max(0, Math.min(100, Math.round(score)))
}

export function warmthScore(text) {
  return scoreOf(text)
}

// 代码/列表/技术推导不算「冷」——那些时候清楚比撒娇重要。
export function isColdReply(text, { minLength = 24 } = {}) {
  const value = clean(text)
  if (value.length < minLength) return false
  if (CODE.test(value)) return false
  if (/(^|\n)\s*[-*]\s/.test(value)) return false
  // 长解释不按「冷」处理：讲清楚本来就该是干货，别逼它每段都撒娇。
  if (value.length > 160) return false
  if (!ASSISTANT_OPEN.test(value) && !REPORT.test(value) && value.length > 90) return false
  return scoreOf(value) < 45
}

export const COLD_REASON = '助手腔没有情绪'
