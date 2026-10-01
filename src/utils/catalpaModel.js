import { stableHash } from './text.js'

const INLINE_PATTERN = /(?<code>`[^`]+`)|(?<link>\[(?<label>[^\]]+)\]\((?<url>https?:\/\/[^\s)]+)\))|(?<strong>\*\*(?<strongText>[^*]+)\*\*)|(?<em>\*(?<emText>[^*]+)\*)/

function typeFor(listLine) {
  if (/^\s*[-*+]\s+/.test(listLine)) return 'ul'
  if (/^\s*\d+\.\s+/.test(listLine)) return 'ol'
  return ''
}

function listContentStart(rawLine) {
  const match = rawLine.match(/^(\s*(?:[-*+]|\d+\.)\s+)/)
  return match ? match[1].length : 0
}

function addSegment(block, text, start, type = 'text', href = '') {
  if (!text) return
  block.segments.push({
    text,
    start,
    end: start + text.length,
    type,
    href,
  })
}

function addSeparator(block, start, length = 1) {
  if (length <= 0) return
  block.segments.push({ text: '\n', start, end: start + length, type: 'separator' })
}

function parseInline(block, raw, start) {
  let cursor = 0
  while (cursor < raw.length) {
    INLINE_PATTERN.lastIndex = 0
    const match = raw.slice(cursor).match(INLINE_PATTERN)
    if (!match) {
      addSegment(block, raw.slice(cursor), start + cursor)
      break
    }
    const matchStart = cursor + match.index
    if (matchStart > cursor) addSegment(block, raw.slice(cursor, matchStart), start + cursor)
    const groups = match.groups || {}
    const tokenStart = start + matchStart
    if (groups.code) {
      addSegment(block, groups.code.slice(1, -1), tokenStart + 1, 'code')
    } else if (groups.link) {
      addSegment(block, groups.label, tokenStart + 1, 'link', groups.url)
    } else if (groups.strong) {
      addSegment(block, groups.strongText, tokenStart + 2, 'strong')
    } else if (groups.em) {
      addSegment(block, groups.emText, tokenStart + 1, 'em')
    }
    cursor = matchStart + match[0].length
  }
}

function createBlock(type, start, language = '') {
  return {
    id: '',
    type,
    start,
    end: start,
    language,
    text: '',
    segments: [],
  }
}

function finalizeBlock(blocks, block, end, seen) {
  if (!block) return
  block.end = end
  block.text = block.segments.map((segment) => segment.text).join('')
  const signatureBase = `${block.type}:${block.language}:${block.text}`
  const signature = stableHash(signatureBase)
  const occurrence = seen.get(signature) ?? 0
  seen.set(signature, occurrence + 1)
  block.id = `${block.type}-${signature}-${occurrence}`
  block.signature = signature
  block.occurrence = occurrence
  blocks.push(block)
}

// Parses source into block nodes while preserving every rendered text segment's
// original source offsets. This is what makes preview selections auditable.
export function parseCatalpa(source = '') {
  const lines = source.split(/\r?\n/)
  const offsets = []
  let offset = 0
  for (const line of lines) {
    offsets.push(offset)
    offset += line.length + 1
  }

  const blocks = []
  const seen = new Map()
  let i = 0

  while (i < lines.length) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()
    const lineStart = offsets[i]
    const lineLength = rawLine.length

    if (trimmed === '') {
      i += 1
      continue
    }

    if (trimmed.startsWith('```')) {
      const language = trimmed.slice(3).trim()
      const block = createBlock('code', lineStart, language)
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        if (block.segments.length) addSeparator(block, offsets[i] - 1, 1)
        addSegment(block, lines[i], offsets[i])
        i += 1
      }
      i += 1 // closing fence or EOF
      finalizeBlock(blocks, block, i < lines.length ? offsets[i] : source.length, seen)
      continue
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      const level = trimmed.match(/^#{1,6}/)[0].length
      const block = createBlock(`h${level}`, lineStart)
      const prefixLength = rawLine.match(/^\s*#{1,6}\s+/)[0].length
      parseInline(block, rawLine.slice(prefixLength).trim(), lineStart + prefixLength)
      finalizeBlock(blocks, block, lineStart + lineLength, seen)
      i += 1
      continue
    }

    if (/^>\s?/.test(trimmed)) {
      const block = createBlock('blockquote', lineStart)
      const firstPrefix = rawLine.match(/^\s*>\s?/)[0]
      parseInline(block, rawLine.slice(firstPrefix.length), lineStart + firstPrefix.length)
      i += 1
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        addSeparator(block, offsets[i] - 1, 1)
        const prefix = lines[i].match(/^\s*>\s?/)[0]
        parseInline(block, lines[i].slice(prefix.length), offsets[i] + prefix.length)
        i += 1
      }
      finalizeBlock(blocks, block, offsets[i] - 1, seen)
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      const block = createBlock('hr', lineStart)
      block.text = ''
      finalizeBlock(blocks, block, lineStart + lineLength, seen)
      i += 1
      continue
    }

    const listType = typeFor(rawLine)
    if (listType) {
      while (i < lines.length && typeFor(lines[i]) === listType) {
        const itemLine = lines[i]
        const itemStart = offsets[i]
        const block = createBlock('listItem', itemStart)
        block.listType = listType
        const prefixLength = listContentStart(itemLine)
        parseInline(block, itemLine.slice(prefixLength).trimEnd(), itemStart + prefixLength)
        finalizeBlock(blocks, block, itemStart + itemLine.length, seen)
        i += 1
      }
      continue
    }

    const block = createBlock('paragraph', lineStart)
    parseInline(block, rawLine.trimEnd(), lineStart + rawLine.match(/^\s*/)[0].length)
    i += 1
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i].trim()) &&
      !/^#{1,6}\s+/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !typeFor(lines[i])
    ) {
      addSeparator(block, offsets[i] - 1, 1)
      const leading = lines[i].match(/^\s*/)[0].length
      parseInline(block, lines[i].slice(leading).trimEnd(), offsets[i] + leading)
      i += 1
    }
    finalizeBlock(blocks, block, offsets[i] - 1, seen)
  }

  return blocks
}

export function buildVisibleState(source = '') {
  const blocks = parseCatalpa(source)
  const ranges = []
  let visibleOffset = 0

  for (const block of blocks) {
    let nodeOffset = 0
    for (const segment of block.segments) {
      const length = segment.text.length
      segment.nodeStart = nodeOffset
      segment.nodeEnd = nodeOffset + length
      ranges.push({
        blockId: block.id,
        type: block.type,
        sourceStart: segment.start,
        sourceEnd: segment.end,
        visibleStart: visibleOffset,
        visibleEnd: visibleOffset + length,
        nodeStart: nodeOffset,
        nodeEnd: nodeOffset + length,
        text: segment.text,
      })
      visibleOffset += length
      nodeOffset += length
    }
  }

  return {
    blocks,
    text: ranges.map((range) => range.text).join(''),
    ranges,
    rangeForSource(sourceStart, sourceEnd) {
      const selected = ranges.filter((range) => range.sourceEnd > sourceStart && range.sourceStart < sourceEnd)
      if (!selected.length) return null
      const first = selected[0]
      const last = selected[selected.length - 1]
      return {
        start: first.visibleStart + Math.max(0, sourceStart - first.sourceStart),
        end: last.visibleEnd - Math.max(0, last.sourceEnd - sourceEnd),
      }
    },
  }
}

export function sourceRangeFromVisible(state, visibleStart, visibleEnd) {
  const selected = state.ranges.filter((range) => range.visibleEnd > visibleStart && range.visibleStart < visibleEnd)
  if (!selected.length) return null
  const first = selected[0]
  const last = selected[selected.length - 1]
  const sourceStart = first.sourceStart + Math.max(0, visibleStart - first.visibleStart)
  const sourceEnd = last.sourceEnd - Math.max(0, last.visibleEnd - visibleEnd)
  return { start: sourceStart, end: sourceEnd }
}
