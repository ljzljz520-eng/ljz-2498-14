import { contentHash, normalizeText, bigramSimilarity } from './text.js'
import { mapOldRangeToNew } from './diff.js'
import { buildVisibleState, sourceRangeFromVisible } from './catalpaModel.js'

function clamp(number, min, max) {
  return Math.min(max, Math.max(min, number))
}

function normalizedIndexMap(text) {
  const entries = []
  let normalizedOffset = 0
  let pendingWhitespace = false
  let started = false
  const chars = Array.from(text)

  for (let originalIndex = 0; originalIndex < chars.length; originalIndex += 1) {
    const char = chars[originalIndex]
    if (/\s/.test(char)) {
      pendingWhitespace = true
      continue
    }
    if (started && pendingWhitespace) {
      entries.push({ original: null, normalized: normalizedOffset, char: ' ' })
      normalizedOffset += 1
    }
    entries.push({ original: originalIndex, normalized: normalizedOffset, char })
    normalizedOffset += 1
    pendingWhitespace = false
    started = true
  }
  return { map: entries, normalized: entries.filter((item) => item.original !== null || true).map((item) => item.char).join('') }
}

function findAllOccurrences(haystack, needle) {
  if (!needle) return []
  const result = []
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    result.push(index)
    index = haystack.indexOf(needle, index + 1)
  }
  return result
}

function toNodeRanges(ranges, sourceStart, sourceEnd) {
  const selected = ranges.filter((range) => range.sourceEnd > sourceStart && range.sourceStart < sourceEnd)
  if (!selected.length) return []
  const groups = new Map()
  for (const range of selected) {
    if (!groups.has(range.blockId)) {
      groups.set(range.blockId, {
        nodeId: range.blockId,
        nodeType: range.type,
        start: range.nodeStart,
        end: range.nodeEnd,
      })
    }
    const group = groups.get(range.blockId)
    group.start = Math.min(group.start, range.nodeStart)
    group.end = Math.max(group.end, range.nodeEnd)
  }
  return [...groups.values()].map((group) => ({
    nodeId: group.nodeId,
    nodeType: group.nodeType,
    start: clamp(Math.round(group.start), 0, Number.MAX_SAFE_INTEGER),
    end: clamp(Math.round(group.end), 0, Number.MAX_SAFE_INTEGER),
  }))
}

export function describeAnchor(source, sourceRange, documentVersion) {
  const state = buildVisibleState(source)
  const visible = state.rangeForSource(sourceRange.start, sourceRange.end)
  if (!visible || visible.end <= visible.start) {
    throw new Error('批注选区必须包含预览中的可见文本')
  }
  const text = state.text.slice(visible.start, visible.end)
  const before = state.text.slice(Math.max(0, visible.start - 48), visible.start)
  const after = state.text.slice(visible.end, Math.min(state.text.length, visible.end + 48))
  return {
    anchorFormat: 2,
    schemaVersion: 1,
    documentVersion,
    sourceRange: { start: sourceRange.start, end: sourceRange.end },
    nodeRanges: toNodeRanges(state.ranges, sourceRange.start, sourceRange.end),
    quote: {
      exact: text,
      normalized: normalizeText(text),
      hash: contentHash(text),
    },
    context: {
      before: before.slice(-48),
      after: after.slice(0, 48),
      beforeHash: contentHash(before),
      afterHash: contentHash(after),
    },
    baseline: {
      documentVersion,
      contentHash: contentHash(source),
    },
    resolvedContentHash: null,
  }
}

function exactQuoteCandidates(newSource, anchor) {
  const state = buildVisibleState(newSource)
  const normalized = normalizedIndexMap(state.text)
  const needle = anchor.quote.normalized
  const positions = findAllOccurrences(normalized.normalized, needle)
  const candidates = []

  for (const normalizedStart of positions) {
    const normalizedEnd = normalizedStart + needle.length
    const used = normalized.map.filter((item) => item.normalized >= normalizedStart && item.normalized < normalizedEnd && item.original !== null)
    if (!used.length) continue
    const visibleStart = used[0].original
    const visibleEnd = used[used.length - 1].original + 1
    const sourceRange = sourceRangeFromVisible(state, visibleStart, visibleEnd)
    if (!sourceRange) continue
    const before = state.text.slice(Math.max(0, visibleStart - 48), visibleStart)
    const after = state.text.slice(visibleEnd, Math.min(state.text.length, visibleEnd + 48))

    let confidence = 0.92
    const reasons = []
    if (before.endsWith(anchor.context.before.slice(-16))) {
      confidence += 0.035
      reasons.push('前文上下文一致')
    }
    if (after.startsWith(anchor.context.after.slice(0, 16))) {
      confidence += 0.035
      reasons.push('后文上下文一致')
    }
    if (contentHash(before) === anchor.context.beforeHash) {
      confidence += 0.01
      reasons.push('完整前文指纹一致')
    }
    if (contentHash(after) === anchor.context.afterHash) {
      confidence += 0.01
      reasons.push('完整后文指纹一致')
    }
    reasons.unshift('引用文本完全匹配')
    candidates.push({
      sourceRange,
      visibleRange: { start: visibleStart, end: visibleEnd },
      nodeRanges: toNodeRanges(state.ranges, sourceRange.start, sourceRange.end),
      quote: state.text.slice(visibleStart, visibleEnd),
      confidence: Math.min(0.99, Number(confidence.toFixed(3))),
      source: 'quote-exact',
      reasons,
    })
  }
  return candidates
}

function fuzzyQuoteCandidates(newSource, anchor) {
  const state = buildVisibleState(newSource)
  const candidates = []
  const anchorLength = anchor.quote.normalized.length

  for (const block of state.blocks) {
    if (!block.text.trim()) continue
    const windows = block.text.length <= anchorLength + 32
      ? [block.text]
      : Array.from({ length: Math.max(1, block.text.length - anchorLength - anchorLength) }, (_, index) =>
          block.text.slice(index, index + anchorLength + 16))
    for (const window of windows) {
      const score = bigramSimilarity(anchor.quote.normalized, window)
      if (score >= 0.72) {
        const sourceStart = block.segments.find((segment) => segment.text.trim())?.start ?? block.start
        const sourceEnd = block.end
        candidates.push({
          sourceRange: { start: sourceStart, end: sourceEnd },
          nodeRanges: toNodeRanges(state.ranges, sourceStart, sourceEnd),
          quote: block.text,
          confidence: Number((0.58 + score * 0.22).toFixed(3)),
          source: 'quote-fuzzy',
          reasons: [`引用文本相似度 ${Math.round(score * 100)}%，需人工确认`],
        })
        break
      }
    }
  }
  return candidates
}

function markMovedBlocks(candidates, oldSource, newSource) {
  const oldState = buildVisibleState(oldSource)
  const newState = buildVisibleState(newSource)
  const oldBySignature = new Map(oldState.blocks.map((block) => [block.signature, block]))
  for (const candidate of candidates) {
    const blockId = candidate.nodeRanges[0]?.nodeId
    const block = newState.blocks.find((item) => item.id === blockId)
    const oldBlock = block && oldBySignature.get(block.signature)
    if (block && oldBlock && block.start !== oldBlock.start) {
      candidate.source = 'block-move'
      candidate.confidence = Math.max(candidate.confidence, 0.98)
      candidate.reasons = ['整段内容指纹一致，位置发生移动', ...candidate.reasons.filter((reason) => !reason.includes('位置'))]
    }
  }
}

function uniqueCandidates(candidates) {
  const map = new Map()
  for (const candidate of candidates) {
    const key = `${candidate.sourceRange.start}:${candidate.sourceRange.end}`
    const existing = map.get(key)
    if (!existing || candidate.confidence > existing.confidence) map.set(key, candidate)
  }
  return [...map.values()].sort((a, b) => b.confidence - a.confidence)
}

function candidateAcceptance(candidates) {
  if (!candidates.length) return 'none'
  if (candidates.length === 1 && candidates[0].confidence >= 0.9) return 'auto'
  if (candidates[0].confidence >= 0.9 && (candidates[1]?.confidence ?? 0) <= candidates[0].confidence - 0.08) return 'auto'
  return 'propose'
}

export function relocateAnchor({ anchor, oldSource, newSource, targetVersion }) {
  const transformed = mapOldRangeToNew(
    oldSource,
    newSource,
    anchor.sourceRange.start,
    anchor.sourceRange.end,
  )

  const candidates = []
  if (transformed && transformed.coverage > 0) {
    const state = buildVisibleState(newSource)
    const visible = state.rangeForSource(transformed.sourceRange.start, transformed.sourceRange.end)
    if (visible && visible.end > visible.start) {
      const quote = state.text.slice(visible.start, visible.end)
      const renderedSourceRange = sourceRangeFromVisible(state, visible.start, visible.end)
      if (renderedSourceRange) {
        const normalizedScore = quote === anchor.quote.exact ? 1 : bigramSimilarity(quote, anchor.quote.normalized)
        const exactTransform = transformed.coverage === 1 && normalizedScore >= 0.98
        const plausibleTransform = transformed.coverage >= 0.85 && normalizedScore >= 0.9
        if (exactTransform || plausibleTransform) {
          candidates.push({
            sourceRange: renderedSourceRange,
            visibleRange: visible,
            nodeRanges: toNodeRanges(state.ranges, renderedSourceRange.start, renderedSourceRange.end),
            quote,
            confidence: Number((exactTransform
              ? Math.min(0.99, 0.88 + normalizedScore * 0.11)
              : Math.min(0.86, 0.65 + transformed.coverage * 0.12 + normalizedScore * 0.08)).toFixed(3)),
            source: exactTransform ? 'version-diff-exact' : 'version-diff-partial',
            reasons: [
              `基于版本差异映射保留 ${Math.round(transformed.coverage * 100)}% 原选区`,
              normalizedScore < 1 ? '选区文本已变化' : '映射后引用文本一致',
            ],
          })
        }
      }
    }
  }

  candidates.push(...exactQuoteCandidates(newSource, anchor))
  candidates.push(...fuzzyQuoteCandidates(newSource, anchor))

  const unique = uniqueCandidates(candidates)
  markMovedBlocks(unique, oldSource, newSource)
  const decision = candidateAcceptance(unique)
  if (decision === 'none') {
    return {
      status: 'detached',
      targetVersion,
      candidates: [],
      chosen: null,
      reason: '版本差异与文本上下文都找不到对应内容，线程保持悬挂',
    }
  }

  const payload = {
    candidates: unique,
    targetVersion,
    reason: decision === 'auto'
      ? `自动接受置信度 ${unique[0].confidence} 的唯一定位`
      : '存在多个或置信度不足的候选，需要人工确认',
  }

  if (decision === 'auto') {
    return {
      status: 'anchored',
      ...payload,
      chosen: unique[0],
    }
  }
  return { status: 'candidate', ...payload, chosen: null }
}

export function chooseCandidate(anchor, candidate, targetVersion) {
  return {
    ...anchor,
    documentVersion: targetVersion,
    sourceRange: candidate.sourceRange,
    nodeRanges: candidate.nodeRanges,
    quote: {
      ...anchor.quote,
      exact: candidate.quote,
      normalized: normalizeText(candidate.quote),
      hash: contentHash(candidate.quote),
    },
  }
}

export function detachAnchorManually(anchor, targetVersion, reason = '人工确认为无法对应') {
  return {
    ...anchor,
    documentVersion: targetVersion,
    detachedManually: true,
    detachmentReason: reason,
  }
}
