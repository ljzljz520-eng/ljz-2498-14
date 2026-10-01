function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.parentElement) return NodeFilter.FILTER_REJECT
      if (node.parentElement.closest('[data-comment-ui="true"]')) return NodeFilter.FILTER_REJECT
      if (node.parentElement.closest('script,style')) return NodeFilter.FILTER_REJECT
      return node.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  const nodes = []
  let current = walker.nextNode()
  while (current) {
    nodes.push(current)
    current = walker.nextNode()
  }
  return nodes
}

function pointToOffset(root, textNodes, container, offset) {
  if (container === root) {
    const total = textNodes.reduce((sum, node) => sum + node.nodeValue.length, 0)
    return offset === 0 ? 0 : total
  }

  if (container.nodeType === Node.TEXT_NODE) {
    let result = 0
    for (const node of textNodes) {
      if (node === container) return result + offset
      result += node.nodeValue.length
    }
  }

  const child = container.children?.[offset] ?? null
  let result = 0
  for (const node of textNodes) {
    if (container.contains(node)) {
      // A point before the selected child starts at the beginning of that child.
      if (child && child.contains(node)) return result
      // A point after all children reaches the end of the last contained node.
      if (!child && node === textNodes.filter((item) => container.contains(item)).at(-1)) {
        return result + node.nodeValue.length
      }
    }
    result += node.nodeValue.length
  }
  return result
}

// Converts a rendered DOM selection into source offsets using data-source-start
// on the nearest segment. The DOM visible offsets are then converted with the
// parser's segment map, so markup characters cannot be selected.
export function selectionToSourceRange(rootElement, state) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  if (!rootElement.contains(selection.anchorNode) || !rootElement.contains(selection.focusNode)) return null
  const textNodes = collectTextNodes(rootElement)
  if (!textNodes.length) return null

  let anchorVisible = pointToOffset(rootElement, textNodes, selection.anchorNode, selection.anchorOffset)
  let focusVisible = pointToOffset(rootElement, textNodes, selection.focusNode, selection.focusOffset)
  if (anchorVisible > focusVisible) [anchorVisible, focusVisible] = [focusVisible, anchorVisible]

  function locate(visibleOffset, endpoint) {
    let consumed = 0
    for (const node of textNodes) {
      const next = consumed + node.nodeValue.length
      if (visibleOffset <= next || (endpoint === 'end' && node === textNodes[textNodes.length - 1])) {
        const within = Math.max(0, Math.min(node.nodeValue.length, visibleOffset - consumed))
        const element = node.parentElement.closest('[data-source-start]')
        if (!element) return null
        const sourceStart = Number(element.dataset.sourceStart)
        const sourceEnd = Number(element.dataset.sourceEnd)
        const segment = state.ranges.find((item) => item.sourceStart === sourceStart && item.sourceEnd === sourceEnd)
        if (!segment) return null
        const visible = segment.visibleStart + within
        return { visible, source: sourceStart + within }
      }
      consumed = next
    }
    return null
  }

  const start = locate(anchorVisible, 'start')
  const end = locate(focusVisible, 'end')
  if (!start || !end || end.source <= start.source) return null
  return { start: start.source, end: end.source, visibleStart: start.visible, visibleEnd: end.visible }
}

export function clearWindowSelection() {
  window.getSelection()?.removeAllRanges()
}
