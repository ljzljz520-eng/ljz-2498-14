import assert from 'node:assert/strict'
import { relocateAnchor } from '../src/review/diff.js'
import { merge3, syncMerge } from '../src/review/graph.js'
import { THREAD_EVENTS, projectThreads } from '../src/review/events.js'
import { fingerprintAnchor, uniqueId } from '../src/review/ids.js'
import { decodeThreadPayload } from '../src/review/clientGuard.js'

const doc = [
  '标题',
  '',
  '需要精确迁移的关键结论：候选定位必须带来源。',
  '',
  '第二段讨论操作变换与版本差异。',
  '',
  '同一句话也可能在别处重复。'
].join('\n')

function anchorFor(text, quote, baselineRevision = 1) {
  const start = text.indexOf(quote)
  const end = start + quote.length
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const lineEndIndex = text.indexOf('\n', end)
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex
  return {
    schemaVersion: 2,
    baselineRevision,
    ranges: [{ start, end, startOffset: lineStart, endOffset: lineEnd, text: quote }],
    quote,
    context: {
      before: text.slice(Math.max(0, start - 20), start),
      after: text.slice(end, end + 20)
    },
    nodeRanges: [{ nodePath: ['paragraph', 1], start: start - lineStart, end: end - lineStart, text: quote }]
  }
}

function event(type, threadId, payload = {}, revision = 1, provisional = false, actor = 'u') {
  return {
    id: uniqueId('evt'),
    clientEventId: uniqueId('client'),
    documentId: 'doc',
    threadId,
    type,
    actor,
    createdAt: new Date().toISOString(),
    seq: null,
    revision,
    provisional,
    payload
  }
}

function createdThread(anchor, body = '请核对') {
  const threadId = uniqueId('thread')
  return {
    threadId,
    events: [event(THREAD_EVENTS.CREATED, threadId, { anchor, quote: anchor.quote, comment: body }, 1)]
  }
}

function testMovedParagraph() {
  const quote = '第二段讨论操作变换与版本差异。'
  const anchor = anchorFor(doc, quote)
  const lines = doc.split('\n')
  const moved = [lines[0], '', lines[4], '', lines[2], '', lines[6]].join('\n')
  const result = relocateAnchor(anchor, doc, moved)
  assert.equal(result.status, 'anchored')
  assert.ok(result.anchor.ranges[0].start > 0)
  assert.equal(moved.slice(result.anchor.ranges[0].start, result.anchor.ranges[0].end), quote)
  assert.ok(result.candidates[0].confidence >= 0.85)
}

function testRepeatedQuoteNeverAutoMigrates() {
  const quote = '同一句话也可能在别处重复。'
  const anchor = anchorFor(doc, quote)
  const copied = `${quote}\n\n${doc}`
  const result = relocateAnchor(anchor, doc, copied)
  assert.equal(result.status, 'dangling')
  assert.ok(result.candidates.length >= 2)
  assert.ok(result.candidates.every((candidate) => candidate.confidence < 0.85))
  assert.ok(result.candidates.some((candidate) => candidate.source === 'repeated-quoted-text'))
}

function testSelectionDeletedDangles() {
  const quote = '需要精确迁移的关键结论'
  const anchor = anchorFor(doc, quote)
  const next = doc.replace(quote, '')
  const result = relocateAnchor(anchor, doc, next)
  assert.equal(result.status, 'dangling')
  assert.match(result.reason, /deleted|no quotation|候选/i)
}

function testThreeWayDisjointOfflineMerge() {
  const base = 'A\n\nB\n\nC'
  const local = 'A local\n\nB\n\nC'
  const remote = 'A\n\nB remote\n\nC'
  const merged = merge3(base, local, remote)
  assert.equal(merged.text, 'A local\n\nB remote\n\nC')
  assert.equal(merged.conflicts.length, 0)
}

function testOfflineReplyAndResolveReopenConflict() {
  const quote = '第二段讨论操作变换与版本差异。'
  const anchor = anchorFor(doc, quote)
  const { threadId, events } = createdThread(anchor)
  const resolve = event(THREAD_EVENTS.RESOLVED, threadId, {
    anchorFingerprint: fingerprintAnchor(anchor),
    quote
  }, 1, false, 'remote')

  const snapshot = { revision: 1, text: doc, events }
  const localText = doc.replace(quote, '第二段离线补充：我们选择版本差异重定位。')
  const localEvents = events.concat(
    event(THREAD_EVENTS.REPLIED, threadId, { body: '离线回复' }, 2, true, 'local'),
    event(THREAD_EVENTS.REOPENED, threadId, { reason: '需要再看' }, 2, true, 'local')
  )
  const remoteText = doc
  const remoteHead = { revision: 2, text: remoteText, events: events.concat(resolve) }
  const merged = syncMerge(snapshot, { revision: 2, text: localText, events: localEvents }, remoteHead)

  assert.ok(merged.text.includes('第二段离线补充'))
  const threads = projectThreads(merged.events)
  const thread = threads.find((item) => item.id === threadId)
  assert.equal(thread.status, 'status-conflict')
  assert.ok(thread.events.some((item) => item.type === THREAD_EVENTS.REPLIED && item.payload.body === '离线回复'))
  assert.ok(thread.events.some((item) => item.type === THREAD_EVENTS.RESOLVED))
  assert.ok(thread.events.some((item) => item.type === THREAD_EVENTS.REOPENED))
  assert.ok(thread.events.some((item) => item.type === THREAD_EVENTS.STATUS_CONFLICT))
  assert.ok(thread.events.some((item) => item.type === THREAD_EVENTS.ANCHOR_MIGRATED || item.type === THREAD_EVENTS.ANCHOR_DANGLING))
}

function testOldClientCannotReanchorMigratedThread() {
  const payload = {
    id: 't1',
    anchor: { schemaVersion: 2, ranges: [{ start: 1, end: 2 }], quote: 'x' },
    anchorMigratedAt: new Date().toISOString()
  }
  const legacy = {
    ...payload,
    anchor: { schemaVersion: 1, ranges: [{ start: 1, end: 2 }], quote: 'x' }
  }
  const v1 = decodeThreadPayload(legacy, 1)
  assert.equal(v1.ok, false)
  assert.equal(v1.code, 'STALE_CLIENT_PREVENTS_REANCHOR')
  assert.equal(v1.thread.anchor, null)
  assert.equal(decodeThreadPayload(payload, 1).code, 'ANCHOR_SCHEMA_TOO_NEW')
  const v2 = decodeThreadPayload(payload, 2)
  assert.equal(v2.ok, true)
}

function testResolvedThenRewrittenRequestsReviewWithoutDeletingResolution() {
  const quote = '需要精确迁移的关键结论：候选定位必须带来源。'
  const anchor = anchorFor(doc, quote)
  const { threadId, events: createdEvents } = createdThread(anchor)
  const resolved = event(THREAD_EVENTS.RESOLVED, threadId, {
    anchorFingerprint: fingerprintAnchor(anchor),
    quote,
    note: '通过'
  })
  const rewritten = doc.replace(quote, '重写后的关键结论仍需带来源与置信度。')
  const migrated = relocateAnchor(anchor, doc, rewritten)
  // A rewrite is a similar-line hypothesis and must not be silently accepted.
  assert.equal(migrated.status, 'dangling')

  const events = createdEvents.concat(resolved)
  const threads = projectThreads(events)
  const thread = threads[0]
  assert.equal(thread.status, 'resolved')
  assert.ok(thread.resolution.anchorFingerprint)

  const request = event(THREAD_EVENTS.REVIEW_REQUESTED, threadId, { reason: '原句已重写' }, 2, false, 'author')
  const next = projectThreads(events.concat(request)).find((item) => item.id === threadId)
  assert.equal(next.status, 'open')
  assert.ok(next.resolution)
  assert.equal(next.resolution.note, '通过')
}

function testMovedResolvedThreadKeepsConclusionButOpens() {
  const quote = '第二段讨论操作变换与版本差异。'
  const anchor = anchorFor(doc, quote)
  const { threadId, events } = createdThread(anchor)
  const resolved = event(THREAD_EVENTS.RESOLVED, threadId, {
    anchorFingerprint: fingerprintAnchor(anchor),
    quote,
    note: '旧结论'
  })
  const movedLines = doc.split('\n')
  const moved = [movedLines[0], '', movedLines[4], '', movedLines[2], '', movedLines[6]].join('\n')
  const reanchored = relocateAnchor(anchor, doc, moved)
  assert.equal(reanchored.status, 'anchored')
  const migrated = event(THREAD_EVENTS.ANCHOR_MIGRATED, threadId, {
    anchor: reanchored.anchor,
    confidence: reanchored.candidates[0].confidence,
    source: reanchored.candidates[0].source,
    candidates: reanchored.candidates
  }, 2, false, 'system')
  const thread = projectThreads(events.concat(resolved, migrated)).find((item) => item.id === threadId)
  assert.equal(thread.status, 'open')
  assert.equal(thread.anchorChangedSinceResolution, true)
  assert.equal(thread.resolution.note, '旧结论')
  assert.equal(thread.resolution.quote, quote)
}

const tests = [
  testMovedParagraph,
  testRepeatedQuoteNeverAutoMigrates,
  testSelectionDeletedDangles,
  testThreeWayDisjointOfflineMerge,
  testOfflineReplyAndResolveReopenConflict,
  testOldClientCannotReanchorMigratedThread,
  testMovedResolvedThreadKeepsConclusionButOpens,
  testResolvedThenRewrittenRequestsReviewWithoutDeletingResolution
]

for (const test of tests) {
  test()
  console.log(`✓ ${test.name}`)
}
console.log(`${tests.length} tests passed`)
