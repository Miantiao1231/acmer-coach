// Glue between sleep/presence and the durable activity ledger.
//
// One page-load or turn is enough to advance the whole state machine: recover
// stale workers, pause reading while asleep, resume after a sleep, start the
// day's planned reading, and settle the journal/dream activities.
//
// Journal and dream text now comes from lib/journal.js (model-written archive).
// This module never invents text: if there is no archive entry, no activity is
// created.
import {
  updateActivityLedger, loadActivityLedger, currentActivity, planActivity, startActivity, pauseActivity,
  finishActivity, cancelActivity, heartbeatActivity, recoverActivities, attachActivityReceipt,
} from './activity-ledger.js'
import { readingSource, readingReceipt, writeReadingReflection } from './reading.js'

const READING_MINUTES = 25

const dayOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const stamp = (value) => {
  const at = Date.parse(String(value ?? ''))
  return Number.isFinite(at) ? at : null
}

export function settleActivities(dataDir, {
  now = new Date(), presence = null, person = null, sleepLedger = null, journal = null, dream = null,
} = {}) {
  const awake = !['sleep', 'nap'].includes(presence?.mode)
  const today = dayOf(now)
  const source = readingSource(person)
  const result = updateActivityLedger(dataDir, (ledger) => {
    let changed = false
    if (recoverActivities(ledger, { now }).length) changed = true

    const current = currentActivity(ledger)
    if (!awake) {
      if (current?.state === 'active') {
        if (pauseActivity(ledger, current.id, { now, reason: 'sleep' }).ok) changed = true
      }
    } else if (current?.state === 'active') {
      heartbeatActivity(ledger, current.id, { now })
      changed = true
      if (current.kind === 'reading' && current.plannedMinutes > 0
        && current.minutes >= current.plannedMinutes) {
        if (finishActivity(ledger, current.id, { now, outcome: '读完计划的一小段' }).ok) changed = true
      }
    } else {
      const resumable = ledger.activities.find((activity) => activity.kind === 'reading'
        && activity.state === 'paused' && activity.reason === 'sleep'
        && dayOf(new Date(activity.updatedAt)) === today)
      const planned = ledger.activities.find((activity) => activity.kind === 'reading' && activity.state === 'planned')
      const next = resumable ?? planned
      if (next && startActivity(ledger, next.id, { now }).ok) changed = true
    }

    // A reading paused on an earlier day must not block today's plan forever.
    for (const stale of ledger.activities) {
      if (stale.kind === 'reading' && stale.state === 'paused'
        && dayOf(new Date(stale.updatedAt)) !== today) {
        if (cancelActivity(ledger, stale.id, { now, reason: 'stale' }).ok) changed = true
      }
    }

    if (awake && source) {
      const plannedToday = ledger.activities.some((activity) => activity.kind === 'reading'
        && dayOf(new Date(activity.createdAt)) === today)
      if (!plannedToday) {
        if (planActivity(ledger, {
          kind: 'reading',
          title: `《${source.title}》`,
          note: source.kind === 'title' ? '只有书目，没有正文' : '',
          plannedMinutes: READING_MINUTES,
          now,
          source: { ...source, text: source.text.slice(0, 1200) },
        }).ok) changed = true
      }
    }

    if (journal?.text) {
      const id = `journal-${journal.day || today}`
      if (!ledger.activities.some((activity) => activity.id === id)) {
        const planned = planActivity(ledger, {
          kind: 'journal', title: '写日记', note: journal.text, now, id,
        })
        if (planned.ok) {
          startActivity(ledger, planned.activity.id, { now })
          const finished = finishActivity(ledger, planned.activity.id, { now })
          if (finished.ok) {
            attachActivityReceipt(ledger, planned.activity.id, {
              kind: 'journal', day: journal.day || today, text: journal.text.slice(0, 800), at: now.toISOString(),
            }, { now })
            changed = true
          }
        }
      }
    }

    if (dream?.text) {
      const id = dream.id || `dream-${dream.day || today}`
      if (!ledger.activities.some((activity) => activity.id === id)) {
        const planned = planActivity(ledger, {
          kind: 'dream', title: '夜里做了一个梦', note: dream.text, now, id,
        })
        if (planned.ok) {
          startActivity(ledger, planned.activity.id, { now })
          const finished = finishActivity(ledger, planned.activity.id, { now })
          if (finished.ok) {
            attachActivityReceipt(ledger, planned.activity.id, {
              kind: 'dream', day: dream.day || today, nightId: dream.nightId || '', text: dream.text.slice(0, 800), at: now.toISOString(),
            }, { now })
            changed = true
          }
        }
      }
    }

    return changed ? ledger : null
  })
  return result.ok ? result.ledger : null
}

// Reading takeaway: only for a reading that ended in the last day and has no
// receipt yet. Model failure leaves the receipt missing (not a fake quote).
export async function settleReadingReceipts(dataDir, {
  now = new Date(), person = null, llm = null, route = null, timeoutMs = 60000, canContinue = () => true,
} = {}) {
  if (!canContinue()) return 0
  const ledger = loadActivityLedger(dataDir)
  const pending = ledger.activities.find((activity) => activity.kind === 'reading'
    && activity.state === 'completed' && !activity.receipt
    && activity.source?.kind === 'excerpt' && activity.source?.title && activity.source?.hash
    && (stamp(activity.endedAt) ?? 0) >= now.getTime() - 24 * 3600 * 1000)
  if (!pending) return 0
  const source = pending.source
  const reflection = llm && route
    ? await writeReadingReflection({ llm, route, source, minutes: pending.minutes, now, timeoutMs })
    : null
  if (!canContinue()) return 0
  // -1 = there was work but the model failed; the caller backs off instead of
  // retrying every 60 seconds.
  if (!reflection) return -1
  const result = updateActivityLedger(dataDir, (current) => {
    const receipt = readingReceipt(current.activities.find((item) => item.id === pending.id), source, reflection, { now })
    const currentSource = readingSource(person)
    receipt.sourceChanged = currentSource?.bookId !== source.bookId || currentSource?.hash !== source.hash
    const attached = attachActivityReceipt(current, pending.id, receipt, { now })
    return attached.ok ? current : null
  })
  return result.ok ? 1 : 0
}

export { READING_MINUTES }
