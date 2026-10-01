<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import PreviewView from './components/PreviewView.vue'
import ThreadPanel from './components/ThreadPanel.vue'
import { buildVisibleState, sourceRangeFromVisible } from './utils/catalpaModel'
import { selectionToSourceRange, clearWindowSelection } from './utils/selection'
import { reviewServer, legacyPayloadGuard } from './services/mockReviewServer'
import { mergeClock, tick } from './utils/vectorClock'

const initialDoc = `# Catalpa 审阅编辑器

欢迎使用 **Catalpa 实时预览**。

## 基础语法
- 支持标题、列表、引用
- 支持 *斜体* 与 **粗体**
- 支持 [链接](https://vuejs.org/)

> 右侧预览会跟随左侧编辑器实时更新。

### 代码块
\`\`\`js
const message = "Hello Catalpa"
console.log(message)
\`\`\`
`

const source = ref(initialDoc)
const snapshot = ref(reviewServer.getSnapshot())
const previewRef = ref(null)
const selectedRange = ref(null)
const activeThreadId = ref('')
const newComment = ref('')
const syncedVersion = ref(1)
const online = ref(true)
const legacyEpoch = ref(2)
const outbox = ref([])
const suppressCommit = ref(false)
let commitTimer = null

const visibleState = computed(() => buildVisibleState(source.value))
const blocks = computed(() => visibleState.value.blocks)
const lineCount = computed(() => source.value.split(/\r?\n/).length)
const charCount = computed(() => source.value.length)
const activeThread = computed(() => snapshot.value.threads.find((thread) => thread.threadId === activeThreadId.value))

const visibleAnchors = computed(() => {
  if (legacyEpoch.value < 2) return []
  return snapshot.value.threads
    .filter((thread) => thread.anchor
      && thread.anchor.documentVersion === snapshot.value.document.version
      && !['candidate', 'detached'].includes(thread.status))
    .map((thread) => ({
      threadId: thread.threadId,
      sourceRange: thread.anchor.sourceRange,
      status: thread.status,
    }))
})

const legacyGuard = computed(() => {
  const guarded = snapshot.value.threads.find((thread) => !legacyPayloadGuard(thread, legacyEpoch.value).ok)
  return guarded ? legacyPayloadGuard(guarded, legacyEpoch.value) : { ok: true }
})

watch(source, () => {
  if (suppressCommit.value || !online.value) return
  clearTimeout(commitTimer)
  commitTimer = setTimeout(commitOnline, 700)
})

onMounted(() => {
  resetDemo()
  reviewServer.subscribe(handleServerUpdate)
})

onBeforeUnmount(() => reviewServer.unsubscribe?.(handleServerUpdate))

function handleServerUpdate(next) {
  snapshot.value = next
  syncedVersion.value = next.document.version
}

function resetDemo() {
  clearTimeout(commitTimer)
  outbox.value = []
  online.value = true
  suppressCommit.value = true
  const next = reviewServer.reset(initialDoc)
  snapshot.value = next
  source.value = initialDoc
  syncedVersion.value = 1
  const quote = '欢迎使用 Catalpa 实时预览。'
  const initialVisible = buildVisibleState(initialDoc)
  const visibleStart = initialVisible.text.indexOf(quote)
  const createdSourceRange = sourceRangeFromVisible(initialVisible, visibleStart, visibleStart + quote.length)
  const created = reviewServer.createThread({
    sourceRange: createdSourceRange,
    body: '这段欢迎语需要确认产品名称的强调方式。',
    baseVersion: 1,
  })
  snapshot.value = reviewServer.getSnapshot()
  activeThreadId.value = created.thread.threadId
  suppressCommit.value = false
}

function commitOnline() {
  if (!online.value) return
  snapshot.value = reviewServer.commitDocument({
    source: source.value,
    baseVersion: syncedVersion.value,
    mode: 'online',
  })
  source.value = snapshot.value.document.source
  syncedVersion.value = snapshot.value.document.version
}

function commitNow() {
  clearTimeout(commitTimer)
  commitOnline()
}

function onPreviewMouseUp(event) {
  if (event.target.closest('[data-comment-ui="true"]')) return
  window.setTimeout(() => {
    const range = selectionToSourceRange(previewRef.value, visibleState.value)
    if (!range) {
      selectedRange.value = null
      return
    }
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect()
    const container = previewRef.value.getBoundingClientRect()
    selectedRange.value = {
      ...range,
      x: rect.left - container.left + rect.width / 2,
      y: rect.top - container.top - 8,
      quote: source.value.slice(range.start, range.end),
    }
  }, 0)
}

function createComment() {
  if (!selectedRange.value || !newComment.value.trim()) return
  const result = reviewServer.createThread({
    sourceRange: { start: selectedRange.value.start, end: selectedRange.value.end },
    body: newComment.value.trim(),
    baseVersion: syncedVersion.value,
  })
  activeThreadId.value = result.thread.threadId
  newComment.value = ''
  selectedRange.value = null
  clearWindowSelection()
  snapshot.value = reviewServer.getSnapshot()
}

function replaceCurrentQuote(nextText) {
  const thread = snapshot.value.threads[0]
  const range = thread?.anchor?.sourceRange
  if (!range) return source.value
  return `${source.value.slice(0, range.start)}${nextText}${source.value.slice(range.end)}`
}

function moveCurrentParagraph() {
  const lines = source.value.split(/\r?\n/)
  const index = lines.findIndex((line) => line.includes('欢迎使用'))
  if (index < 0) return
  const [line] = lines.splice(index, 1)
  lines.push('', line)
  applyScenario(lines.join('\n'), '整段移动')
}

function duplicateQuote() {
  const thread = snapshot.value.threads[0]
  const range = thread?.anchor?.sourceRange
  if (!range) return
  const copied = source.value.slice(range.start, range.end).replace(/\*\*/g, '')
  applyScenario(`${source.value.replace(/\n+$/, '')}\n\n${copied}\n`, '复制同文')
}

function deleteSelection() {
  applyScenario(replaceCurrentQuote('这处内容已被作者删除。'), '删除选区')
}

function rewriteSelection() {
  applyScenario(replaceCurrentQuote('欢迎使用全新的 Catalpa 协作审阅工作流。'), '重写原句')
}

function splitSelectionAcrossNodes() {
  applyScenario(replaceCurrentQuote('欢迎使用\n\n**Catalpa 实时预览**。'), '拆分节点')
}

function applyScenario(nextSource, label) {
  if (!online.value) {
    source.value = nextSource
    return
  }
  clearTimeout(commitTimer)
  const result = reviewServer.commitDocument({
    source: nextSource,
    baseVersion: syncedVersion.value,
    mode: label,
  })
  source.value = result.document.source
  snapshot.value = result
  syncedVersion.value = result.document.version
}

function goOffline() {
  online.value = false
  outbox.value = []
}

function remoteEdit() {
  const nextSource = `${source.value}\n\n远端补充：离线期间由另一位审阅人添加。`
  const result = reviewServer.commitDocument({
    source: nextSource,
    baseVersion: syncedVersion.value,
    actorId: 'reviewer-remote',
    mode: 'remote-edit',
  })
  snapshot.value = result
}

function remoteResolve() {
  const threadId = activeThreadId.value || snapshot.value.threads[0]?.threadId
  if (threadId) reviewServer.resolveThread(threadId, '远端审阅人认为已解决', 'reviewer-remote')
  snapshot.value = reviewServer.getSnapshot()
}

function remoteReopen() {
  const threadId = activeThreadId.value || snapshot.value.threads[0]?.threadId
  if (threadId) reviewServer.reopenThread(threadId, '远端审阅人要求补充说明', 'reviewer-remote')
  snapshot.value = reviewServer.getSnapshot()
}

function queueOfflineReply() {
  const threadId = activeThreadId.value || snapshot.value.threads[0]?.threadId
  queueEvent(threadId, 'thread.reply', { body: '离线回复：联网后追加，不覆盖远端结论。', actorId: 'offline-a' })
}

function queueOfflineResolve() {
  const threadId = activeThreadId.value || snapshot.value.threads[0]?.threadId
  const thread = snapshot.value.threads.find((item) => item.threadId === threadId)
  queueEvent(threadId, 'thread.resolved', {
    body: '离线端标记解决',
    actorId: 'offline-a',
    contentHash: thread?.anchor?.quote?.hash || null,
  })
}

function queueOfflineReopen() {
  const threadId = activeThreadId.value || snapshot.value.threads[0]?.threadId
  queueEvent(threadId, 'thread.reopened', { body: '离线端要求重开', actorId: 'offline-a' })
}

function queueEvent(threadId, type, payload) {
  const baseClock = mergeClock({}, snapshot.value.threads.find((item) => item.threadId === threadId)?.events.at(-1)?.clock || {})
  outbox.value.push({ threadId, type, payload, clock: tick(baseClock, payload.actorId) })
}

function goOnlineAndSync() {
  const baseVersion = syncedVersion.value
  const result = reviewServer.commitDocument({
    source: source.value,
    baseVersion,
    actorId: 'offline-a',
    mode: 'offline',
    baseClock: outbox.value[0]?.clock,
  })
  for (const item of outbox.value) {
    reviewServer.addEvent(item.threadId, item.type, item.payload, {
      actorId: item.payload.actorId,
      clock: item.clock,
    })
  }
  outbox.value = []
  online.value = true
  snapshot.value = reviewServer.getSnapshot()
  source.value = snapshot.value.document.source
  syncedVersion.value = snapshot.value.document.version
}

function onThreadAction(eventName, payload) {
  const map = {
    reply: (item) => reviewServer.reply(item.threadId, item.body),
    resolve: (threadId) => reviewServer.resolveThread(threadId),
    reopen: (threadId) => reviewServer.reopenThread(threadId),
    'request-review': (threadId) => reviewServer.requestReview(threadId, '内容已重写，请审阅新版本'),
    'accept-candidate': (item) => reviewServer.acceptCandidate(item.threadId, item.candidateId),
    'reject-candidates': (threadId) => reviewServer.rejectCandidates(threadId, '所有候选均不是原批注对象'),
  }
  const target = typeof payload === 'string' ? payload : payload.threadId
  const detail = typeof payload === 'object' ? payload : undefined
  map[eventName](target, detail)
  if (detail?.target) detail.target.value = ''
  snapshot.value = reviewServer.getSnapshot()
}
</script>

<template>
  <div class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">Vue 3 + Vite · Event Sourced Review</p>
        <h1>Catalpa 文稿审阅线程</h1>
        <p class="subtitle">预览选区创建批注；版本差异、节点指纹、上下文与候选置信度共同决定锚点迁移。</p>
      </div>
      <div class="stats">
        <span>{{ lineCount }} 行</span>
        <span>{{ charCount }} 字符</span>
        <span :class="['connection', online ? 'on' : 'off']">{{ online ? '在线' : `离线 · ${outbox.length} 个待同步事件` }}</span>
      </div>
    </header>

    <div class="scenario-bar" data-comment-ui="true">
      <button type="button" @click="moveCurrentParagraph">整段移动</button>
      <button type="button" @click="duplicateQuote">引文多处相同</button>
      <button type="button" @click="splitSelectionAcrossNodes">选区拆成多节点</button>
      <button type="button" @click="deleteSelection">删除选区</button>
      <button type="button" @click="rewriteSelection">重写原句</button>
      <span class="scenario-divider" />
      <button type="button" :disabled="online" @click="remoteEdit">远端改稿</button>
      <button type="button" :disabled="online" @click="remoteResolve">远端解决</button>
      <button type="button" :disabled="online" @click="remoteReopen">远端重开</button>
      <button type="button" :disabled="online" @click="queueOfflineReply">离线回复</button>
      <button type="button" :disabled="online" @click="queueOfflineResolve">离线解决</button>
      <button type="button" :disabled="online" @click="queueOfflineReopen">离线重开</button>
      <button v-if="online" type="button" @click="goOffline">进入离线</button>
      <button v-else type="button" class="primary" @click="goOnlineAndSync">联网合并</button>
      <label class="legacy-toggle"><input type="checkbox" :checked="legacyEpoch === 1" @change="legacyEpoch = $event.target.checked ? 1 : 2" />模拟旧前端</label>
    </div>

    <main class="workspace review-workspace">
      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>编辑区 · 基线 v{{ syncedVersion }}</h2>
          <div class="actions">
            <button class="ghost-btn" type="button" @click="commitNow">立即提交</button>
            <button class="ghost-btn danger" type="button" @click="resetDemo">重置演示</button>
          </div>
        </div>
        <textarea v-model="source" class="editor" spellcheck="false" />
      </section>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2>可锚定预览</h2>
          <span v-if="!legacyGuard.ok" class="warning">旧前端隐藏已迁移批注：{{ legacyGuard.reason }}</span>
        </div>
        <article ref="previewRef" class="preview markdown-body" @mouseup="onPreviewMouseUp">
          <PreviewView :blocks="blocks" :anchors="visibleAnchors" />
          <div v-if="selectedRange" class="comment-popover" :style="{ left: `${selectedRange.x}px`, top: `${selectedRange.y}px` }" data-comment-ui="true">
            <blockquote>{{ selectedRange.quote }}</blockquote>
            <textarea v-model="newComment" rows="3" placeholder="说明批注内容..." />
            <div>
              <button type="button" class="primary" @click="createComment">创建批注</button>
              <button type="button" @click="selectedRange = null">取消</button>
            </div>
          </div>
        </article>
      </section>

      <ThreadPanel
        :threads="snapshot.threads"
        :active-thread-id="activeThreadId"
        :legacy-epoch="legacyEpoch"
        @select="activeThreadId = $event"
        @reply="onThreadAction('reply', $event)"
        @resolve="onThreadAction('resolve', $event)"
        @reopen="onThreadAction('reopen', $event)"
        @request-review="onThreadAction('request-review', $event)"
        @accept-candidate="onThreadAction('accept-candidate', $event)"
        @reject-candidates="onThreadAction('reject-candidates', $event)"
      />
    </main>
  </div>
</template>
