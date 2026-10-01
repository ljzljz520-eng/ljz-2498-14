<script setup>
import { computed, ref } from 'vue'
import { decodeThreadPayloads } from '../review/clientGuard.js'

const props = defineProps({
  threads: { type: Array, required: true },
  events: { type: Array, required: true },
  activeThreadId: { type: String, default: '' },
  pendingSelection: { type: Object, default: null },
  clientSchema: { type: Number, default: 2 },
  conflicts: { type: Array, default: () => [] }
})
const emit = defineEmits(['create', 'reply', 'resolve', 'reopen', 'request-review', 'confirm', 'activate'])

const shownThreads = computed(() => decodeThreadPayloads(props.threads, props.clientSchema).map((result) => result.thread))
const active = computed(() => shownThreads.value.find((thread) => thread.id === props.activeThreadId) || null)
const draft = ref('')
const replyDraft = ref('')

function submit() {
  if (!props.pendingSelection || !draft.value.trim()) return
  emit('create', props.pendingSelection, draft.value)
  draft.value = ''
}

function submitReply() {
  emit('reply', props.activeThreadId, replyDraft.value)
  replyDraft.value = ''
}

function statusLabel(thread) {
  return {
    open: '待处理',
    resolved: '已解决',
    dangling: '悬挂待确认',
    'status-conflict': '解决/重开冲突',
    incompatible: '旧前端不可锚定'
  }[thread.status] || thread.status
}

function eventLabel(event) {
  return {
    'thread.created': '创建批注',
    'thread.replied': '回复',
    'thread.resolved': '解决',
    'thread.reopened': '重开',
    'thread.review_requested': '重新请求审阅',
    'thread.anchor_migrated': '自动迁移',
    'thread.anchor_dangling': '转为悬挂',
    'thread.anchor_reanchored': '人工重新锚定',
    'thread.status_conflict': '状态冲突'
  }[event.type] || event.type
}

function confidence(value) {
  return value == null ? '—' : `${Math.round(value * 100)}%`
}
</script>

<template>
  <aside class="review-panel">
    <div class="review-summary">
      <h2>审阅线程</h2>
      <span>{{ shownThreads.filter(t => t.status === 'open').length }} 打开</span>
      <span>{{ shownThreads.filter(t => t.status === 'resolved').length }} 已解决</span>
      <span>{{ shownThreads.filter(t => t.status === 'dangling').length }} 悬挂</span>
    </div>

    <section v-if="pendingSelection" class="composer">
      <h3>新建批注</h3>
      <p class="selection-label">
        选区 {{ pendingSelection.start }}–{{ pendingSelection.end }}
      </p>
      <textarea v-model="draft" placeholder="说明问题或请求修改..." />
      <button type="button" @click="submit">创建线程</button>
    </section>

    <section v-if="conflicts.length" class="conflict-banner">
      <strong>{{ conflicts.length }} 个离线文本冲突</strong>
      <p>已按“远端优先、本地保留”策略合并，可在日志中检查。</p>
    </section>

    <div class="thread-list">
      <button
        v-for="thread in shownThreads"
        :key="thread.id"
        type="button"
        class="thread-card"
        :class="[`thread-${thread.status}`, { active: thread.id === activeThreadId }]"
        @click="emit('activate', thread.id)"
      >
        <div class="thread-card-head">
          <span>{{ statusLabel(thread) }}</span>
          <small v-if="thread.migration?.confidence != null">{{ confidence(thread.migration.confidence) }}</small>
        </div>
        <p>{{ thread.anchor?.quote || thread.quote }}</p>
      </button>
    </div>

    <section v-if="active" class="thread-detail">
      <header>
        <h3>线程详情</h3>
        <span class="pill">{{ statusLabel(active) }}</span>
      </header>

      <blockquote v-if="active.statusNote" class="incompatible-note">{{ active.statusNote }}</blockquote>

      <div v-if="active.anchor" class="candidate-box">
        <p><strong>锚点：</strong>{{ active.anchor.quote }}</p>
        <p class="muted">
          基线 v{{ active.anchor.baselineRevision }} ·
          节点 {{ active.anchor.nodeRanges?.length || 0 }} 段 ·
          指纹 {{ active.resolution?.anchorFingerprint || '未解决' }}
        </p>
      </div>

      <div v-if="active.anchorChangedSinceResolution" class="warning">
        内容在解决后已改写：旧结论保留在历史中，可重新请求审阅。
      </div>

      <div v-if="active.statusConflict" class="warning">
        {{ active.statusConflict.note }}
      </div>

      <div v-if="active.status === 'dangling' || active.candidates?.length" class="candidates">
        <h4>候选定位（来源 / 置信说明）</h4>
        <article v-for="(candidate, index) in active.candidates || []" :key="index" class="candidate">
          <div>
            <strong>{{ candidate.source }}</strong>
            <span>{{ confidence(candidate.confidence) }}</span>
          </div>
          <p>{{ candidate.anchor.quote }}</p>
          <small>{{ candidate.note }}</small>
          <button type="button" @click.stop="emit('confirm', active.id, candidate)">确认此位置</button>
        </article>
        <p v-if="active.status === 'dangling'" class="muted">无法唯一对应，保留悬挂线程，不做文本搜索自动迁移。</p>
      </div>

      <ol class="event-list">
        <li v-for="event in active.events" :key="event.id" :class="`event-${event.type.split('.').pop()}`">
          <div>
            <strong>{{ eventLabel(event) }}</strong>
            <span>{{ event.actor }} · {{ new Date(event.createdAt).toLocaleTimeString() }}</span>
          </div>
          <p v-if="event.payload.body">{{ event.payload.body }}</p>
          <p v-if="event.payload.comment">{{ event.payload.comment }}</p>
          <p v-if="event.payload.note">{{ event.payload.note }}</p>
          <p v-if="event.payload.reason">{{ event.payload.reason }}</p>
          <small v-if="event.provisional" class="offline-tag">离线待同步</small>
        </li>
      </ol>

      <div v-if="!active.statusNote" class="detail-actions">
        <textarea v-model="replyDraft" placeholder="继续回复..." />
        <button type="button" @click="submitReply">回复</button>
        <button type="button" @click="emit('resolve', active.id)">解决</button>
        <button type="button" @click="emit('reopen', active.id)">重开</button>
        <button type="button" @click="emit('request-review', active.id, '内容已重写，请再次审阅')">重写后请求审阅</button>
      </div>
    </section>
  </aside>
</template>
