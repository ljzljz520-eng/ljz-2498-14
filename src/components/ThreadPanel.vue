<script setup>
const props = defineProps({
  threads: { type: Array, required: true },
  activeThreadId: { type: String, default: '' },
  legacyEpoch: { type: Number, default: 2 },
})
const emit = defineEmits(['select', 'reply', 'resolve', 'reopen', 'request-review', 'accept-candidate', 'reject-candidates'])

const labels = {
  open: '待处理',
  resolved: '已解决',
  needs_review: '内容已改写，需重新审阅',
  candidate: '候选定位待确认',
  detached: '悬挂线程',
  conflict: '并发冲突待裁决',
}

function eventLabel(event) {
  return {
    'thread.created': '创建批注',
    'thread.reply': '回复',
    'thread.resolved': '解决',
    'thread.reopened': '重开',
    'review.requested': '重新请求审阅',
    'anchor.migrated': '系统迁移锚点',
    'anchor.candidate': '找到候选定位',
    'anchor.attached': '人工确认定位',
    'anchor.detached': '锚点悬挂',
    'thread.concurrent-conflict': '并发冲突',
  }[event.type] || event.type
}

function candidateId(candidate) {
  return `${candidate.sourceRange.start}-${candidate.sourceRange.end}`
}
</script>

<template>
  <aside class="thread-panel">
    <div class="thread-panel-header">
      <h2>审阅线程</h2>
      <span>{{ threads.length }} 条</span>
    </div>

    <p v-if="!threads.length" class="empty-hint">在右侧预览选中文字即可创建批注。</p>

    <article
      v-for="thread in threads"
      :key="thread.threadId"
      :class="['thread-card', activeThreadId === thread.threadId ? 'active' : '', `status-${thread.status}`]"
      @click="emit('select', thread.threadId)"
    >
      <header>
        <span class="status-pill">{{ labels[thread.status] || thread.status }}</span>
        <span class="generation">第 {{ thread.reviewGeneration }} 代审阅</span>
      </header>

      <blockquote class="quote">{{ thread.anchor?.quote?.exact || thread.detachment?.reason || '原内容已不可见' }}</blockquote>

      <div v-if="thread.anchor" class="anchor-meta">
        <span>节点：{{ thread.anchor.nodeRanges.map((item) => item.nodeId.split('-')[0]).join(', ') }}</span>
        <span>v{{ thread.anchor.documentVersion }}</span>
        <span :title="thread.anchor.quote.hash">引用指纹 {{ thread.anchor.quote.hash.slice(0, 7) }}</span>
      </div>

      <section v-if="thread.pendingRelocation" class="candidate-box" @click.stop>
        <h3>候选定位（不会仅因同句自动迁移）</h3>
        <div v-for="candidate in thread.pendingRelocation.candidates.slice(0, 4)" :key="candidateId(candidate)" class="candidate">
          <div class="candidate-head">
            <strong>{{ candidate.source }}</strong>
            <span :class="candidate.confidence >= 0.9 ? 'confidence high' : 'confidence low'">
              {{ Math.round(candidate.confidence * 100) }}%
            </span>
          </div>
          <p>{{ candidate.quote }}</p>
          <ul>
            <li v-for="(reason, index) in candidate.reasons" :key="index">{{ reason }}</li>
          </ul>
          <button type="button" @click="emit('accept-candidate', { threadId: thread.threadId, candidateId: candidateId(candidate) })">
            确认此位置
          </button>
        </div>
        <button type="button" class="text-danger" @click="emit('reject-candidates', thread.threadId)">
          都不是，保留悬挂线程
        </button>
      </section>

      <ol class="event-log">
        <li v-for="event in thread.events" :key="event.eventId">
          <div>
            <strong>{{ eventLabel(event) }}</strong>
            <span class="event-actor">{{ event.actorId }}</span>
          </div>
          <p v-if="event.body">{{ event.body }}</p>
          <details v-if="event.type === 'anchor.migrated' || event.type === 'anchor.candidate'">
            <summary>来源与置信说明</summary>
            <pre>{{ JSON.stringify(event.payload.reasons || event.payload.relocation?.reason || event.payload, null, 2) }}</pre>
          </details>
          <small>{{ new Date(event.createdAt).toLocaleString() }}</small>
        </li>
      </ol>

      <footer @click.stop>
        <input placeholder="回复或重开说明..." @keyup.enter="emit('reply', { threadId: thread.threadId, body: $event.target.value, target: $event.target })" />
        <div class="thread-actions">
          <button v-if="thread.status !== 'resolved'" type="button" @click="emit('resolve', thread.threadId)">解决</button>
          <button v-if="thread.status === 'resolved' || thread.status === 'needs_review'" type="button" @click="emit('reopen', thread.threadId)">重开</button>
          <button v-if="thread.status === 'needs_review'" type="button" @click="emit('request-review', thread.threadId)">重新请求审阅</button>
        </div>
      </footer>
    </article>
  </aside>
</template>
