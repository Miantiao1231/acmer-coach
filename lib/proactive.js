// 主动联系只保留一个入口：查状态 / 开 / 关。
// 话题选择、发送、预算、未回复计数全部由 proactive-worker 自己维护；
// 模型不再有 next/sent 两个动作，避免出现“预览不记账、记了账又没发”的第二套账。
import { defineTool } from '@deepseek-ai/dsh-tools'

const clean = (value) => String(value ?? '').trim()

export function createProactiveTool({ armWorker, disarmWorker, workerStatus } = {}) {
  const fail = (reject) => ({ ok: false, reject, summary: '' })
  return defineTool({
    name: 'coach_proactive',
    description: '开启、关闭或查看插件自己的主动联系 worker。主动话题由 worker 按证据和节奏自己选；模型不负责挑候选，也不手动记账。arm 开启；disarm 关闭；status 查看节奏。',
    parameters: {
      action: { type: 'string', required: true, enum: ['arm', 'disarm', 'status'] },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reject: { type: 'string', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, result) => [{ type: 'text', text: result.ok ? result.summary : result.reject }],
    },
    async execute(args = {}, exec = {}) {
      const action = String(args.action ?? 'status')
      const sessionId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : ''
      try {
        if (action === 'arm') {
          if (typeof armWorker !== 'function') return fail('主动 worker 未接线。')
          const result = armWorker(sessionId)
          if (!result?.ok) return fail(result?.reject || '开启失败。')
          return { ok: true, reject: '', summary: result.summary || '主动联系已开启。' }
        }
        if (action === 'disarm') {
          if (typeof disarmWorker !== 'function') return fail('主动 worker 未接线。')
          const result = disarmWorker()
          if (!result?.ok) return fail(result?.reject || '关闭失败。')
          return { ok: true, reject: '', summary: result.summary || '主动联系已关闭。' }
        }
        if (action === 'status') {
          if (typeof workerStatus !== 'function') return fail('主动 worker 未接线。')
          const s = workerStatus()
          const occupied = s.occupiedToday ?? s.sentToday ?? 0
          const summary = `主动联系：${s.enabled ? '已开' : '关'}；今天已发 ${s.sentToday}${occupied > (s.sentToday ?? 0) ? `（占用 ${occupied}）` : ''}；未回复 ${s.unanswered} 次；下次 ${s.nextAt || '未排'}。`
          return { ok: true, reject: '', summary: clean(summary) }
        }
        return fail('action 只能是 arm / disarm / status。')
      } catch (err) {
        return fail(String(err?.message || '读取主动状态失败。'))
      }
    },
  })
}
