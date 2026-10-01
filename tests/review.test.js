import test from 'node:test'
import assert from 'node:assert/strict'
import { buildVisibleState } from '../src/utils/catalpaModel.js'
import { describeAnchor, relocateAnchor } from '../src/utils/anchors.js'
import { diff3Merge } from '../src/utils/diff.js'

function rangeForQuote(source, quote) {
  const start = source.indexOf(quote)
  assert.notEqual(start, -1)
  return { start, end: start + quote.length }
}

test('锚点保存源范围、拆分节点范围、文本上下文与基线', () => {
  const source = '# 标题\n\n- 第一项\n- 第二项\n'
  const anchor = describeAnchor(source, rangeForQuote(source, '第一项'), 1)
  assert.deepEqual(anchor.sourceRange, rangeForQuote(source, '第一项'))
  assert.equal(anchor.nodeRanges.length, 1)
  assert.match(anchor.nodeRanges[0].nodeId, /^listItem-/)
  assert.equal(anchor.quote.exact, '第一项')
  assert.equal(anchor.context.before, '标题')
  assert.equal(anchor.baseline.documentVersion, 1)
  assert.equal(anchor.anchorFormat, 2)
})

test('整段移动由版本差异自动迁移，并给出 block-move 来源', () => {
  const oldSource = '# T\n\n移动段落需要保持批注。\n\n其他内容\n'
  const anchor = describeAnchor(oldSource, rangeForQuote(oldSource, '移动段落需要保持批注。'), 1)
  const newSource = '# T\n\n其他内容\n\n移动段落需要保持批注。\n'
  const result = relocateAnchor({ anchor, oldSource, newSource, targetVersion: 2 })
  assert.equal(result.status, 'anchored')
  assert.ok(['block-move', 'version-diff-exact'].includes(result.chosen.source))
  assert.ok(result.chosen.confidence >= 0.9)
  assert.equal(newSource.slice(result.chosen.sourceRange.start, result.chosen.sourceRange.end), '移动段落需要保持批注。')
})

test('同一引文复制到多处时生成候选而不是盲目迁移', () => {
  const oldSource = '唯一位置：重复句子。\n'
  const anchor = describeAnchor(oldSource, rangeForQuote(oldSource, '重复句子。'), 1)
  const newSource = '唯一位置：重复句子。\n\n复制位置：重复句子。\n'
  const result = relocateAnchor({ anchor, oldSource, newSource, targetVersion: 2 })
  assert.equal(result.status, 'candidate')
  assert.ok(result.candidates.length >= 2)
  for (const candidate of result.candidates) {
    assert.ok(candidate.confidence > 0)
    assert.ok(candidate.reasons.length > 0)
    assert.ok(candidate.source.length > 0)
  }
})

test('选区被删除时保持悬挂线程，不用相似句替代', () => {
  const oldSource = '前面内容。\n\n这段会被删除。\n\n后面内容。\n'
  const anchor = describeAnchor(oldSource, rangeForQuote(oldSource, '这段会被删除。'), 1)
  const newSource = '前面内容。\n\n后面内容。\n'
  const result = relocateAnchor({ anchor, oldSource, newSource, targetVersion: 2 })
  assert.equal(result.status, 'detached')
  assert.deepEqual(result.candidates, [])
})

test('编辑后选区跨越拆分的多个节点仍可基于版本差异定位', () => {
  const oldSource = '作者保留这段连续文字用于审阅。\n'
  const anchor = describeAnchor(oldSource, rangeForQuote(oldSource, '这段连续文字'), 1)
  const newSource = '作者保留\n\n# 这段连续文字\n\n用于审阅。\n'
  const result = relocateAnchor({ anchor, oldSource, newSource, targetVersion: 2 })
  assert.equal(result.status, 'anchored')
  const state = buildVisibleState(newSource)
  const visible = state.rangeForSource(result.chosen.sourceRange.start, result.chosen.sourceRange.end)
  assert.equal(state.text.slice(visible.start, visible.end), '这段连续文字')
  assert.ok(result.chosen.nodeRanges.length >= 1)
})

test('原句重写后保留旧解决结论并要求新一代审阅', async () => {
  globalThis.localStorage = {
    data: new Map(),
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null },
    setItem(key, value) { this.data.set(key, value) },
    removeItem(key) { this.data.delete(key) },
    clear() { this.data.clear() },
  }
  const { reviewServer } = await import('../src/services/mockReviewServer.js?fresh=1')
  reviewServer.reset('原句需要审阅。')
  const created = reviewServer.createThread({ sourceRange: rangeForQuote('原句需要审阅。', '原句需要审阅。'), body: 'b', baseVersion: 1 })
  reviewServer.resolveThread(created.thread.threadId, '结论')
  const rewrite = reviewServer.commitDocument({ source: '新句子需要重新审阅。', baseVersion: 1, mode: 'rewrite' })
  const thread = rewrite.threads[0]
  assert.equal(thread.status, 'detached')
  const resolveEvent = thread.events.find((event) => event.type === 'thread.resolved')
  assert.ok(resolveEvent)
  reviewServer.requestReview(thread.threadId, '重新审阅')
  const next = reviewServer.getSnapshot().threads[0]
  assert.equal(next.reviewGeneration, 2)
  assert.ok(next.events.some((event) => event.type === 'review.requested'))
  assert.ok(next.events.some((event) => event.type === 'thread.resolved'))
})

test('离线双方分别编辑可三向合并，重叠修改保留冲突标记', () => {
  const base = '一\n共同段落\n三\n'
  const clean = diff3Merge(base, '一\n本地修改\n三\n', '一\n共同段落\n三\n四\n')
  assert.equal(clean.hasConflicts, false)
  assert.equal(clean.text, '一\n本地修改\n三\n四\n')

  const conflict = diff3Merge(base, '一\n本地修改\n三\n', '一\n远端修改\n三\n')
  assert.equal(conflict.hasConflicts, true)
  assert.match(conflict.text, /<<<<<<< local/)
  assert.match(conflict.text, />>>>>>> remote/)
})

test('离线回复与同时解决、重开的事件历史完整且不互相覆盖', async () => {
  globalThis.localStorage = {
    data: new Map(),
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null },
    setItem(key, value) { this.data.set(key, value) },
    removeItem(key) { this.data.delete(key) },
    clear() { this.data.clear() },
  }
  const { reviewServer } = await import('../src/services/mockReviewServer.js?fresh=2')
  reviewServer.reset('待审阅内容。')
  const created = reviewServer.createThread({ sourceRange: rangeForQuote('待审阅内容。', '待审阅内容。'), body: 'start', baseVersion: 1 })
  const threadId = created.thread.threadId
  const lastClock = created.thread.events.at(-1).clock
  reviewServer.resolveThread(threadId, '远端解决', 'remote', { clock: { ...lastClock, 'remote': (lastClock.remote ?? 0) + 1 } })
  reviewServer.reopenThread(threadId, '离线重开', 'offline', { clock: { ...lastClock, offline: (lastClock.offline ?? 0) + 1 } })
  reviewServer.reply(threadId, '离线补充', 'offline', { baseClock: lastClock })
  const thread = reviewServer.getSnapshot().threads[0]
  assert.ok(thread.events.some((event) => event.type === 'thread.resolved'))
  assert.ok(thread.events.some((event) => event.type === 'thread.reopened'))
  assert.ok(thread.events.some((event) => event.type === 'thread.reply'))
  assert.ok(thread.events.some((event) => event.type === 'thread.concurrent-conflict'))
  assert.equal(thread.status, 'conflict')
})


test('旧前端不得渲染已迁移锚点', async () => {
  globalThis.localStorage = {
    data: new Map(),
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null },
    setItem(key, value) { this.data.set(key, value) },
    removeItem(key) { this.data.delete(key) },
    clear() { this.data.clear() },
  }
  const { reviewServer, legacyPayloadGuard } = await import('../src/services/mockReviewServer.js?fresh=legacy')
  reviewServer.reset('移动这段批注目标。')
  const created = reviewServer.createThread({ sourceRange: rangeForQuote('移动这段批注目标。', '移动这段批注目标。'), body: 'x', baseVersion: 1 })
  reviewServer.commitDocument({ source: '前文。\n\n移动这段批注目标。', baseVersion: 1 })
  const migrated = reviewServer.getSnapshot().threads[0]
  assert.equal(legacyPayloadGuard(migrated, 1).ok, false)
  assert.equal(legacyPayloadGuard(migrated, 2).ok, true)
})
