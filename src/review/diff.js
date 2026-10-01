// Deterministic text-diff re-anchoring.
//
// We deliberately use a version diff rather than operational transforms for the
// server contract: a revision stores full text + parent revision, and the server
// derives how an old interval changed.  OT is excellent for concurrent cursor
// presence, but requires every editing peer to emit transformable operations;
// paste, Markdown structure changes and offline merges do not naturally expose
// those operations.

export function lineOffsets(text) {
  const offsets = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') offsets.push(i + 1)
  }
  return offsets
}

export function splitLines(text) {
  return text.split('\n')
}

function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

function diffLines(oldLines, newLines) {
  const table = lcsTable(oldLines, newLines)
  const raw = []
  let i = 0
  let j = 0
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      raw.push({ type: 'equal', oldIndex: i, newIndex: j })
      i += 1
      j += 1
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      raw.push({ type: 'delete', oldIndex: i })
      i += 1
    } else {
      raw.push({ type: 'insert', newIndex: j })
      j += 1
    }
  }
  while (i < oldLines.length) raw.push({ type: 'delete', oldIndex: i++ })
  while (j < newLines.length) raw.push({ type: 'insert', newIndex: j++ })

  const ops = []
  for (let k = 0; k < raw.length; k += 1) {
    const item = raw[k]
    if (item.type !== 'delete' && item.type !== 'insert') {
      ops.push(item)
      continue
    }
    const start = k
    const deleted = []
    const inserted = []
    while (k < raw.length && (raw[k].type === 'delete' || raw[k].type === 'insert')) {
      if (raw[k].type === 'delete') deleted.push(raw[k].oldIndex)
      else inserted.push(raw[k].newIndex)
      k += 1
    }
    k -= 1
    if (deleted.length && inserted.length) {
      ops.push({ type: 'replace', oldIndexes: deleted, newIndexes: inserted, start, end: k })
    } else if (deleted.length) {
      ops.push({ type: 'delete', oldIndexes: deleted })
    } else {
      ops.push({ type: 'insert', newIndexes: inserted })
    }
  }
  return ops
}

function counts(values) {
  return values.reduce((acc, value) => acc.set(value, (acc.get(value) || 0) + 1), new Map())
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[a.length][b.length]
}

function similarity(a, b) {
  if (!a.length && !b.length) return 1
  return 1 - editDistance(a, b) / Math.max(a.length, b.length)
}

function commonPrefix(a, b) {
  const max = Math.min(a.length, b.length)
  let n = 0
  while (n < max && a[n] === b[n]) n += 1
  return n
}

function commonSuffix(a, b) {
  let n = 0
  const max = Math.min(a.length, b.length)
  while (n < max && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1
  return n
}

// Each mapping is one hypothesis for a complete old line.  Several mappings may
// exist when identical lines occur in more than one new place.
function buildLineMappings(oldLines, newLines) {
  const ops = diffLines(oldLines, newLines)
  const oldCounts = counts(oldLines)
  const newCounts = counts(newLines)
  const byOld = new Map()
  const add = (oldIndex, newIndex, confidence, source, detail = {}) => {
    if (!byOld.has(oldIndex)) byOld.set(oldIndex, [])
    byOld.get(oldIndex).push({ oldIndex, newIndex, confidence, source, ...detail })
  }

  for (const op of ops) {
    if (op.type === 'equal') {
      // The original location remains a strong structural identity, but if the
      // exact same line was also inserted elsewhere, a copied quotation cannot
      // choose one destination automatically.
      const duplicatedInNew = newCounts.get(oldLines[op.oldIndex]) > 1
      add(
        op.oldIndex,
        op.newIndex,
        duplicatedInNew ? 0.58 : 0.98,
        duplicatedInNew ? 'duplicate-text-match' : 'unchanged-line',
        duplicatedInNew ? { reason: 'identical text also exists in an inserted region' } : {}
      )
      continue
    }
    if (op.type !== 'replace') continue

    const oldInsertedCounts = counts(op.oldIndexes.map((x) => oldLines[x]))
    for (const oldIndex of op.oldIndexes) {
      const oldText = oldLines[oldIndex]
      const sameNew = op.newIndexes.filter((newIndex) => newLines[newIndex] === oldText)
      const globallyUnique = oldCounts.get(oldText) === 1 && newCounts.get(oldText) === 1
      if (sameNew.length === 1 && globallyUnique && oldInsertedCounts.get(oldText) === 1) {
        // A unique paragraph that disappeared here and appears in the changed
        // region is treated as a move only when the line identity is unique.
        add(oldIndex, sameNew[0], 0.88, 'moved-line')
      } else if (sameNew.length > 0) {
        for (const newIndex of sameNew.slice(0, 4)) {
          add(oldIndex, newIndex, 0.54, 'duplicate-text-match', {
            reason: 'identical text occurs in multiple destinations'
          })
        }
      }

      let best = null
      for (const newIndex of op.newIndexes) {
        if (newLines[newIndex] === oldText) continue
        const score = similarity(oldText, newLines[newIndex])
        if (score >= 0.64 && (!best || score > best.score)) best = { newIndex, score }
      }
      if (best) {
        add(oldIndex, best.newIndex, Math.min(0.78, best.score * 0.82), 'similar-line', {
          similarity: Number(best.score.toFixed(3))
        })
      }
    }
  }
  return byOld
}

function mapBoundary(offsetInLine, oldLine, newLine, baseConfidence) {
  if (offsetInLine === 0) return { offset: 0, confidence: baseConfidence }
  if (offsetInLine === oldLine.length) return { offset: newLine.length, confidence: baseConfidence }

  const prefix = commonPrefix(oldLine, newLine)
  const suffix = commonSuffix(oldLine, newLine)
  const oldChangedStart = prefix
  const oldChangedEnd = oldLine.length - suffix
  if (offsetInLine <= oldChangedStart) return { offset: offsetInLine, confidence: baseConfidence }
  if (offsetInLine >= oldChangedEnd) {
    return { offset: newLine.length - (oldLine.length - offsetInLine), confidence: baseConfidence }
  }
  return { offset: null, confidence: Math.min(baseConfidence, 0.35), insideEdit: true }
}

function makeRangeKey(range) {
  return `${range.start}:${range.end}`
}

function textAt(text, start, end) {
  return text.slice(start, end)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findQuoteOccurrences(newText, quote) {
  const normalized = quote.split(/\s+/).filter(Boolean)
    .map((part) => escapeRegExp(part))
    .join('\\s+')
  const pattern = new RegExp(normalized, 'g')
  const occurrences = []
  let match = pattern.exec(newText)
  while (match) {
    occurrences.push({ start: match.index, end: match.index + match[0].length })
    pattern.lastIndex = match.index + 1
    match = pattern.exec(newText)
    if (occurrences.length >= 8) break
  }
  return occurrences
}

function contextCandidates(anchor, newText, offsets) {
  const quote = anchor.quote
  if (!quote || quote.trim().length < 2) return []
  const occurrences = findQuoteOccurrences(newText, quote)
  const oldPrefix = anchor.context?.before?.slice(-24) || ''
  const oldSuffix = anchor.context?.after?.slice(0, 24) || ''
  return occurrences.map((occurrence) => {
    const { start, end } = occurrence
    const before = newText.slice(Math.max(0, start - 24), start)
    const after = newText.slice(end, end + 24)
    let confidence = occurrences.length === 1 ? 0.76 : 0.52
    let source = occurrences.length === 1 ? 'unique-quoted-text' : 'repeated-quoted-text'
    const notes = []
    if (oldPrefix && before.endsWith(oldPrefix)) {
      confidence += 0.08
      notes.push('prefix context agrees')
    }
    if (oldSuffix && after.startsWith(oldSuffix)) {
      confidence += 0.08
      notes.push('suffix context agrees')
    }
    if (occurrences.length > 1) notes.push(`${occurrences.length} identical quotations exist`)
    return {
      anchor: {
        schemaVersion: 2,
        baselineRevision: null,
        ranges: [{
          start,
          end,
          startOffset: offsets[start] ?? null,
          endOffset: offsets[end - 1] ?? null,
          text: newText.slice(start, end)
        }],
        quote,
        context: anchor.context,
        nodeRanges: []
      },
      confidence: Number(Math.min(0.82, confidence).toFixed(3)),
      source,
      note: notes.join('; ') || 'matched quoted text only; surrounding context differs',
      evidence: { occurrences: occurrences.length, before, after }
    }
  })
}

function directCandidates(anchor, oldText, newText, lineMap) {
  const oldOffsets = lineOffsets(oldText)
  const newOffsets = lineOffsets(newText)
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const candidates = []

  function walk(rangeIndex, ranges, chosenMappings) {
    if (candidates.length >= 12) return
    if (rangeIndex === anchor.ranges.length) {
      const ordered = chosenMappings.every((mapping, index) => {
        if (index === 0) return true
        return mapping.newIndex > chosenMappings[index - 1].newIndex
      })
      if (!ordered) return
      const confidence = Math.min(...chosenMappings.map((x) => x.confidence))
      const source = confidence >= 0.85 ? 'version-diff' : 'ambiguous-diff'
      candidates.push({
        anchor: {
          schemaVersion: 2,
          baselineRevision: null,
          ranges,
          quote: textAt(newText, ranges[0].start, ranges[ranges.length - 1].end).replace(/\n/g, ' '),
          context: anchor.context,
          nodeRanges: []
        },
        confidence: Number(confidence.toFixed(3)),
        source,
        note: confidence >= 0.85
          ? 'line and character boundaries were transformed by the version diff'
          : 'diff produced a non-unique or low-confidence destination; human confirmation required',
        evidence: { mappings: chosenMappings.map(({ oldIndex, newIndex, source: s }) => ({ oldIndex, newIndex, source: s })) }
      })
      return
    }

    const original = anchor.ranges[rangeIndex]
    const startLine = oldOffsets.findLastIndex((offset) => offset <= original.start)
    const endLine = oldOffsets.findLastIndex((offset) => offset <= original.end - 1)
    const options = lineMap.get(startLine) || []
    for (const mapping of options) {
      if (endLine !== startLine) {
        // Cross-block anchors are stored as multiple ranges. Each part must land
        // in a contiguous destination line for this hypothesis.
        const endOptions = lineMap.get(endLine) || []
        const endMapping = endOptions.find((item) => item.newIndex === mapping.newIndex + (endLine - startLine))
        if (!endMapping) continue
      }
      const oldStartOffset = oldOffsets[startLine]
      const startBoundary = mapBoundary(original.start - oldStartOffset, oldLines[startLine], newLines[mapping.newIndex], mapping.confidence)
      if (startBoundary.offset == null) continue
      const newStart = newOffsets[mapping.newIndex] + startBoundary.offset

      const endLineNow = endLine === startLine ? mapping.newIndex : mapping.newIndex + (endLine - startLine)
      const endOldLine = oldLines[endLine]
      const endNewLine = newLines[endLineNow]
      const endBoundary = mapBoundary(original.end - oldOffsets[endLine], endOldLine, endNewLine, mapping.confidence)
      if (endBoundary.offset == null || endBoundary.offset < startBoundary.offset) continue
      const newEnd = newOffsets[endLineNow] + endBoundary.offset
      walk(rangeIndex + 1, ranges.concat({
        start: newStart,
        end: newEnd,
        startOffset: newOffsets[mapping.newIndex],
        endOffset: newOffsets[endLineNow],
        text: newText.slice(newStart, newEnd)
      }), chosenMappings.concat(mapping))
    }
  }

  walk(0, [], [])
  const seen = new Set()
  return candidates.filter((candidate) => {
    const key = candidate.anchor.ranges.map(makeRangeKey).join('|') + candidate.source
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function relocateAnchor(anchor, oldText, newText, options = {}) {
  const lineMap = buildLineMappings(splitLines(oldText), splitLines(newText))
  const candidates = directCandidates(anchor, oldText, newText, lineMap)
  candidates.push(...contextCandidates(anchor, newText, lineOffsets(newText)))

  const unique = new Map()
  for (const candidate of candidates) {
    const key = `${candidate.anchor.ranges.map(makeRangeKey).join('|')}|${candidate.source}`
    if (!unique.has(key)) unique.set(key, candidate)
  }
  const sorted = [...unique.values()].sort((a, b) => b.confidence - a.confidence)
  const autoThreshold = options.autoThreshold ?? 0.85
  const accepted = sorted.find((candidate) => candidate.confidence >= autoThreshold)

  if (!accepted) {
    return {
      status: 'dangling',
      reason: sorted.length
        ? 'candidates exist but none uniquely crosses the automatic relocation threshold'
        : 'selected text was deleted and no quotation remains',
      candidates: sorted.slice(0, 8)
    }
  }
  return {
    status: 'anchored',
    reason: 'unique high-confidence diff mapping',
    candidates: sorted.slice(0, 8),
    anchor: accepted.anchor
  }
}
