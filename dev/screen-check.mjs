import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  grantScreenConsent, revokeScreenConsent, loadScreenConsent, activeScreenConsent, screenConsentLine,
} from '../lib/screen-consent.js'
import {
  saveScreenCapture, loadScreenCaptures, latestScreenCapture, readScreenOriginal, dropScreenCapture, originalPath,
} from '../lib/screen-originals.js'
import { observeScreen } from '../lib/screen-observer.js'

const at = (value) => new Date(value)
const image = (fill = 1) => ({ data: Buffer.alloc(2048, fill), mediaType: 'image/jpeg', width: 1600, height: 900 })
const observation = { summary: '在写代码', kind: 'coding', confidence: 'high' }

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'screen-check-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('only a human grants screen access, and it expires', () => {
  const t = tmp()
  try {
    assert.equal(grantScreenConsent(t.dir, { by: 'model', now: at('2026-11-02T10:00:00') }).ok, false)
    const granted = grantScreenConsent(t.dir, { minutes: 30, now: at('2026-11-02T10:00:00') })
    assert.equal(granted.ok, true)
    assert.ok(activeScreenConsent(loadScreenConsent(t.dir), at('2026-11-02T10:20:00')))
    assert.equal(activeScreenConsent(loadScreenConsent(t.dir), at('2026-11-02T10:31:00')), null)
    assert.match(screenConsentLine(loadScreenConsent(t.dir), at('2026-11-02T10:10:00')), /还剩 20 分钟/)

    const second = grantScreenConsent(t.dir, { minutes: 60, now: at('2026-11-02T11:00:00') })
    assert.equal(second.ok, true)
    assert.equal(revokeScreenConsent(t.dir, { now: at('2026-11-02T11:05:00') }).ok, true)
    assert.equal(activeScreenConsent(loadScreenConsent(t.dir), at('2026-11-02T11:06:00')), null)
    assert.equal(revokeScreenConsent(t.dir, { now: at('2026-11-02T11:07:00') }).ok, false)
  } finally { t.done() }
})

test('no consent means no capture, even if the switch is on', async () => {
  const t = tmp()
  try {
    const result = await observeScreen({ dataDir: t.dir, route: { provider: 'p', model: 'm' }, now: at('2026-11-02T10:00:00') })
    assert.equal(result, null)
    assert.equal(loadScreenCaptures(t.dir).captures.length, 0)
  } finally { t.done() }
})

test('the original is immutable and travels with its interpretation', () => {
  const t = tmp()
  try {
    const saved = saveScreenCapture(t.dir, { image: image(7), observation, consentId: 'sc-1', now: at('2026-11-02T10:00:00'), retainOriginal: true })
    assert.equal(saved.ok, true)
    assert.equal(saved.capture.summary, '在写代码')
    assert.equal(saved.capture.bytes, 2048)
    assert.ok(existsSync(originalPath(t.dir, saved.capture.id)))
    assert.deepEqual(readScreenOriginal(t.dir, saved.capture.id), image(7).data)

    const latest = latestScreenCapture(loadScreenCaptures(t.dir), { now: at('2026-11-02T11:00:00') })
    assert.equal(latest.id, saved.capture.id)
    // 一天以外的截图不再当「刚刚看到的」用。
    assert.equal(latestScreenCapture(loadScreenCaptures(t.dir), { now: at('2026-11-04T11:00:00') }), null)
  } finally { t.done() }
})

test('dropping a capture removes the file too', () => {
  const t = tmp()
  try {
    const saved = saveScreenCapture(t.dir, { image: image(3), observation, now: at('2026-11-02T10:00:00'), retainOriginal: true })
    assert.equal(dropScreenCapture(t.dir, saved.capture.id, { now: at('2026-11-02T10:05:00') }).ok, true)
    assert.equal(existsSync(originalPath(t.dir, saved.capture.id)), false)
    assert.equal(readScreenOriginal(t.dir, saved.capture.id), null)
    assert.equal(dropScreenCapture(t.dir, saved.capture.id).ok, false)
  } finally { t.done() }
})

test('the capture index is bounded', () => {
  const t = tmp()
  try {
    for (let i = 0; i < 45; i += 1) {
      saveScreenCapture(t.dir, { image: image(i), observation, now: at('2026-11-02T10:00:00') })
    }
    assert.equal(loadScreenCaptures(t.dir).captures.length, 40)
  } finally { t.done() }
})
