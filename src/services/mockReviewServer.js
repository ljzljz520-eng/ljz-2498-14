import { makeId, contentHash } from '../utils/text.js'
import { createClock, mergeClock, tick, topoSortEvents, compareClocks } from '../utils/vectorClock.js'
import { diff3Merge } from '../utils/diff.js'
import { describeAnchor, relocateAnchor, chooseCandidate } from '../utils/anchors.js'

const STORAGE_KEY = 'catalpa-review-demo-v1'

function now() {
  return new Date().toISOString()
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function initialState() {
  return {
    document: {
      version: 1,
      source: '',
      contentHash: contentHash(''),
      updatedAt: now(),
    },
    versions: [{ version: 1, source: '', contentHash: contentHash(''), createdAt: now() }],
    threads: [],
    events: [],
    serverClock: createClock('server', 1),
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return { ...initialState(), ...parsed }
  } catch {
    return null
  }
}

class ReviewServer {
  constructor() {
    this.state = load() || initialState()
    this.listeners = new Set()
  }

  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    for (const listener of this.listeners) listener(this.getSnapshot())
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  reset(source = '') {
    this.state = initialState()
    this.state.document = { version: 1, source, contentHash: contentHash(source), updatedAt: now() }
    this.state.versions = [{ version: 1, source, contentHash: contentHash(source), createdAt: now() }]
    this.save()
    return this.getSnapshot()
  }

  getSnapshot() {
    return clone({
      document: this.state.document,
      threads: this.state.threads.map((thread) => this.decorateThread(thread)),
      events: this.state.threads.flatMap((thread) => thread.events),
    })
  }

  getSource(version = this.state.document.version) {
    const found = this.state.versions.find((item) => item.version === version)
    return found?.source ?? this.state.document.source
  }

  decorateThread(thread) {
    const ordered = topoSortEvents(thread.events)
    let status = 'open'
    let reviewGeneration = 0
    let resolvedContentHash = null
    let hasUnresolvedStatusConflict = false
    for (const event of ordered) {
      if (event.type === 'thread.created') {
        status = 'open'
        reviewGeneration = 1
      }
      if (event.type === 'thread.resolved') {
        status = 'resolved'
        resolvedContentHash = event.payload.contentHash
      }
      if (event.type === 'thread.reopened') {
        status = 'open'
        reviewGeneration += 1
        resolvedContentHash = null
      }
      if (event.type === 'review.requested') {
        status = 'open'
        reviewGeneration += 1
      }
      if (event.type === 'anchor.detached') status = 'detached'
      if (event.type === 'anchor.migrated' && status === 'detached') status = 'open'
      if (event.type === 'anchor.candidate' && ['open', 'resolved', 'needs_review'].includes(status)) status = 'candidate'
      if (event.type === 'thread.concurrent-conflict' && status !== 'detached') {
        status = 'conflict'
        hasUnresolvedStatusConflict = true
      }
    }

    if (hasUnresolvedStatusConflict && status !== 'detached') {
      status = 'conflict'
    }

    // A resolved conclusion is tied to the reviewed content hash. A rewritten
    // target asks for another review but never removes the historical result.
    if (status === 'resolved' && resolvedContentHash) {
      const currentQuoteHash = thread.anchor?.quote?.hash
      if (currentQuoteHash && currentQuoteHash !== resolvedContentHash) {
        status = 'needs_review'
      }
    }

    return {
      ...clone(thread),
      status,
      reviewGeneration,
      resolvedContentHash,
      events: ordered,
    }
  }

  addEvent(threadId, type, payload = {}, options = {}) {
    const thread = this.state.threads.find((item) => item.threadId === threadId)
    if (!thread) throw new Error('审阅线程不存在')
    const actorId = options.actorId || payload.actorId || 'user-1'
    const clock = options.clock || tick(
      options.baseClock ? mergeClock(this.state.serverClock, options.baseClock) : mergeClock(this.state.serverClock, thread.clock || {}),
      actorId,
    )

    if (type === 'thread.resolved' || type === 'thread.reopened') {
      const concurrent = thread.events.some((event) =>
        (event.type === 'thread.resolved' || event.type === 'thread.reopened') &&
        compareClocks(event.clock, clock) === 'concurrent')
      if (concurrent) {
        this.appendEvent(thread, {
          type: 'thread.concurrent-conflict',
          actorId: 'system',
          conflictingType: type,
          reason: '解决与重开并发发生，历史均保留并要求人工裁决',
        }, tick(clock, 'system'), false)
      }
    }

    const event = this.appendEvent(thread, { ...payload, actorId, type }, clock, false)
    this.applyThreadSideEffect(thread, event)
    this.save()
    return { event, thread: this.decorateThread(thread) }
  }

  appendEvent(thread, eventInput, clock, mutateGlobalClock = true) {
    const { type, ...payload } = eventInput
    const event = {
      eventId: makeId('evt'),
      threadId: thread.threadId,
      type,
      actorId: payload.actorId || 'user-1',
      body: payload.body || '',
      payload,
      clock,
      createdAt: now(),
    }
    thread.events.push(event)
    thread.clock = mergeClock(thread.clock || {}, clock)
    if (mutateGlobalClock) this.state.serverClock = mergeClock(this.state.serverClock, clock)
    this.state.events.push(event)
    return event
  }

  applyThreadSideEffect(thread, event) {
    if (event.type === 'thread.created') {
      thread.anchor = payloadAnchor(event)
    }
    if (event.type === 'anchor.migrated') {
      thread.anchor = event.payload.nextAnchor
      thread.pendingRelocation = null
    }
    if (event.type === 'anchor.candidate') {
      thread.pendingRelocation = event.payload.relocation
    }
    if (event.type === 'anchor.attached') {
      thread.anchor = event.payload.nextAnchor
      thread.pendingRelocation = null
    }
    if (event.type === 'anchor.detached') {
      thread.detachment = event.payload
    }
    // The resolved hash is carried by the resolve event, not by the mutable
    // anchor. Migration must not erase which reviewed content was concluded.
    if (event.type === 'thread.resolved') {
      thread.resolvedContentHash = event.payload.contentHash
    }
    if (event.type === 'thread.reopened' || event.type === 'review.requested') {
      thread.resolvedContentHash = null
    }
  }

  createThread({ sourceRange, body, actorId = 'user-1', baseVersion, baseClock, sourceOverride }) {
    const version = baseVersion ?? this.state.document.version
    const source = sourceOverride ?? this.getSource(version)
    const anchor = describeAnchor(source, sourceRange, version)
    const threadId = makeId('thread')
    const thread = {
      threadId,
      createdAt: now(),
      createdBy: actorId,
      anchor,
      pendingRelocation: null,
      detachment: null,
      clock: {},
      events: [],
    }
    this.state.threads.push(thread)
    const clock = tick(mergeClock(this.state.serverClock, baseClock || {}), actorId)
    const event = this.appendEvent(thread, {
      type: 'thread.created',
      body,
      actorId,
      anchor,
      documentVersion: version,
    }, clock)
    this.save()
    return { event, thread: this.decorateThread(thread) }
  }

  commitDocument({ source, actorId = 'user-1', baseVersion, baseClock, mode = 'online' }) {
    const currentVersion = this.state.document.version
    const currentSource = this.state.document.source
    const base = baseVersion ?? currentVersion
    let mergedSource = source
    let mergeReport = null

    if (base < currentVersion) {
      const baseSource = this.getSource(base)
      const result = diff3Merge(baseSource, source, currentSource)
      mergedSource = result.text
      mergeReport = {
        hasConflicts: result.hasConflicts,
        conflicts: result.conflicts,
        baseVersion: base,
        remoteVersion: currentVersion,
      }
      if (result.hasConflicts) {
        // Keep the conflict-marked text but do not auto-migrate until resolved.
        this.saveVersion(mergedSource, actorId, 'offline-conflict', mergeReport)
        return { ...this.finishCommit(mergedSource, actorId, baseClock, mergeReport), mergeReport }
      }
    }

    if (mergedSource === currentSource) {
      return this.getSnapshot()
    }

    this.saveVersion(mergedSource, actorId, mode, mergeReport)
    return this.finishCommit(mergedSource, actorId, baseClock, mergeReport)
  }

  saveVersion(source, actorId, mode, mergeReport) {
    const version = this.state.document.version + 1
    const record = {
      version,
      source,
      contentHash: contentHash(source),
      createdAt: now(),
      createdBy: actorId,
      mode,
      mergeReport,
    }
    this.state.versions.push(record)
    this.state.document = {
      version,
      source,
      contentHash: record.contentHash,
      updatedAt: record.createdAt,
    }
  }

  finishCommit(source, actorId, baseClock, mergeReport) {
    const newVersion = this.state.document.version
    this.state.serverClock = tick(mergeClock(this.state.serverClock, baseClock || {}), 'server')
    for (const thread of this.state.threads) {
      if (!thread.anchor) continue
      const oldVersion = thread.anchor.documentVersion
      if (oldVersion === newVersion) continue
      const oldSource = this.getSource(oldVersion)
      const relocation = relocateAnchor({
        anchor: thread.anchor,
        oldSource,
        newSource: source,
        targetVersion: newVersion,
      })
      if (thread.pendingRelocation && relocation.status !== 'detached') {
        this.appendEvent(thread, {
          type: 'anchor.candidate',
          actorId: 'system',
          fromVersion: oldVersion,
          toVersion: newVersion,
          relocation,
          supersedes: thread.pendingRelocation.targetVersion,
          mergeReport,
        }, tick(mergeClock(this.state.serverClock, thread.clock), 'system'))
      } else if (thread.pendingRelocation && relocation.status === 'detached') {
        this.appendEvent(thread, {
          type: 'anchor.detached',
          actorId: 'system',
          fromVersion: oldVersion,
          toVersion: newVersion,
          reason: relocation.reason,
          supersedes: thread.pendingRelocation.targetVersion,
          manualOnly: true,
        }, tick(mergeClock(this.state.serverClock, thread.clock), 'system'))
      } else if (relocation.status === 'anchored') {
        const nextAnchor = {
          ...chooseCandidate(thread.anchor, relocation.chosen, newVersion),
          baseline: thread.anchor.baseline,
        }
        this.appendEvent(thread, {
          type: 'anchor.migrated',
          actorId: 'system',
          fromVersion: oldVersion,
          toVersion: newVersion,
          source: relocation.chosen.source,
          confidence: relocation.chosen.confidence,
          reasons: relocation.chosen.reasons,
          candidates: relocation.candidates,
          nextAnchor,
          mergeReport,
        }, tick(mergeClock(this.state.serverClock, thread.clock), 'system'))
      } else if (relocation.status === 'candidate') {
        this.appendEvent(thread, {
          type: 'anchor.candidate',
          actorId: 'system',
          fromVersion: oldVersion,
          toVersion: newVersion,
          relocation,
          mergeReport,
        }, tick(mergeClock(this.state.serverClock, thread.clock), 'system'))
      } else {
        this.appendEvent(thread, {
          type: 'anchor.detached',
          actorId: 'system',
          fromVersion: oldVersion,
          toVersion: newVersion,
          reason: relocation.reason,
          manualOnly: true,
        }, tick(mergeClock(this.state.serverClock, thread.clock), 'system'))
      }
      this.applyThreadSideEffect(thread, thread.events[thread.events.length - 1])
    }
    this.save()
    return this.getSnapshot()
  }

  acceptCandidate(threadId, candidateId, actorId = 'user-1') {
    const thread = this.state.threads.find((item) => item.threadId === threadId)
    const pending = thread?.pendingRelocation
    const candidate = pending?.candidates?.find((item) => `${item.sourceRange.start}-${item.sourceRange.end}` === candidateId)
    if (!candidate) throw new Error('候选定位不存在或已失效')
    const nextAnchor = chooseCandidate(thread.anchor, candidate, pending.targetVersion)
    const result = this.addEvent(threadId, 'anchor.attached', {
      actorId,
      candidate,
      nextAnchor,
      reason: '人工确认候选定位',
    }, { actorId })
    return result.thread
  }

  rejectCandidates(threadId, reason, actorId = 'user-1') {
    const result = this.addEvent(threadId, 'anchor.detached', {
      actorId,
      reason,
      detachAnchor: false,
      manualOnly: true,
    }, { actorId })
    return result.thread
  }

  requestReview(threadId, body, actorId = 'user-1') {
    const thread = this.state.threads.find((item) => item.threadId === threadId)
    const hash = thread.anchor?.quote?.hash || null
    return this.addEvent(threadId, 'review.requested', {
      actorId,
      body,
      previousContentHash: hash,
      reason: '原句已重写，发起新一代审阅；旧结论保留',
    }, { actorId }).thread
  }

  resolveThread(threadId, body = '已处理', actorId = 'user-1', options = {}) {
    const thread = this.state.threads.find((item) => item.threadId === threadId)
    const hash = thread.anchor?.quote?.hash || null
    return this.addEvent(threadId, 'thread.resolved', { actorId, body, contentHash: hash }, { actorId, ...options }).thread
  }

  reopenThread(threadId, body = '需要继续处理', actorId = 'user-1', options = {}) {
    return this.addEvent(threadId, 'thread.reopened', { actorId, body }, { actorId, ...options }).thread
  }

  reply(threadId, body, actorId = 'user-1', options = {}) {
    return this.addEvent(threadId, 'thread.reply', { actorId, body }, { actorId, ...options }).thread
  }
}

function payloadAnchor(event) {
  return clone(event.payload.anchor)
}

// The event payload is the server response contract. Old clients that only
// understand sourceRange must not render an anchor whose anchor_epoch changed.
export function legacyPayloadGuard(thread, clientAnchorEpoch = 1) {
  if (clientAnchorEpoch >= 2) return { ok: true }
  const migrated = thread.events.some((event) => ['anchor.migrated', 'anchor.candidate', 'anchor.attached'].includes(event.type))
  if (!migrated) return { ok: true }
  return {
    ok: false,
    reason: '旧客户端不理解候选来源/置信度与锚点代次，隐藏批注以避免重新锚到过期位置',
    requiredEpoch: 2,
  }
}

export const reviewServer = new ReviewServer()
