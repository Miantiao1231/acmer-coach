import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExternalSources } from '../lib/external-sources.js'
import { buildSources } from '../lib/proactive-sources.js'
import { interpretScreen } from '../lib/screen-observer.js'

const NOW = new Date('2026-10-30T12:00:00')

function mockFetch(routes) {
  const calls = []
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    for (const [part, body] of Object.entries(routes)) {
      if (String(url).includes(part)) {
        return { ok: true, status: 200, text: async () => typeof body === 'string' ? body : JSON.stringify(body) }
      }
    }
    return { ok: false, status: 404, text: async () => 'not found' }
  }
  return { fetch, calls }
}

test('external sources resolve IP, weather and a selected news feed without keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-external-'))
  try {
    const { fetch, calls } = mockFetch({
      'ipwho.is': { success: true, city: '郑州', region: '河南', country: '中国', latitude: 34.75, longitude: 113.62 },
      'api.open-meteo.com': {
        current: { temperature_2m: 18, apparent_temperature: 17, relative_humidity_2m: 70, precipitation: 0, weather_code: 61, wind_speed_10m: 12 },
        hourly: { time: ['2026-10-30T12:00'], precipitation_probability: [80], weather_code: [61] },
      },
      'newsnow.busiyi.world': { status: 'success', items: [{ title: '一条科技新闻', url: 'https://example.com/news', pubDate: '2026-10-30 11:00:00' }] },
    })
    const result = await loadExternalSources({
      dataDir: dir, now: NOW, env: { COACH_EXTERNAL_SOURCES: '1' }, fetchImpl: fetch,
      newsSources: ['ithome'],
    })
    assert.equal(result.geo.city, '郑州')
    assert.equal(result.weather.provider, 'open-meteo')
    assert.equal(result.weather.rainSoon, true)
    assert.equal(result.news.source, 'ithome')
    assert.equal(result.news.title, '一条科技新闻')
    assert.ok(calls.some(call => call.url.includes('ipwho.is')))
    assert.ok(calls.some(call => call.url.includes('newsnow.busiyi.world')))

    const before = calls.length
    const again = await loadExternalSources({
      dataDir: dir, now: new Date(NOW.getTime() + 5 * 60000), env: { COACH_EXTERNAL_SOURCES: '1' },
      fetchImpl: async () => { throw new Error('should use cache') }, newsSources: ['ithome'],
    })
    assert.equal(again.weather.temperature, 18)
    assert.equal(again.news.title, '一条科技新闻')
    assert.equal(calls.length, before, '缓存有效时不应再次请求')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('changing the city ignores the old weather failure cooldown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-external-'))
  let weatherOk = false
  const fetch = async (url) => {
    const text = String(url)
    if (text.includes('geocoding-api.open-meteo.com')) {
      const beijing = text.includes(encodeURIComponent('北京'))
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ name: beijing ? '北京' : '郑州', latitude: beijing ? 39.9 : 34.75, longitude: beijing ? 116.4 : 113.62 }] }) }
    }
    if (text.includes('api.open-meteo.com')) {
      if (!weatherOk) return { ok: false, status: 500, text: async () => 'bad' }
      return { ok: true, status: 200, text: async () => JSON.stringify({
        current: { temperature_2m: 20, weather_code: 0 },
        hourly: { time: ['2026-10-30T12:00'], precipitation_probability: [0] },
      }) }
    }
    return { ok: false, status: 404, text: async () => '' }
  }
  try {
    const first = await loadExternalSources({
      dataDir: dir, now: NOW, env: { COACH_EXTERNAL_SOURCES: '1' }, fetchImpl: fetch,
      city: '郑州', newsSources: ['ithome'],
    })
    assert.equal(first.weather, null)
    weatherOk = true
    const second = await loadExternalSources({
      dataDir: dir, now: new Date(NOW.getTime() + 60000), env: { COACH_EXTERNAL_SOURCES: '1' }, fetchImpl: fetch,
      city: '北京', newsSources: ['ithome'],
    })
    assert.equal(second.weather.city, '北京')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('news older than 24h is not passed off as fresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-external-'))
  try {
    const { fetch } = mockFetch({
      'newsnow.busiyi.world': { status: 'success', items: [{ title: '三天前的旧闻', url: 'https://example.com/old', pubDate: '2026-10-27 11:00:00' }] },
    })
    const result = await loadExternalSources({
      dataDir: dir, now: NOW, env: { COACH_EXTERNAL_SOURCES: '1' }, fetchImpl: fetch,
      newsSources: ['ithome'],
    })
    assert.equal(result.news, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('QWeather key is used when present and falls back to Open-Meteo when it fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-external-'))
  try {
    const seen = []
    const fetch = async (url, options = {}) => {
      seen.push({ url: String(url), key: options.headers?.['X-QW-Api-Key'] })
      if (String(url).includes('ipwho.is')) return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, city: '郑州', latitude: 34.75, longitude: 113.62 }) }
      if (String(url).includes('test.qweatherapi.com')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ now: { temp: '20', feelsLike: '19', humidity: '60', windScale: '2', text: '小雨' } }) }
      }
      if (String(url).includes('api.open-meteo.com')) return { ok: false, status: 500, text: async () => 'bad' }
      return { ok: false, status: 404, text: async () => '' }
    }
    const result = await loadExternalSources({
      dataDir: dir, now: NOW, env: { COACH_EXTERNAL_SOURCES: '1' }, fetchImpl: fetch,
      qweatherKey: 'test-key', qweatherHost: 'test.qweatherapi.com', newsSources: ['ithome'],
    })
    assert.equal(result.weather.provider, 'qweather')
    assert.equal(result.weather.text, '小雨')
    assert.ok(seen.some(call => call.key === 'test-key'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('external candidates carry source evidence and cooldowns', () => {
  const candidates = buildSources({
    person: { relation: { milestones: [] }, library: [] },
    progress: { nodes: {} }, target: null, classWindow: null, lastUserAt: '', life: null, vp: null,
    external: {
      weather: { city: '郑州', text: '小雨', temperature: 16, rainSoon: true, change: 'condition', provider: 'qweather', at: NOW.toISOString() },
      news: { source: 'ithome', sourceLabel: 'IT之家', title: '一条新闻', url: 'https://example.com', at: NOW.toISOString() },
    },
    screen: { summary: '像在 VS Code 改代码', confidence: 'high' },
    now: NOW,
  })
  const weather = candidates.find(item => item.kind === 'weather')
  const news = candidates.find(item => item.kind === 'news')
  const meal = candidates.find(item => item.kind === 'meal')
  const screen = candidates.find(item => item.kind === 'screen')
  assert.match(weather.evidence, /郑州/)
  assert.match(weather.evidence, /小雨/)
  assert.equal(weather.cooldownMinutes, 180)
  assert.match(news.evidence, /IT之家/)
  assert.equal(meal.topic, '这个点她也在吃午饭')
  assert.match(screen.evidence, /VS Code/)
})

test('screen interpretation sends one image and keeps only a short observation', async () => {
  let options
  const llm = {
    resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
    stream(value) {
      options = value
      return (async function* () {
        yield { type: 'text-delta', text: '{"summary":"像在 VS Code 改代码","kind":"coding","confidence":"high"}' }
      })()
    },
  }
  const attachments = { saveImages: async () => [{ attachmentId: 'a1' }] }
  const result = await interpretScreen({
    llm, route: { provider: 'p', model: 'm' }, attachments,
    image: { data: Buffer.from('fake-image'), mediaType: 'image/jpeg' }, now: NOW,
  })
  assert.equal(result.summary, '像在 VS Code 改代码')
  assert.equal(result.kind, 'coding')
  const content = options.messages[0].content
  assert.equal(content[0].type, 'image')
  assert.equal(content[0].attachment.attachmentId, 'a1')
  assert.equal(content[1].type, 'text')
})

test('screen interpretation deletes its one-off normalized image after reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coach-screen-clean-'))
  const path = join(dir, 'screen.jpg')
  writeFileSync(path, 'normalized-image')
  try {
    const result = await interpretScreen({
      llm: {
        resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }),
        stream: () => (async function* () {
          yield { type: 'text-delta', text: '{"summary":"像在改代码","kind":"coding","confidence":"high"}' }
        })(),
      },
      route: { provider: 'p', model: 'm' },
      attachments: {
        saveImages: async () => [{ attachmentId: 'a1' }],
        imageHostPath: () => path,
      },
      image: { data: Buffer.from('fake-image'), mediaType: 'image/jpeg' }, now: NOW,
    })
    assert.equal(result.summary, '像在改代码')
    assert.equal(existsSync(path), false, '本次截图应在解读完成后删除')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('screen interpretation refuses a text-only model before saving the image', async () => {
  let saved = false
  const result = await interpretScreen({
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text'] }), stream: () => { throw new Error('should not stream') } },
    route: { provider: 'p', model: 'text-only' },
    attachments: { saveImages: async () => { saved = true; return [] } },
    image: { data: Buffer.from('fake') }, now: NOW,
  })
  assert.equal(result, null)
  assert.equal(saved, false)
})
