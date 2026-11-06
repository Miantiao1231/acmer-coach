import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emptyPerson, savePerson, loadPerson, createCompanionTool } from '../lib/person.js'
import { loadEvents, reduceEvents } from '../lib/claims.js'

test('saving the displayed replacement corrects the legacy identity in the ledger', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-identity-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const oldIdentity = '小鲸，蓝头发的鲸鱼娘，他的女儿，也是他的教练'
  const legacy = emptyPerson()
  legacy.profile.identity = oldIdentity
  legacy.profile.likes = ['保留的喜好']
  assert.equal(savePerson(dir, legacy), true)
  const replacement = loadPerson(dir).profile.identity
  assert.equal(replacement.includes('亲密的伙伴'), true)

  const tool = createCompanionTool(dir)
  assert.equal((await tool.execute({ action: 'profile.set', identity: replacement }, { origin: 'human' })).ok, true)
  const active = [...reduceEvents(loadEvents(dir)).values()]
    .filter(c => c.status === 'active' && c.key === 'profile:identity')
  assert.deepEqual(active.map(c => c.value.text), [replacement])
  assert.equal(loadEvents(dir).some(e => e.claim?.value?.text === oldIdentity), true)
  assert.deepEqual(loadPerson(dir).profile.likes, ['保留的喜好'])
  assert.equal(JSON.parse(readFileSync(join(dir, 'person.json'), 'utf8')).profile.identity, replacement)
  const count = loadEvents(dir).length
  await tool.execute({ action: 'profile.set', identity: replacement }, { origin: 'human' })
  assert.equal(loadEvents(dir).length, count)
})
