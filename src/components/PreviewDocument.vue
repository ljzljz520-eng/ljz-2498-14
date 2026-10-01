<script setup>
import { computed, h } from 'vue'
import { RangeSet } from '../review/anchor.js'

const props = defineProps({
  blocks: { type: Array, required: true },
  threads: { type: Array, default: () => [] },
  activeThreadId: { type: String, default: '' }
})
const emit = defineEmits(['select-thread'])

const rangeSet = computed(() => new RangeSet(props.threads.filter((thread) => thread.anchor)))

function boundariesFor(segment) {
  const points = new Set([segment.start, segment.end])
  for (const { range } of rangeSet.value.threads) {
    if (range.start > segment.start && range.start < segment.end) points.add(range.start)
    if (range.end > segment.start && range.end < segment.end) points.add(range.end)
  }
  return [...points].sort((a, b) => a - b)
}

function renderSegment(segment) {
  const points = boundariesFor(segment)
  const nodes = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i]
    const end = points[i + 1]
    const active = rangeSet.value.threadsAt(start, end)
    const thread = [...active.values()][0]
    const classes = ['doc-run']
    if (thread) {
      classes.push('annotation-anchor', `annotation-${thread.status}`)
      if (thread.id === props.activeThreadId) classes.push('active-annotation')
    }
    const attrs = {
      'data-src-start': start,
      'data-src-end': end,
      class: classes.join(' '),
      key: `${start}-${end}`
    }
    if (thread) {
      attrs.title = `${thread.status}: ${thread.quote}`
      attrs.onClick = (event) => {
        event.stopPropagation()
        emit('select-thread', thread.id)
      }
    }
    let node = h('span', attrs, segment.text.slice(start - segment.start, end - segment.start))
    if (segment.tag) {
      const tagAttrs = { 'data-src-start': start, 'data-src-end': end, key: `tag-${start}-${end}` }
      if (segment.tag === 'a') tagAttrs.href = segment.href
      node = h(segment.tag, tagAttrs, [node])
    }
    nodes.push(node)
  }
  return nodes
}

function renderSegments(block) {
  return block.segments.flatMap((segment) => renderSegment(segment))
}

function renderBlock(block, context) {
  const children = renderSegments(block)
  switch (block.type) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return h(block.type, { key: context.key }, children)
    case 'blockquote':
      return h('blockquote', { key: context.key }, [h('p', null, children)])
    case 'code':
      return h('pre', { key: context.key }, [h('code', null, children)])
    case 'hr':
      return h('hr', { key: context.key })
    case 'list-item':
      return h('li', { key: context.key }, children)
    case 'paragraph':
    default:
      return h('p', { key: context.key }, children)
  }
}

const rendered = computed(() => {
  const out = []
  for (let i = 0; i < props.blocks.length; i += 1) {
    const block = props.blocks[i]
    if (block.type === 'list-item') {
      const ordered = block.ordered
      const items = []
      while (i < props.blocks.length && props.blocks[i].type === 'list-item' && props.blocks[i].ordered === ordered) {
        items.push(renderBlock(props.blocks[i], { key: i }))
        i += 1
      }
      i -= 1
      out.push(h(ordered ? 'ol' : 'ul', { key: `list-${i}` }, items))
    } else {
      out.push(renderBlock(block, { key: i }))
    }
  }
  return out
})
</script>

<template>
  <article class="preview markdown-body review-preview">{{ rendered }}</article>
</template>
