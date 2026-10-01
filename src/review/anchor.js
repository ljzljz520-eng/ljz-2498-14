export const ANCHOR_SCHEMA_VERSION = 2

export function normalizeSelection(start, end, max) {
  const s = Math.max(0, Math.min(max, Math.floor(start)))
  const e = Math.max(0, Math.min(max, Math.floor(end)))
  return { start: Math.min(s, e), end: Math.max(s, e) }
}

function compactText(value) {
  return value.replace(/\s+/g, ' ').trim()
}

function intersectSegments(start, end, blocks) {
  const intersections = []
  for (const block of blocks) {
    for (const segment of block.segments || []) {
      const s = Math.max(start, segment.start)
      const e = Math.min(end, segment.end)
      if (s < e) {
        intersections.push({
          start: s,
          end: e,
          text: segment.text.slice(s - segment.start, e - segment.start),
          block: {
            type: block.type,
            index: block.index,
            path: block.path,
            start: block.start,
            end: block.end
          }
        })
      }
    }
  }
  return intersections
}

export function buildAnchorFromSelection(source, selectionStart, selectionEnd, baselineRevision, blocks) {
  const selection = normalizeSelection(selectionStart, selectionEnd, source.length)
  if (selection.end - selection.start < 1) {
    throw new Error('请先在预览区选中至少一个可见字符')
  }

  const segments = intersectSegments(selection.start, selection.end, blocks)
  if (!segments.length) {
    throw new Error('选区只包含 Markdown 标记或空白，不能创建审阅线程')
  }

  const ranges = []
  const nodeRanges = []
  for (const item of segments) {
    ranges.push({
      start: item.start,
      end: item.end,
      startOffset: item.block.start,
      endOffset: item.block.end,
      text: item.text
    })
    nodeRanges.push({
      nodePath: item.block.path,
      start: item.start - item.block.start,
      end: item.end - item.block.start,
      text: item.text
    })
  }

  const visibleQuote = compactText(segments.map((item) => item.text).join(' '))
  return {
    schemaVersion: ANCHOR_SCHEMA_VERSION,
    baselineRevision,
    ranges,
    quote: visibleQuote,
    context: {
      before: compactText(source.slice(Math.max(0, selection.start - 80), selection.start)),
      after: compactText(source.slice(selection.end, Math.min(source.length, selection.end + 80)))
    },
    // nodeRanges are diagnostic hints only.  They must never be used by an old
    // client as a permanent address after the document changes.
    nodeRanges
  }
}

export class RangeSet {
  constructor(threads = []) {
    this.byStart = new Map()
    this.threads = []
    for (const thread of threads) this.addThread(thread)
  }

  addThread(thread) {
    if (!thread.anchor || thread.status === 'dangling') return
    for (const range of thread.anchor.ranges || []) {
      if (!this.byStart.has(range.start)) this.byStart.set(range.start, [])
      this.byStart.get(range.start).push({ range, thread })
      this.threads.push({ range, thread })
    }
  }

  intersects(start, end) {
    return this.threads.some(({ range }) => range.start < end && range.end > start)
  }

  threadsAt(start, end) {
    return new Map(this.threads
      .filter(({ range }) => range.start < end && range.end > start)
      .map((item) => [item.thread.id, item.thread]))
  }
}

export function threadById(threads, id) {
  return threads.find((thread) => thread.id === id)
}
