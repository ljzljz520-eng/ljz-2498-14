import { fingerprintAnchor } from './ids.js'

export const THREAD_EVENTS = Object.freeze({
  CREATED: 'thread.created',
  REPLIED: 'thread.replied',
  RESOLVED: 'thread.resolved',
  REOPENED: 'thread.reopened',
  REVIEW_REQUESTED: 'thread.review_requested',
  ANCHOR_MIGRATED: 'thread.anchor_migrated',
  ANCHOR_DANGLING: 'thread.anchor_dangling',
  ANCHOR_REANCHORED: 'thread.anchor_reanchored',
  STATUS_CONFLICT: 'thread.status_conflict'
})

export function reduceThreadEvent(thread, event) {
  const base = thread || {
    id: event.threadId,
    events: []
  }
  const next = {
    ...base,
    events: base.events.filter((item) => {
      if (item.id === event.id) return false
      if (event.clientEventId && item.clientEventId === event.clientEventId) return false
      return true
    }).concat(event)
  }

  switch (event.type) {
    case THREAD_EVENTS.CREATED: {
      next.documentId = event.documentId
      next.anchor = event.payload.anchor
      next.quote = event.payload.quote || event.payload.anchor?.quote
      next.status = 'open'
      next.createdAt = event.createdAt
      next.createdBy = event.actor
      next.resolution = null
      next.previousResolution = null
      break
    }
    case THREAD_EVENTS.REPLIED:
      break
    case THREAD_EVENTS.RESOLVED: {
      next.previousResolution = next.resolution || null
      next.resolution = {
        id: event.payload.resolutionId,
        actor: event.actor,
        at: event.createdAt,
        note: event.payload.note || '',
        anchorFingerprint: event.payload.anchorFingerprint || fingerprintAnchor(next.anchor),
        quote: event.payload.quote || next.anchor?.quote
      }
      if (next.status !== 'dangling') next.status = 'resolved'
      break
    }
    case THREAD_EVENTS.REOPENED:
      next.status = 'open'
      next.reopenReason = event.payload.reason || ''
      break
    case THREAD_EVENTS.REVIEW_REQUESTED:
      next.previousResolution = next.resolution || next.previousResolution
      // Do not delete the old conclusion; resolution remains historical evidence.
      next.status = 'open'
      next.reviewRequest = { actor: event.actor, at: event.createdAt, reason: event.payload.reason || '' }
      break
    case THREAD_EVENTS.ANCHOR_MIGRATED: {
      const anchorBeforeMigration = next.anchor
      next.originalAnchor = next.originalAnchor || next.anchor
      next.anchor = event.payload.anchor
      next.anchorMigratedAt = event.createdAt
      next.candidates = event.payload.candidates || next.candidates || []
      next.migration = {
        source: event.payload.source,
        confidence: event.payload.confidence,
        note: event.payload.note
      }
      const boundFingerprint = next.resolution?.anchorFingerprint || fingerprintAnchor(anchorBeforeMigration)
      if (next.resolution && boundFingerprint !== fingerprintAnchor(next.anchor)) {
        next.anchorChangedSinceResolution = true
        next.status = 'open'
      }
      break
    }
    case THREAD_EVENTS.ANCHOR_DANGLING:
      next.originalAnchor = next.originalAnchor || next.anchor
      next.danglingPreviousStatus = next.status
      next.status = 'dangling'
      next.candidates = event.payload.candidates || []
      next.danglingReason = event.payload.reason
      break
    case THREAD_EVENTS.STATUS_CONFLICT:
      next.anchorState = next.status === 'dangling' ? 'dangling' : 'anchored'
      next.status = 'status-conflict'
      next.statusConflict = event.payload
      break
    case THREAD_EVENTS.ANCHOR_REANCHORED: {
      const anchorBeforeMigration = next.anchor
      next.originalAnchor = next.originalAnchor || next.anchor
      next.anchor = event.payload.anchor
      next.anchorMigratedAt = event.createdAt
      next.candidates = []
      next.danglingReason = null
      next.status = event.payload.restoreStatus || next.danglingPreviousStatus || 'open'
      const boundFingerprint = next.resolution?.anchorFingerprint || fingerprintAnchor(anchorBeforeMigration)
      if (next.resolution && boundFingerprint !== fingerprintAnchor(next.anchor)) {
        next.anchorChangedSinceResolution = true
        next.status = 'open'
      }
      break
    }
  }
  next.events.sort(compareEvents)
  return next
}

const eventTypeRank = {
  [THREAD_EVENTS.CREATED]: 0,
  [THREAD_EVENTS.REPLIED]: 1,
  [THREAD_EVENTS.RESOLVED]: 2,
  [THREAD_EVENTS.REOPENED]: 3,
  [THREAD_EVENTS.REVIEW_REQUESTED]: 4,
  [THREAD_EVENTS.ANCHOR_MIGRATED]: 5,
  [THREAD_EVENTS.ANCHOR_DANGLING]: 6,
  [THREAD_EVENTS.ANCHOR_REANCHORED]: 7,
  [THREAD_EVENTS.STATUS_CONFLICT]: 8
}

export function compareEvents(a, b) {
  return (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER)
    || new Date(a.createdAt) - new Date(b.createdAt)
    || (eventTypeRank[a.type] ?? 9) - (eventTypeRank[b.type] ?? 9)
    || a.id.localeCompare(b.id)
}

export function projectThreads(events) {
  const map = new Map()
  for (const event of [...events].sort(compareEvents)) {
    map.set(event.threadId, reduceThreadEvent(map.get(event.threadId), event))
  }
  return [...map.values()]
}

export function mergeEvents(...groups) {
  const byKey = new Map()
  for (const event of groups.flat()) {
    const key = event.id || event.clientEventId
    const previous = byKey.get(key)
    if (!previous || compareEvents(event, previous) < 0) byKey.set(key, event)
  }
  return [...byKey.values()].sort(compareEvents)
}
