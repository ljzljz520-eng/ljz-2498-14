import { ANCHOR_SCHEMA_VERSION } from './anchor.js'

export const CLIENT_ANCHOR_SCHEMA = ANCHOR_SCHEMA_VERSION

// A v1 client only knew (nodeId, start, end) and optimistically re-anchored by
// searching the first equal sentence.  After a server-side migration its cached
// thread still has the old coordinates.  The API therefore returns an explicit
// anchor epoch and a stale-client instruction; v1 clients must render a badge
// instead of painting the old range.
export function decodeThreadPayload(payload, clientSchema = CLIENT_ANCHOR_SCHEMA) {
  if (!payload.anchor) return { ok: true, thread: payload }
  const version = payload.anchor.schemaVersion ?? 1

  if (version > clientSchema) {
    return {
      ok: false,
      code: 'ANCHOR_SCHEMA_TOO_NEW',
      thread: {
        ...payload,
        anchor: null,
        status: 'incompatible',
        statusNote: `需要支持批注锚点 v${version}，当前前端为 v${clientSchema}`
      }
    }
  }

  if (payload.anchorMigratedAt && clientSchema < 2) {
    return {
      ok: false,
      code: 'STALE_CLIENT_PREVENTS_REANCHOR',
      thread: {
        ...payload,
        anchor: null,
        status: 'incompatible',
        statusNote: '批注已迁移；旧前端不能使用缓存位置重新锚定'
      }
    }
  }

  return { ok: true, thread: payload }
}

export function decodeThreadPayloads(payloads, clientSchema) {
  return payloads.map((payload) => decodeThreadPayload(payload, clientSchema))
}
