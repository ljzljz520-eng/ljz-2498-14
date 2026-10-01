<script setup>
import { computed } from 'vue'

const props = defineProps({
  blocks: { type: Array, required: true },
  anchors: { type: Array, default: () => [] },
})

const TAG_BY_TYPE = {
  h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
  paragraph: 'p', blockquote: 'blockquote', code: 'pre', hr: 'hr',
}

const groupedBlocks = computed(() => {
  const groups = []
  for (const block of props.blocks) {
    if (block.type === 'listItem') {
      const last = groups.at(-1)
      if (last?.type === 'list' && last.listType === block.listType) last.items.push(block)
      else groups.push({ type: 'list', listType: block.listType, id: `${block.listType}-${block.signature}-group-${groups.length}`, items: [block] })
    } else {
      groups.push(block)
    }
  }
  return groups
})

function pieces(segment) {
  const intersections = props.anchors
    .filter((anchor) => anchor.sourceRange && anchor.sourceRange.end > segment.start && anchor.sourceRange.start < segment.end)
    .map((anchor) => ({
      start: Math.max(segment.start, anchor.sourceRange.start),
      end: Math.min(segment.end, anchor.sourceRange.end),
      threadId: anchor.threadId,
      status: anchor.status,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end)

  if (!intersections.length) return [{ text: segment.text, start: segment.start, mark: null }]
  const boundaries = [segment.start, segment.end, ...intersections.flatMap((item) => [item.start, item.end])]
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((a, b) => a - b)
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1]
    const mark = intersections.find((item) => item.start <= start && item.end >= end)
    return {
      text: segment.text.slice(start - segment.start, end - segment.start),
      start,
      end,
      mark: mark ? { threadId: mark.threadId, status: mark.status } : null,
    }
  }).filter((piece) => piece.end > piece.start)
}

function inlineTag(segment) {
  if (segment.type === 'strong') return 'strong'
  if (segment.type === 'em') return 'em'
  if (segment.type === 'code') return 'code'
  if (segment.type === 'link') return 'a'
  return 'span'
}
</script>

<template>
  <div class="rendered-document">
    <template v-for="block in groupedBlocks" :key="block.id">
      <component
        :is="block.type === 'list' ? block.listType : TAG_BY_TYPE[block.type] || 'p'"
        :data-node-type="block.type"
        :class="block.type === 'code' && block.language ? `language-${block.language}` : ''"
      >
        <template v-if="block.type === 'list'">
          <li
            v-for="item in block.items"
            :id="`node-${item.id}`"
            :key="item.id"
            :data-node-id="item.id"
            :data-node-type="item.type"
          >
            <template v-for="(segment, index) in item.segments" :key="`${item.id}-${index}`">
              <component
                v-if="segment.type !== 'separator'"
                :is="inlineTag(segment)"
                v-for="piece in pieces(segment)"
                :key="`${segment.start}-${piece.start}-${piece.end}`"
                :href="segment.type === 'link' ? segment.href : undefined"
                :target="segment.type === 'link' ? '_blank' : undefined"
                :rel="segment.type === 'link' ? 'noopener' : undefined"
                :data-source-start="piece.start"
                :data-source-end="piece.end"
                :data-node-id="item.id"
                :data-node-start="segment.nodeStart + (piece.start - segment.start)"
                :data-node-end="segment.nodeStart + (piece.end - segment.start)"
                :data-thread-id="piece.mark?.threadId"
                :class="piece.mark ? ['annotation-mark', `annotation-${piece.mark.status || 'open'}`] : ''"
              >{{ piece.text }}</component>
            </template>
          </li>
        </template>

        <template v-else-if="block.type === 'code'">
          <code :class="block.language ? `language-${block.language}` : ''">
            <template v-for="(segment, index) in block.segments" :key="`${block.id}-${index}`">
              <component
                v-if="segment.type !== 'separator'"
                :is="inlineTag(segment)"
                v-for="piece in pieces(segment)"
                :key="`${segment.start}-${piece.start}-${piece.end}`"
                :data-source-start="piece.start"
                :data-source-end="piece.end"
                :data-node-id="block.id"
                :data-node-start="segment.nodeStart + (piece.start - segment.start)"
                :data-node-end="segment.nodeStart + (piece.end - segment.start)"
                :data-thread-id="piece.mark?.threadId"
                :class="piece.mark ? ['annotation-mark', `annotation-${piece.mark.status || 'open'}`] : ''"
              >{{ piece.text }}</component>
              <br v-else />
            </template>
          </code>
        </template>

        <template v-else-if="block.type !== 'hr'">
          <template v-for="(segment, index) in block.segments" :key="`${block.id}-${index}`">
            <component
              v-if="segment.type !== 'separator'"
              :is="inlineTag(segment)"
              v-for="piece in pieces(segment)"
              :key="`${segment.start}-${piece.start}-${piece.end}`"
              :href="segment.type === 'link' ? segment.href : undefined"
              :target="segment.type === 'link' ? '_blank' : undefined"
              :rel="segment.type === 'link' ? 'noopener' : undefined"
              :data-source-start="piece.start"
              :data-source-end="piece.end"
              :data-node-id="block.id"
              :data-node-start="segment.nodeStart + (piece.start - segment.start)"
              :data-node-end="segment.nodeStart + (piece.end - segment.start)"
              :data-thread-id="piece.mark?.threadId"
              :class="piece.mark ? ['annotation-mark', `annotation-${piece.mark.status || 'open'}`] : ''"
            >{{ piece.text }}</component>
            <span v-else class="block-newline">
</span>
          </template>
        </template>
      </component>
    </template>
  </div>
</template>
