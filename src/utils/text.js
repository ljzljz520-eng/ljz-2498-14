export function cyrb53(input, seed = 0) {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export function stableHash(value) {
  return cyrb53(String(value ?? '')).toString(16).padStart(14, '0')
}

export function normalizeText(value = '') {
  return value.replace(/\s+/g, ' ').trim()
}

export function makeId(prefix) {
  const random = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}_${random.replace(/-/g, '')}`
}

export function contentHash(text = '') {
  return stableHash(`v1:${normalizeText(text)}`)
}

export function levenshteinRatio(a, b) {
  if (!a && !b) return 1
  if (!a || !b) return 0
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    let previous = dp[0]
    dp[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const current = dp[j]
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      previous = current
    }
  }
  return 1 - dp[b.length] / Math.max(a.length, b.length)
}

export function bigrams(value) {
  const text = normalizeText(value).toLowerCase()
  if (text.length < 2) return new Set(text ? [text] : [])
  const result = new Set()
  for (let i = 0; i < text.length - 1; i += 1) result.add(text.slice(i, i + 2))
  return result
}

export function bigramSimilarity(a, b) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (!left.size || !right.size) return 0
  let overlap = 0
  for (const item of left) if (right.has(item)) overlap += 1
  return overlap / (left.size + right.size - overlap)
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
