function pushPlain(chunks, lineOffset, line, start, end) {
  if (start < end) {
    chunks.push({
      text: line.slice(start, end),
      start: lineOffset + start,
      end: lineOffset + end,
      tag: null
    })
  }
}

function parseInline(line, lineOffset) {
  const chunks = []
  let i = 0
  const rules = [
    { tag: 'code', regex: /^`([^`]+)`/ },
    { tag: 'a', regex: /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/, href: (match) => match[2] },
    { tag: 'strong', regex: /^\*\*([^*]+)\*\*/ },
    { tag: 'em', regex: /^\*([^*]+)\*/ }
  ]

  while (i < line.length) {
    let matched = null
    for (const rule of rules) {
      const match = rule.regex.exec(line.slice(i))
      if (match) {
        matched = { rule, match, at: i }
        break
      }
    }
    if (!matched) {
      pushPlain(chunks, lineOffset, line, i, line.length)
      break
    }

    const { rule, match, at } = matched
    pushPlain(chunks, lineOffset, line, i, at)
    const visibleStart = at + match[0].indexOf(match[1])
    chunks.push({
      text: match[1],
      start: lineOffset + visibleStart,
      end: lineOffset + visibleStart + match[1].length,
      tag: rule.tag,
      href: rule.href ? rule.href(match) : null
    })
    i = at + match[0].length
  }
  return chunks.filter((chunk) => chunk.text.length > 0)
}

function trimmedBounds(rawLine, offset) {
  const left = rawLine.match(/^\s*/)[0].length
  const right = rawLine.match(/\s*$/)[0].length
  return {
    start: offset + left,
    end: offset + rawLine.length - right,
    text: rawLine.slice(left, rawLine.length - right)
  }
}

function isList(line) {
  return /^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)
}

function listOrdered(line) {
  return /^\s*\d+\.\s+/.test(line)
}

function stripList(line) {
  return line.trim().replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
}

function blockBoundary(type, path, start, end, extra = {}) {
  return { type, path, start, end, segments: [], ...extra }
}

export function parseCatalpaBlocks(source) {
  const lines = source.split('\n')
  const blocks = []
  let offset = 0
  let i = 0
  let paragraphIndex = 0
  let quoteIndex = 0
  let listIndex = 0

  while (i < lines.length) {
    const lineStart = offset
    const rawLine = lines[i]
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    if (trimmed === '') {
      offset += rawLine.length + 1
      i += 1
      continue
    }

    if (/^```/.test(trimmed)) {
      const start = lineStart + line.match(/^\s*/)[0].length
      i += 1
      offset = lineStart + rawLine.length + 1
      const codeLines = []
      const block = blockBoundary('code', ['code', blocks.length], start, start)
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i])
        block.segments.push({
          text: lines[i],
          start: offset,
          end: offset + lines[i].length,
          tag: null
        })
        offset += lines[i].length + 1
        i += 1
      }
      const fenceLength = i < lines.length ? lines[i].length : 0
      block.end = offset - 1
      blocks.push(block)
      if (i < lines.length) offset += fenceLength + 1
      i += 1
      continue
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      const bounds = trimmedBounds(trimmed, lineStart + line.match(/^\s*/)[0].length)
      const level = trimmed.match(/^#{1,6}/)[0].length
      const text = bounds.text.replace(/^#{1,6}\s+/, '')
      const markerLength = trimmed.match(/^#{1,6}\s+/)[0].length
      const contentOffset = bounds.start + markerLength
      const block = blockBoundary(`h${level}`, [`h${level}`, blocks.length], lineStart, lineStart + rawLine.length)
      block.segments = parseInline(text, contentOffset)
      blocks.push(block)
      offset = lineStart + rawLine.length + 1
      i += 1
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      const block = blockBoundary('blockquote', ['blockquote', quoteIndex++], lineStart, lineStart)
      let lineInQuote = 0
      let quoteLineStart = lineStart
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        const raw = lines[i]
        const markerMatch = raw.match(/^\s*>\s?/)
        const textStart = quoteLineStart + markerMatch[0].length
        const text = raw.slice(markerMatch[0].length).trimEnd()
        block.segments.push(...parseInline(text, textStart).map((chunk) => ({
          ...chunk,
          path: ['line', lineInQuote]
        })))
        lineInQuote += 1
        offset = quoteLineStart + raw.length + 1
        quoteLineStart = offset
        i += 1
      }
      block.end = offset - 1
      blocks.push(block)
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push(blockBoundary('hr', ['hr', blocks.length], lineStart, lineStart + rawLine.length))
      offset = lineStart + rawLine.length + 1
      i += 1
      continue
    }

    if (isList(line)) {
      const ordered = listOrdered(line)
      const currentListIndex = listIndex++
      let itemIndex = 0
      let listLineStart = lineStart
      while (i < lines.length && isList(lines[i].trimEnd())) {
        const raw = lines[i]
        const text = stripList(raw)
        const markerLength = raw.match(/^\s*(?:[-*+]|\d+\.)\s+/)[0].length
        const block = blockBoundary('list-item', [ordered ? 'ol' : 'ul', currentListIndex, 'li', itemIndex], listLineStart, listLineStart + raw.length, {
          ordered,
          listIndex: currentListIndex,
          itemIndex
        })
        block.segments = parseInline(text, listLineStart + markerLength)
        blocks.push(block)
        offset = listLineStart + raw.length + 1
        listLineStart = offset
        itemIndex += 1
        i += 1
      }
      continue
    }

    let paragraphStart = lineStart
    const block = blockBoundary('paragraph', ['paragraph', paragraphIndex++], paragraphStart, paragraphStart)
    let paragraphLine = 0
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,6}\s+/.test(lines[i].trim()) &&
      !/^```/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !isList(lines[i].trimEnd())
    ) {
      const raw = lines[i]
      const bounds = trimmedBounds(raw, paragraphStart)
      block.segments.push(...parseInline(bounds.text, bounds.start).map((chunk) => ({
        ...chunk,
        lineInParagraph: paragraphLine
      })))
      block.end = paragraphStart + raw.length
      offset = paragraphStart + raw.length + 1
      paragraphStart = offset
      paragraphLine += 1
      i += 1
    }
    blocks.push(block)
  }

  return blocks
}
