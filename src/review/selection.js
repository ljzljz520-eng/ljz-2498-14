function pointToSource(node, offset, root) {
  if (node.nodeType === Node.TEXT_NODE) {
    const chunk = node.parentElement?.closest?.('[data-src-start]')
    if (!chunk || !root.contains(chunk)) return null
    return Number(chunk.dataset.srcStart) + offset
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return null
  if (node.matches?.('[data-src-start]') && (offset === 0 || offset === node.childNodes.length)) {
    return Number(node.dataset[offset === 0 ? 'srcStart' : 'srcEnd'])
  }

  const child = node.childNodes[Math.min(offset, node.childNodes.length - 1)]
  const chunks = [...root.querySelectorAll('[data-src-start]')]
  if (offset === 0 && child) {
    const containing = child.nodeType === Node.ELEMENT_NODE
      ? child.closest?.('[data-src-start]')
      : child.parentElement?.closest?.('[data-src-start]')
    if (containing) return Number(containing.dataset.srcStart)
  }

  if (child) {
    const before = chunks.filter((chunk) => child.compareDocumentPosition(chunk) & Node.DOCUMENT_POSITION_PRECEDING)
    if (before.length) return Number(before.at(-1).dataset.srcEnd)
  }
  return null
}

export function domSelectionToSourceRange(root) {
  const selection = window.getSelection?.()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const domRange = selection.getRangeAt(0)
  if (!root.contains(domRange.startContainer) || !root.contains(domRange.endContainer)) return null
  const start = pointToSource(domRange.startContainer, domRange.startOffset, root)
  const end = pointToSource(domRange.endContainer, domRange.endOffset, root)
  if (start == null || end == null || start === end) return null
  return { start: Math.min(start, end), end: Math.max(start, end), domRange }
}
