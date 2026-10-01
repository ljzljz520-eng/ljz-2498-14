function lcsTable(oldItems, newItems) {
  const dp = Array.from({ length: oldItems.length + 1 }, () => Array(newItems.length + 1).fill(0))
  for (let i = oldItems.length - 1; i >= 0; i -= 1) {
    for (let j = newItems.length - 1; j >= 0; j -= 1) {
      dp[i][j] = oldItems[i] === newItems[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  return dp
}

export function diffItems(oldItems, newItems) {
  const dp = lcsTable(oldItems, newItems)
  const chunks = []
  let i = 0
  let j = 0

  const push = (type, oldStart, oldEnd, newStart, newEnd) => {
    if (oldStart === oldEnd && newStart === newEnd) return
    const previous = chunks[chunks.length - 1]
    if (previous && previous.type === type) {
      previous.oldEnd = oldEnd
      previous.newEnd = newEnd
    } else {
      chunks.push({ type, oldStart, oldEnd, newStart, newEnd })
    }
  }

  while (i < oldItems.length && j < newItems.length) {
    if (oldItems[i] === newItems[j]) {
      push('equal', i, i + 1, j, j + 1)
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('delete', i, i + 1, j, j)
      i += 1
    } else {
      push('insert', i, i, j, j + 1)
      j += 1
    }
  }
  push('delete', i, oldItems.length, j, j)
  push('insert', oldItems.length, oldItems.length, j, newItems.length)
  return chunks
}

export function charDiff(oldText, newText) {
  return diffItems(Array.from(oldText), Array.from(newText))
}

export function lineDiff(oldText, newText) {
  return diffItems(oldText.split(/\r?\n/), newText.split(/\r?\n/))
}

export function oldIndexToNew(chunks, oldIndex) {
  for (const chunk of chunks) {
    if (chunk.type === 'equal') {
      if (oldIndex >= chunk.oldStart && oldIndex < chunk.oldEnd) {
        return chunk.newStart + (oldIndex - chunk.oldStart)
      }
    } else if (chunk.type === 'delete' && oldIndex >= chunk.oldStart && oldIndex < chunk.oldEnd) {
      return chunk.newStart
    }
  }
  return null
}

export function mapOldRangeToNew(oldText, newText, start, end) {
  const oldChars = Array.from(oldText)
  const newChars = Array.from(newText)
  if (start < 0 || end > oldChars.length || start > end) return null
  const chunks = charDiff(oldText, newText)
  const mappedStart = oldIndexToNew(chunks, start)
  const mappedEnd = end === start ? mappedStart : oldIndexToNew(chunks, end - 1)
  if (mappedStart === null || mappedEnd === null) return null
  const finalEnd = Math.max(mappedStart, mappedEnd + 1)
  const quote = newChars.slice(mappedStart, finalEnd).join('')
  const oldSelection = oldChars.slice(start, end).join('')
  const retained = Array.from(quote).filter((char) => /\S/.test(char)).length
  const oldUseful = Array.from(oldSelection).filter((char) => /\S/.test(char)).length
  return {
    sourceRange: { start: mappedStart, end: finalEnd },
    text: quote,
    coverage: oldUseful ? retained / oldUseful : quote ? 0 : 1,
  }
}

// Deterministic dependency-free three-way line merge. Overlapping, unequal
// edits are emitted with conflict markers instead of silently choosing one.
export function diff3Merge(baseText, localText, remoteText) {
  const base = baseText.split(/\r?\n/)
  const local = localText.split(/\r?\n/)
  const remote = remoteText.split(/\r?\n/)
  const localChunks = diffItems(base, local)
  const remoteChunks = diffItems(base, remote)

  const boundaries = new Set([0, base.length])
  for (const chunk of [...localChunks, ...remoteChunks]) {
    boundaries.add(chunk.oldStart)
    boundaries.add(chunk.oldEnd)
  }
  const points = [...boundaries].sort((a, b) => a - b)

  function coveringChunk(chunks, b0, b1) {
    return chunks.find((chunk) => chunk.oldStart <= b0 && b1 <= chunk.oldEnd)
  }

  function mappedLines(chunks, b0, b1) {
    if (b0 === b1) return []
    const chunk = coveringChunk(chunks, b0, b1)
    if (!chunk || chunk.type !== 'equal') return []
    return chunks === localChunks
      ? local.slice(chunk.newStart + (b0 - chunk.oldStart), chunk.newStart + (b1 - chunk.oldStart))
      : remote.slice(chunk.newStart + (b0 - chunk.oldStart), chunk.newStart + (b1 - chunk.oldStart))
  }

  function insertedAt(chunks, lines, position) {
    const result = []
    for (const chunk of chunks) {
      if (chunk.type === 'insert' && chunk.oldStart === position) {
        result.push(...lines.slice(chunk.newStart, chunk.newEnd))
      }
    }
    return result
  }

  const output = []
  const conflicts = []

  for (let i = 0; i < points.length - 1; i += 1) {
    const b0 = points[i]
    const b1 = points[i + 1]
    const basePart = base.slice(b0, b1)
    const localPart = [...insertedAt(localChunks, local, b0), ...mappedLines(localChunks, b0, b1)]
    const remotePart = [...insertedAt(remoteChunks, remote, b0), ...mappedLines(remoteChunks, b0, b1)]
    const localChanged = JSON.stringify(localPart) !== JSON.stringify(basePart)
    const remoteChanged = JSON.stringify(remotePart) !== JSON.stringify(basePart)

    if (!localChanged && !remoteChanged) {
      output.push(...basePart)
    } else if (localChanged && !remoteChanged) {
      output.push(...localPart)
    } else if (!localChanged && remoteChanged) {
      output.push(...remotePart)
    } else if (JSON.stringify(localPart) === JSON.stringify(remotePart)) {
      output.push(...localPart)
    } else {
      conflicts.push({ baseStart: b0, baseEnd: b1, local: localPart, remote: remotePart })
      output.push('<<<<<<< local', ...localPart, '=======', ...remotePart, '>>>>>>> remote')
    }
  }

  // Handle insertions attached to final document position.
  const end = base.length
  const localTail = insertedAt(localChunks, local, end)
  const remoteTail = insertedAt(remoteChunks, remote, end)
  if (JSON.stringify(localTail) === JSON.stringify(remoteTail)) output.push(...localTail)
  else if (!localTail.length) output.push(...remoteTail)
  else if (!remoteTail.length) output.push(...localTail)
  else {
    conflicts.push({ baseStart: end, baseEnd: end, local: localTail, remote: remoteTail })
    output.push('<<<<<<< local', ...localTail, '=======', ...remoteTail, '>>>>>>> remote')
  }

  return { text: output.join('\n'), hasConflicts: conflicts.length > 0, conflicts }
}
