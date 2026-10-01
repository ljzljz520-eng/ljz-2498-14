import { relocateAnchor } from './diff.js'
import { THREAD_EVENTS, mergeEvents, projectThreads } from './events.js'
import { fingerprintAnchor, uniqueId } from './ids.js'

function lcsPairs(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const pairs = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

// Three-way line merge for an offline revision graph:
// base -> local and base -> remote.  Disjoint edits merge automatically;
// overlapping edits are reported and the remote revision is selected by policy
// while retaining both sides in conflicts for the UI.
export function merge3(baseText, localText, remoteText) {
  const base = baseText.split('\n')
  const local = localText.split('\n')
  const remote = remoteText.split('\n')
  const localPairs = new Map(lcsPairs(base, local))
  const remotePairs = new Map(lcsPairs(base, remote))
  const stable = []
  for (const [baseIndex, localIndex] of localPairs) {
    if (remotePairs.has(baseIndex)) stable.push([baseIndex, localIndex, remotePairs.get(baseIndex)])
  }
  stable.sort((a, b) => a[0] - b[0])

  const merged = []
  const conflicts = []
  let bp = 0
  let lp = 0
  let rp = 0
  for (const [b, l, r] of stable.concat([[base.length, local.length, remote.length]])) {
    const baseRegion = base.slice(bp, b)
    const localRegion = local.slice(lp, l)
    const remoteRegion = remote.slice(rp, r)

    if (sameLines(localRegion, baseRegion) && sameLines(remoteRegion, baseRegion)) {
      merged.push(...baseRegion)
    } else if (sameLines(localRegion, baseRegion)) {
      merged.push(...remoteRegion)
    } else if (sameLines(remoteRegion, baseRegion)) {
      merged.push(...localRegion)
    } else if (sameLines(localRegion, remoteRegion)) {
      merged.push(...localRegion)
    } else {
      conflicts.push({
        baseStartLine: bp,
        baseEndLine: b,
        base: baseRegion.join('\n'),
        local: localRegion.join('\n'),
        remote: remoteRegion.join('\n'),
        resolution: 'remote-selected-local-retained'
      })
      // Deterministic server policy; a reviewer can later replace the block.
      merged.push(...remoteRegion)
    }

    if (b < base.length) merged.push(base[b])
    bp = b + 1
    lp = l + 1
    rp = r + 1
  }

  return { text: merged.join('\n'), conflicts }
}

function sameLines(a, b) {
  return a.length === b.length && a.every((line, index) => line === b[index])
}

const generatedAnchorTypes = new Set([
  THREAD_EVENTS.ANCHOR_MIGRATED,
  THREAD_EVENTS.ANCHOR_DANGLING,
  THREAD_EVENTS.ANCHOR_REANCHORED,
  THREAD_EVENTS.STATUS_CONFLICT
])

function createBoundaryEvent(threadId, type, payload, revision, options) {
  const now = options.now?.() || new Date().toISOString()
  return {
    id: options.createId ? options.createId('evt') : uniqueId('evt'),
    documentId: options.documentId,
    threadId,
    type,
    actor: 'system',
    createdAt: now,
    seq: null,
    provisional: false,
    revision,
    payload: { ...payload, provisional: false }
  }
}

function latestCreated(events, id) {
  return [...events].reverse().find((event) => event.threadId === id && event.type === THREAD_EVENTS.CREATED)
}

function statusConflict(localEvents, remoteEvents) {
  const localResolve = localEvents.some((event) => event.type === THREAD_EVENTS.RESOLVED)
  const localReopen = localEvents.some((event) => event.type === THREAD_EVENTS.REOPENED)
  const remoteResolve = remoteEvents.some((event) => event.type === THREAD_EVENTS.RESOLVED)
  const remoteReopen = remoteEvents.some((event) => event.type === THREAD_EVENTS.REOPENED)
  const resolved = localEvents.find((event) => event.type === THREAD_EVENTS.RESOLVED)
    || remoteEvents.find((event) => event.type === THREAD_EVENTS.RESOLVED)
  const reopened = localEvents.find((event) => event.type === THREAD_EVENTS.REOPENED)
    || remoteEvents.find((event) => event.type === THREAD_EVENTS.REOPENED)
  return (localResolve && remoteReopen) || (localReopen && remoteResolve)
    ? { resolutionPolicy: 'open-until-acknowledged', resolved, reopened }
    : null
}

// Merge an offline branch into a server head.  Thread events are append-only.
// Anchor events generated on the provisional branch are discarded and recalculated
// from the three-way-merged text, preventing a stale client from forcing a range.
export function syncMerge(snapshot, localBranch, remoteHead, options = {}) {
  const mergedDoc = merge3(snapshot.text, localBranch.text, remoteHead.text)
  const localEvents = localBranch.events.filter((event) => event.provisional)
  const remoteEvents = remoteHead.events.filter((event) => !event.provisional && !snapshot.events.some((base) => base.id === event.id || base.clientEventId === event.clientEventId))

  const userEvents = mergeEvents(
    snapshot.events,
    remoteEvents,
    localEvents.filter((event) => !generatedAnchorTypes.has(event.type))
  )

  const localCreatedIds = new Set(localEvents
    .filter((event) => event.type === THREAD_EVENTS.CREATED)
    .map((event) => event.threadId))
  const remoteCreatedIds = new Set(remoteEvents
    .filter((event) => event.type === THREAD_EVENTS.CREATED)
    .map((event) => event.threadId))

  const threads = projectThreads(userEvents)
  const boundary = []
  const replaceCreated = new Map()

  for (const thread of threads) {
    let baselineText = snapshot.text
    let originalAnchor = thread.anchor
    let isNew = false
    if (localCreatedIds.has(thread.id)) {
      baselineText = localBranch.text
      isNew = true
    } else if (remoteCreatedIds.has(thread.id)) {
      baselineText = remoteHead.text
      isNew = true
    }
    if (!originalAnchor) continue

    const result = relocateAnchor(originalAnchor, baselineText, mergedDoc.text)
    const accepted = result.status === 'anchored' ? result.anchor : null
    if (isNew) {
      const created = latestCreated(userEvents, thread.id)
      const canonical = {
        ...created,
        id: options.createId ? options.createId('evt') : created.id,
        seq: null,
        provisional: false,
        revision: remoteHead.revision + 1,
        payload: {
          ...created.payload,
          anchor: accepted || { ...created.payload.anchor, baselineRevision: remoteHead.revision + 1 },
          provisional: false
        }
      }
      replaceCreated.set(created.clientEventId || created.id, canonical)
      boundary.push(canonical)
      if (!accepted) {
        boundary.push(createBoundaryEvent(thread.id, THREAD_EVENTS.ANCHOR_DANGLING, {
          reason: result.reason,
          candidates: result.candidates
        }, remoteHead.revision + 1, options))
      }
    } else if (accepted) {
      boundary.push(createBoundaryEvent(thread.id, THREAD_EVENTS.ANCHOR_MIGRATED, {
        anchor: accepted,
        confidence: accepted ? result.candidates[0]?.confidence : 0,
        source: result.candidates[0]?.source,
        note: result.reason,
        candidates: result.candidates,
        fromRevision: thread.anchor.baselineRevision,
        toRevision: remoteHead.revision + 1
      }, remoteHead.revision + 1, options))
    } else {
      boundary.push(createBoundaryEvent(thread.id, THREAD_EVENTS.ANCHOR_DANGLING, {
        reason: result.reason,
        candidates: result.candidates,
        fromRevision: thread.anchor.baselineRevision,
        toRevision: remoteHead.revision + 1
      }, remoteHead.revision + 1, options))
    }

    const conflict = statusConflict(
      localEvents.filter((event) => event.threadId === thread.id),
      remoteEvents.filter((event) => event.threadId === thread.id)
    )
    if (conflict) {
      boundary.push(createBoundaryEvent(thread.id, THREAD_EVENTS.STATUS_CONFLICT, {
        resolutionPolicy: conflict.resolutionPolicy,
        resolvedEventId: conflict.resolved?.id,
        reopenedEventId: conflict.reopened?.id,
        resolvedAt: conflict.resolved?.createdAt,
        reopenedAt: conflict.reopened?.createdAt,
        note: '同一线程被一方解决、另一方重开；保持打开并等待人工确认。'
      }, remoteHead.revision + 1, options))
    }
  }

  const canonicalUserEvents = userEvents.map((event) => {
    const key = event.clientEventId || event.id
    return replaceCreated.get(key) || event
  })
  const canonicalEvents = mergeEvents(canonicalUserEvents, boundary)
  let seq = 0
  for (const event of canonicalEvents) {
    seq += 1
    event.seq = seq
  }

  return {
    text: mergedDoc.text,
    revision: remoteHead.revision + 1,
    parentRevision: remoteHead.revision,
    mergedFrom: { base: snapshot.revision, local: localBranch.revision, remote: remoteHead.revision },
    conflicts: mergedDoc.conflicts,
    events: canonicalEvents
  }
}

export { fingerprintAnchor }
