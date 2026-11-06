// 外部话题：IP 定位、天气、新闻；饭点/屏幕时间在 proactive-sources 里现算。
// 只搬「有出处的一小句话」，不做信息流，也不把外部内容写进事实账本。
// 所有请求都可失败：缓存过期就重试，失败返回旧值或 null，不阻塞主动 worker。
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CACHE_FILE = 'external-cache.json'
const CACHE_VERSION = 1
const GEO_TTL = 24 * 3600 * 1000
const WEATHER_TTL = 30 * 60 * 1000
const NEWS_TTL = 30 * 60 * 1000
const GEO_STALE_TTL = 7 * 86400 * 1000
const MAX_BYTES = 256 * 1024
const FETCH_TIMEOUT = 5000

export const DEFAULT_NEWS_SOURCES = [
  'ithome', 'solidot', 'aihot', 'github-trending-today',
  'hackernews', 'v2ex', 'sspai', 'juejin', 'zhihu', 'weibo',
]

export const NEWS_LABELS = {
  zhihu: '知乎热榜',
  weibo: '微博热搜',
  ithome: 'IT之家',
  solidot: 'Solidot',
  aihot: 'AIHOT',
  'github-trending-today': 'GitHub Trending',
  hackernews: 'Hacker News',
  v2ex: 'V2EX',
  sspai: '少数派',
  juejin: '掘金',
}

const clean = (value) => String(value ?? '').trim()
const iso = (date) => date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : ''
const normalizeHost = (value) => {
  const host = clean(value).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
  return /^[a-z0-9.-]+$/.test(host) ? host : ''
}
const readKeyFile = (dataDir) => {
  try { return clean(readFileSync(join(dataDir, 'qweather-key.txt'), 'utf8')).slice(0, 200) } catch { return '' }
}
const readHostFile = (dataDir) => {
  try { return normalizeHost(readFileSync(join(dataDir, 'qweather-host.txt'), 'utf8')) } catch { return '' }
}
const pad = (n) => String(n).padStart(2, '0')
const ymd = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null

// WMO weather code 的粗粒度翻译；只说“下雨/下雪/很热”，不假装精确。
export function weatherText(code) {
  const value = Number(code)
  if (value === 0) return '晴'
  if ([1, 2].includes(value)) return '多云'
  if (value === 3) return '阴'
  if ([45, 48].includes(value)) return '有雾'
  if ([51, 53, 55, 56, 57].includes(value)) return '小雨'
  if ([61, 63, 65, 66, 67].includes(value)) return '下雨'
  if ([71, 73, 75, 77].includes(value)) return '下雪'
  if ([80, 81, 82].includes(value)) return '阵雨'
  if ([85, 86].includes(value)) return '阵雪'
  if ([95, 96, 99].includes(value)) return '打雷'
  return '天气一般'
}

function weatherGroup(code) {
  const value = Number(code)
  if (!Number.isFinite(value)) return ''
  if (value === 0) return 'clear'
  if ([1, 2, 3].includes(value)) return 'cloud'
  if ([45, 48].includes(value)) return 'fog'
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return 'rain'
  if ([71, 73, 75, 77, 85, 86].includes(value)) return 'snow'
  if ([95, 96, 99].includes(value)) return 'storm'
  return ''
}

function stripHtml(value) {
  return clean(String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'"))
    .replace(/\s+/g, ' ')
    .slice(0, 220)
}

function readCache(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, CACHE_FILE), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) && raw.version === CACHE_VERSION ? raw : { version: CACHE_VERSION }
  } catch {
    return { version: CACHE_VERSION }
  }
}

function writeCache(dataDir, cache) {
  const path = join(dataDir, CACHE_FILE)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8')
    renameSync(tmp, path)
  } catch {
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
}

const fresh = (entry, ttl, now) => {
  const at = Date.parse(entry?.at ?? '')
  return Number.isFinite(at) && now.getTime() - at >= 0 && now.getTime() - at <= ttl
}
const staleButUsable = (entry, ttl, now) => {
  const at = Date.parse(entry?.at ?? '')
  return Number.isFinite(at) && now.getTime() - at >= 0 && now.getTime() - at <= ttl
}

async function fetchText(fetchImpl, url, { timeoutMs = FETCH_TIMEOUT, headers = {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch')
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (acmer-coach)', accept: 'application/json, text/xml, application/rss+xml, */*', ...headers },
    })
    if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'}`)
    const text = await res.text()
    if (text.length > MAX_BYTES) throw new Error('response too large')
    return text
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(fetchImpl, url, options) {
  return JSON.parse(await fetchText(fetchImpl, url, options))
}

async function geocodeCity(city, fetchImpl, now) {
  const name = clean(city).slice(0, 80)
  if (!name) return null
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`
  try {
    const data = await fetchJson(fetchImpl, url)
    const hit = Array.isArray(data?.results) ? data.results[0] : null
    if (!hit || !Number.isFinite(Number(hit.latitude)) || !Number.isFinite(Number(hit.longitude))) return null
    return {
      at: iso(now), source: 'manual', city: clean(hit.name || name).slice(0, 40),
      region: clean(hit.admin1).slice(0, 40), country: clean(hit.country).slice(0, 20),
      latitude: Number(hit.latitude), longitude: Number(hit.longitude),
    }
  } catch {
    return null
  }
}

async function ipWhoIs(fetchImpl, now) {
  try {
    const data = await fetchJson(fetchImpl, 'https://ipwho.is/')
    if (data?.success === false) return null
    const latitude = number(data?.latitude)
    const longitude = number(data?.longitude)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    return {
      at: iso(now), source: 'ipwho.is', city: clean(data.city || data.region).slice(0, 40),
      region: clean(data.region).slice(0, 40), country: clean(data.country).slice(0, 20),
      latitude, longitude,
    }
  } catch {
    return null
  }
}

async function ipInfo(fetchImpl, now) {
  try {
    const data = await fetchJson(fetchImpl, 'https://ipinfo.io/json')
    const [lat, lon] = clean(data?.loc).split(',').map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return {
      at: iso(now), source: 'ipinfo.io', city: clean(data.city || data.region).slice(0, 40),
      region: clean(data.region).slice(0, 40), country: clean(data.country).slice(0, 20),
      latitude: lat, longitude: lon,
    }
  } catch {
    return null
  }
}

async function resolveGeo({ cache, now, fetchImpl, city }) {
  const manual = clean(city).slice(0, 80)
  if (manual) {
    const key = `manual:${manual.toLowerCase()}`
    const cached = cache.geoManual
    if (cached?.key === key && fresh(cached, GEO_TTL, now)) return cached.data
    const data = await geocodeCity(manual, fetchImpl, now)
    if (data) {
      cache.geoManual = { key, at: iso(now), data }
      return data
    }
    // 手动城市解析失败就退回上次的 IP 位置；不假装成手动城市。
  }
  const cached = cache.geoIp
  if (cached && fresh(cached, GEO_TTL, now)) return cached.data
  const data = (await ipWhoIs(fetchImpl, now)) ?? (await ipInfo(fetchImpl, now))
  if (data) {
    cache.geoIp = { at: iso(now), data }
    return data
  }
  // 网络挂了但旧位置还没太旧：先沿用，避免今天完全失去天气。
  if (cached && staleButUsable(cached, GEO_STALE_TTL, now)) return cached.data
  return null
}

function withChange(previous, next) {
  if (!previous || !next) return next
  const groupChanged = previous.group && next.group && previous.group !== next.group
  const tempChanged = Number.isFinite(previous.temperature) && Number.isFinite(next.temperature)
    && Math.abs(previous.temperature - next.temperature) >= 6
  return { ...next, change: groupChanged ? 'condition' : tempChanged ? 'temperature' : '' }
}

async function loadQWeather({ cache, now, fetchImpl, key, host, lat, lon }) {
  const url = `https://${host}/v7/weather/now?location=${lon.toFixed(2)},${lat.toFixed(2)}`
  try {
    const data = await fetchJson(fetchImpl, url, { headers: { 'X-QW-Api-Key': key } })
    const nowData = data?.now
    if (!nowData) return null
    const text = clean(nowData.text).slice(0, 20)
    const value = {
      provider: 'qweather', city: '', at: iso(now),
      temperature: number(nowData.temp), apparent: number(nowData.feelsLike),
      humidity: number(nowData.humidity), wind: clean(nowData.windScale).slice(0, 20),
      text, code: null, group: weatherGroupByText(text),
      rainSoon: /雨|雪|雷/.test(text), rainProb: null, change: '',
    }
    return value
  } catch {
    return null
  }
}

function weatherGroupByText(text) {
  if (/雨/.test(text)) return 'rain'
  if (/雪/.test(text)) return 'snow'
  if (/雷/.test(text)) return 'storm'
  if (/雾|霾/.test(text)) return 'fog'
  if (/晴/.test(text)) return 'clear'
  if (/云|阴/.test(text)) return 'cloud'
  return ''
}

async function loadOpenMeteo({ cache, now, fetchImpl, lat, lon }) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m'
    + '&hourly=precipitation_probability,weather_code&forecast_hours=6&timezone=auto'
  try {
    const data = await fetchJson(fetchImpl, url)
    const current = data?.current
    if (!current) return null
    const code = number(current.weather_code)
    const hours = Array.isArray(data?.hourly?.time) ? data.hourly.time : []
    let rainProb = null
    for (let i = 0; i < hours.length; i += 1) {
      const prob = number(data.hourly.precipitation_probability?.[i])
      if (prob === null) continue
      rainProb = rainProb === null ? prob : Math.max(rainProb, prob)
    }
    const group = weatherGroup(code)
    const value = {
      provider: 'open-meteo', city: '', at: iso(now),
      temperature: number(current.temperature_2m), apparent: number(current.apparent_temperature),
      humidity: number(current.relative_humidity_2m), wind: number(current.wind_speed_10m),
      text: weatherText(code), code, group,
      rainSoon: ['rain', 'snow', 'storm'].includes(group) || (rainProb !== null && rainProb >= 60),
      rainProb, change: '',
    }
    return value
  } catch {
    return null
  }
}

async function loadWeather({ cache, now, fetchImpl, geo, qweatherKey, qweatherHost }) {
  if (!geo) return null
  const key = `${geo.latitude.toFixed(2)},${geo.longitude.toFixed(2)}`
  const cached = cache.weather
  if (cached?.key === key && fresh(cached, WEATHER_TTL, now) && cached.data) return cached.data
  let value = null
  if (qweatherKey && qweatherHost) {
    value = await loadQWeather({ cache, now, fetchImpl, key: qweatherKey, host: qweatherHost, lat: geo.latitude, lon: geo.longitude })
  }
  if (!value) value = await loadOpenMeteo({ cache, now, fetchImpl, lat: geo.latitude, lon: geo.longitude })
  // 兜底的旧天气也只能是同一个地点；换城市后不能把旧城市挂到新 key 下。
  if (!value) return cached?.key === key && staleButUsable(cached, 6 * 3600 * 1000, now) ? cached.data : null
  value.city = geo.city || geo.region || '你那边'
  value = withChange(cached?.data, value)
  cache.weather = { key, at: iso(now), data: value }
  return value
}

function parseNewsSources(value) {
  const list = Array.isArray(value) ? value : clean(value).split(/[,，\s]+/)
  const allowed = new Set(DEFAULT_NEWS_SOURCES)
  const picked = list.map(item => clean(item)).filter(item => allowed.has(item))
  return picked.length ? [...new Set(picked)] : DEFAULT_NEWS_SOURCES
}

const safeUrl = (value) => /^https?:\/\//i.test(clean(value)) ? clean(value).slice(0, 500) : ''

function newsItemFromNewsNow(id, data, now) {
  const items = Array.isArray(data?.items) ? data.items : []
  const rows = items.map(item => {
    const title = stripHtml(item?.title)
    const url = safeUrl(item?.url || item?.mobileUrl || item?.id)
    const at = clean(item?.pubDate || item?.extra?.date)
    const parsed = Date.parse(at)
    return { title, url, at: Number.isFinite(parsed) ? new Date(parsed).toISOString() : '' }
  }).filter(item => item.title && item.url)
  const recent = rows.filter(item => !item.at || Math.abs(now.getTime() - Date.parse(item.at)) <= 24 * 3600 * 1000)
  // 只取 24h 内的一条；旧闻不冒充“她刚看到的”，让下一个源接手。
  return recent[0] ?? null
}

async function loadNewsNow({ cache, now, fetchImpl, id }) {
  const key = `news:${id}`
  const cached = cache[key]
  if (cached && fresh(cached, NEWS_TTL, now) && cached.data) return cached.data
  try {
    const data = await fetchJson(fetchImpl, `https://newsnow.busiyi.world/api/s?id=${encodeURIComponent(id)}`)
    const item = newsItemFromNewsNow(id, data, now)
    if (!item) return null
    const value = {
      id, source: id, sourceLabel: NEWS_LABELS[id] || id,
      title: item.title, url: item.url, at: item.at || iso(now), fetchedAt: iso(now),
    }
    cache[key] = { at: iso(now), data: value }
    return value
  } catch {
    return null
  }
}

async function loadHackerNews(fetchImpl, now) {
  try {
    const data = await fetchJson(fetchImpl, 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=8')
    const hit = Array.isArray(data?.hits) ? data.hits.find(item => item?.title && safeUrl(item?.url)) : null
    if (!hit) return null
    return {
      id: 'hackernews', source: 'hackernews', sourceLabel: 'Hacker News',
      title: stripHtml(hit.title), url: safeUrl(hit.url),
      at: hit.created_at || iso(now), fetchedAt: iso(now),
    }
  } catch {
    return null
  }
}

async function loadNews({ cache, now, fetchImpl, sources }) {
  const list = parseNewsSources(sources)
  // 按天/小时轮换起点：不是每天只盯知乎，也不是每条都来自同一个源。
  const start = Math.abs(Math.floor(now.getTime() / 3600000)) % list.length
  for (let offset = 0; offset < Math.min(3, list.length); offset += 1) {
    const id = list[(start + offset) % list.length]
    let value = await loadNewsNow({ cache, now, fetchImpl, id })
    if (!value && id === 'hackernews') value = await loadHackerNews(fetchImpl, now)
    if (value) return value
  }
  return null
}

export async function loadExternalSources({
  dataDir, now = new Date(), env = process.env, fetchImpl = globalThis.fetch,
  city = '', qweatherKey = '', qweatherHost = '', newsSources = null,
} = {}) {
  const out = { geo: null, weather: null, news: null }
  if (env?.COACH_EXTERNAL_SOURCES === '0') return out
  const cache = readCache(dataDir)
  const recentFailure = (key, ttl) => {
    const at = Date.parse(cache[key] ?? '')
    return Number.isFinite(at) && now.getTime() - at >= 0 && now.getTime() - at < ttl
  }
  const manualCity = clean(city || env?.COACH_WEATHER_CITY).slice(0, 80)
  if (!recentFailure('geoFailAt', 30 * 60 * 1000)) {
    out.geo = await resolveGeo({ cache, now, fetchImpl, city: manualCity })
    if (!out.geo) cache.geoFailAt = iso(now)
  } else {
    out.geo = cache.geoIp?.data ?? cache.geoManual?.data ?? null
  }
  const geoKey = out.geo ? `${out.geo.latitude.toFixed(2)},${out.geo.longitude.toFixed(2)}` : ''
  const sameWeatherKey = Boolean(geoKey) && cache.weather?.key === geoKey
  // 失败冷却只对同一个地点有效；换了城市/IP 必须立刻重取，不能拿旧城市天气顶上。
  if (out.geo && (!recentFailure('weatherFailAt', 15 * 60 * 1000) || !sameWeatherKey)) {
    const key = clean(qweatherKey || env?.COACH_QWEATHER_KEY || readKeyFile(dataDir)).slice(0, 200)
    const host = normalizeHost(qweatherHost || env?.COACH_QWEATHER_HOST || readHostFile(dataDir))
    out.weather = await loadWeather({ cache, now, fetchImpl, geo: out.geo, qweatherKey: key, qweatherHost: host })
    if (!out.weather) cache.weatherFailAt = iso(now)
  } else if (sameWeatherKey && staleButUsable(cache.weather, 6 * 3600 * 1000, now)) {
    out.weather = cache.weather.data
  }
  if (!recentFailure('newsFailAt', 15 * 60 * 1000)) {
    out.news = await loadNews({
      cache, now, fetchImpl,
      sources: newsSources || env?.COACH_NEWS_SOURCES || null,
    })
    if (!out.news) cache.newsFailAt = iso(now)
  }
  writeCache(dataDir, cache)
  return out
}
