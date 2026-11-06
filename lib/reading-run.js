// Reading helpers shared by the `coach_read` tool. The real reading turn runs
// inside a normal agent session (see lib/reading-session.js); this module only
// owns text extraction, position merging and source picking.
const MAX_EXCERPT = 60000
export const READ_OPTIONS = [1000, 3000, 6000]
const NOTE_LIMIT = 300
export const MIN_TEXT = 300
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const BLOCK_TAG = /<\/?(?:p|div|article|section|br|h[1-6]|li|tr|blockquote|pre)\b[^>]*>/gi

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n)
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ''
    })
}

// Navigation/related-link chrome is a run of short lines; the article body is a
// run of long paragraphs. Keep the densest run (allowing a few blank/short lines
// between paragraphs) so a note starts with content, not a site menu.
function densestRun(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  const dense = (line) => line.length >= 25
  let bestStart = 0, bestEnd = lines.length - 1, bestScore = 0
  let start = -1, gap = 0, score = 0
  for (let i = 0; i < lines.length; i += 1) {
    if (dense(lines[i])) {
      if (start < 0 || gap > 3) { start = i; score = 0 }
      gap = 0
      score += lines[i].length
      if (score > bestScore) { bestScore = score; bestStart = start; bestEnd = i }
    } else if (start >= 0) {
      gap += 1
    }
  }
  return bestScore ? lines.slice(bestStart, bestEnd + 1).join('\n') : text
}

// A PDF or other binary decoded as text is a run of control/replacement chars.
// The host fetch rejects declared non-text types; this catches disguised bodies.
export function looksBinary(text) {
  const value = String(text ?? '')
  if (/^\s*%PDF-/.test(value)) return true
  const sample = value.slice(0, 4000)
  if (!sample) return false
  let bad = 0
  for (const ch of sample) {
    const code = ch.codePointAt(0)
    if (code === 0xFFFD || (code < 32 && code !== 9 && code !== 10 && code !== 13)) bad += 1
  }
  return bad > Math.max(20, sample.length * 0.02)
}

export function pageTitle(page) {
  const body = page?.body
  const content = typeof body === 'string' ? body : body?.content
  const raw = String(content ?? '')
  if (!/<title\b/i.test(raw)) return ''
  return clean(decodeEntities(raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')).slice(0, 120)
}

export function readableText(page) {
  const body = page?.body
  const content = typeof body === 'string' ? body : body?.content
  const raw = String(content ?? '').replace(/\r\n?/g, '\n')
  const text = !/<(?:html|body|p|div|article|main)\b/i.test(raw)
    ? decodeEntities(raw)
    : (() => {
      const without = raw
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<(script|style|noscript|template|svg|iframe|form|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
      const preferred = without.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
        ?? without.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
        ?? without.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
        ?? without
      return decodeEntities(preferred.replace(BLOCK_TAG, '\n').replace(/<[^>]+>/g, ' '))
    })()
  const normalized = text
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return densestRun(normalized)
}

// The shelf note is a single 300-char field. Appending keeps continuity; when it
// overflows, drop the oldest part so the newest thought survives intact.
export function mergeReadingNote(previous, next) {
  const joined = [clean(previous), clean(next)].filter(Boolean).join('；')
  return joined.length <= NOTE_LIMIT ? joined : joined.slice(joined.length - NOTE_LIMIT)
}

export function pickContinuation(person) {
  return (person?.library ?? [])
    .filter(item => item.state === 'reading'
      && typeof item.excerpt === 'string' && item.excerpt.trim()
      && (item.readingOffset ?? 0) < item.excerpt.length)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))[0] ?? null
}
