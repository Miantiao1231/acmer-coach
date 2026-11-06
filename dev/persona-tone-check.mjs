import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const personaPath = new URL('../assets/persona/xiaojing-coach.md', import.meta.url)
const rulesPath = new URL('../assets/rules/coach-rules.md', import.meta.url)

const persona = fs.readFileSync(personaPath, 'utf8')
const rules = fs.readFileSync(rulesPath, 'utf8')

// 黑名单段本身要写「不要说什么」，所以扫描时把它切掉。
const blacklistAt = persona.indexOf('## 毒句黑名单')
assert.ok(blacklistAt > 0, 'persona 必须有「毒句黑名单」段')
// 正文里用「」举例说明「别这么说」的不算违规；只查作者自己写的话。
const body = persona.slice(0, blacklistAt).replace(/「[^」]*」/g, '')

test('persona keeps character, expression and execution boundaries', () => {
  for (const section of ['## 我是谁', '## 我怎么说话', '## 我的脾气', '## 演法参照',
    '## 毒句黑名单', '## 边界', '## 主动联系', '## 他还没说完']) {
    assert.ok(persona.includes(section), `缺少段落：${section}`)
  }
})

test('persona has enough performance scenes, not just adjectives', () => {
  const start = persona.indexOf('## 演法参照')
  const end = persona.indexOf('## 毒句黑名单')
  const scenes = persona.slice(start, end).match(/^\*\*[^*]+\*\*$/gm) || []
  assert.ok(scenes.length >= 3, `演法参照只有 ${scenes.length} 个场景`)
})

test('persona avoids fish-cliche phrases and action brackets outside the blacklist', () => {
  const banned = [/这条我认/, /我记下了/, /收到主人/, /不是.{1,14}[，,]\s*(而)?是/,
    /说到(了)?根上/, /这本身就是/, /总(的)?(来|而言之)说?/, /值得一提的是/, /希望(这|以上)(些)?(对你|能)(有)?(所)?帮助/,
    /让我们一起/]
  for (const re of banned) assert.doesNotMatch(body, re, `persona 正文出现鱼八股：${re}`)
  assert.doesNotMatch(body, /[（(][^）)]{0,10}(尾巴|鳍|耳朵|爪子|蹭蹭|摇摇|啪嗒|眨眼|歪头|叉腰)[^）)]{0,8}[）)]/,
    'persona 正文出现动作括号')
})

test('persona keeps the private-chat contracts the host tests rely on', () => {
  assert.match(persona, /用户.*当前|当下.*用户/)
  assert.match(persona, /我还没说完.*等他把话说完/)
  assert.match(persona, /明确允许.*coach_proactive arm/)
  assert.match(persona, /说停.*coach_proactive disarm/)
  assert.doesNotMatch(persona, /schedule_create|schedule_list|schedule_delete/)
  assert.match(persona, /被主动 worker 叫醒.*像自己忽然想起他/)
})

test('coach rules keep feelings out of the delivery', () => {
  assert.match(rules, /情绪不改变判断/)
  assert.match(rules, /工具参数/)
  assert.ok(rules.length < 7000, `rules 有 ${rules.length} 字符`)
})

test('coach state uses one shared reply-style reminder', () => {
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /const REPLY_STYLE =/)
  assert.equal((source.match(/lines\.push\(REPLY_STYLE\)/g) || []).length, 1,
    '常态分支要推一次 REPLY_STYLE')
  assert.ok(source.includes('REPLY_STYLE,'), '首次使用分支也要带上 REPLY_STYLE')
})

test('coach rules keep the judgment anchors', () => {
  for (const re of [/可做题/, /快速扫描/, /每周.*一个.*可观察/, /周末.*复盘/,
    /复习.*集中.*上课时段/, /不.*每道题.*复习/, /coach_target contests.*VP/, /WF 名额.*不能凭印象/]) {
    assert.match(rules, re, `rules 缺少锚点：${re}`)
  }
})
