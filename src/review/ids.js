export function hashText(value) {
  let hash = 2166136261
  const input = String(value ?? '')
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function fingerprintAnchor(anchor) {
  if (!anchor) return null
  return hashText([
    anchor.schemaVersion ?? 1,
    (anchor.ranges || []).map((range) => `${range.start}:${range.end}`).join(','),
    anchor.quote || ''
  ].join('|'))
}

export function uniqueId(prefix = 'id') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${random.replace(/-/g, '').slice(0, 20)}`
}
