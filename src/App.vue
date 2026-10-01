<script setup>
import { computed, ref } from 'vue'
import PreviewDocument from './components/PreviewDocument.vue'
import ReviewPanel from './components/ReviewPanel.vue'
import { parseCatalpaBlocks } from './review/catalpaBlocks.js'
import { domSelectionToSourceRange } from './review/selection.js'
import { useReviewStore } from './review/store.js'

const initialDoc = `# 文稿审阅演示

第一段写审阅的锚点基线。请选中“需要精确迁移的关键结论”创建批注。

## 场景段落
- 整段移动后仍要保持线程
- 相同引文可以复制到多处
- 删除选区后线程必须悬挂等待确认

> 需要精确迁移的关键结论：候选定位必须带来源与置信说明。

同一句话也可能在别处重复，客户端不能只搜索文本就自动迁移。
`

const {
  source,
  state,
  threads,
  commitCurrentEdit,
  createThread,
  reply,
  resolve,
  reopen,
  requestReview,
  confirmCandidate,
  setOffline,
  moveParagraphRemote,
  duplicateQuoteRemote,
  deleteSelectionRemote,
  prepareRemoteResolveForOfflineConflict,
  setSelection,
  setClientSchema
} = useReviewStore(initialDoc)

const previewEl = ref(null)
const selectionError = ref('')
const lineCount = computed(() => source.value.split(/\n/).length)
const charCount = computed(() => source.value.length)
const blocks = computed(() => parseCatalpaBlocks(source.value))

function captureSelection() {
  selectionError.value = ''
  const range = domSelectionToSourceRange(previewEl.value)
  if (!range) {
    selectionError.value = '请在右侧预览区选择可见文字。'
    return
  }
  setSelection({ start: range.start, end: range.end })
}

function handleCreate(selection, body) {
  try {
    createThread(selection, blocks.value, body)
  } catch (error) {
    selectionError.value = error.message
  }
}

function clearAll() {
  source.value = ''
}
</script>

<template>
  <div class="page review-page">
    <header class="hero compact">
      <div>
        <p class="eyebrow">Vue 3 · Event Sourced Review Threads</p>
        <h1>文稿审阅线程</h1>
        <p class="subtitle">
          预览选区创建批注；保存节点范围、可见引文、上下文与文稿基线，编辑后用版本差异重定位。
        </p>
      </div>
      <div class="stats">
        <span>v{{ state.revision }}</span>
        <span>{{ lineCount }} 行</span>
        <span>{{ charCount }} 字符</span>
      </div>
    </header>

    <section class="scenario-bar">
      <label>
        <input type="checkbox" :checked="state.offline" @change="setOffline(($event.target).checked)" />
        离线模式
      </label>
      <button type="button" @click="commitCurrentEdit">提交当前编辑</button>
      <button type="button" @click="moveParagraphRemote">远端：整段移动</button>
      <button type="button" @click="duplicateQuoteRemote">远端：复制相同引文</button>
      <button type="button" @click="deleteSelectionRemote">远端：删除选区</button>
      <button type="button" @click="prepareRemoteResolveForOfflineConflict">离线冲突准备：远端解决</button>
      <label class="schema-switch">
        前端锚点协议
        <select :value="state.clientAnchorSchema" @change="setClientSchema(Number($event.target.value))">
          <option :value="2">v2 当前前端</option>
          <option :value="1">v1 旧前端</option>
        </select>
      </label>
      <button type="button" class="danger" @click="clearAll">清空</button>
    </section>

    <p v-if="selectionError" class="error-banner">{{ selectionError }}</p>

    <main class="review-workspace">
      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>编辑区</h2>
          <small>编辑后点击“提交当前编辑”触发服务端版本</small>
        </div>
        <textarea
          v-model="source"
          class="editor"
          spellcheck="false"
          @input="selectionError = ''"
        />
      </section>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2>可审阅预览</h2>
          <button type="button" @mouseup="captureSelection" class="capture-hint">选择文字后点此创建</button>
        </div>
        <div ref="previewEl" class="preview-scroll" @mouseup="captureSelection">
          <PreviewDocument
            :blocks="blocks"
            :threads="threads"
            :active-thread-id="state.activeThreadId"
            @select-thread="state.activeThreadId = $event"
          />
        </div>
      </section>

      <ReviewPanel
        :threads="threads"
        :events="state.events"
        :active-thread-id="state.activeThreadId"
        :pending-selection="state.pendingSelection"
        :client-schema="state.clientAnchorSchema"
        :conflicts="state.conflicts"
        @create="handleCreate"
        @reply="reply"
        @resolve="resolve"
        @reopen="reopen"
        @request-review="requestReview"
        @confirm="confirmCandidate"
        @activate="state.activeThreadId = $event"
      />
    </main>

    <section class="event-log">
      <h2>服务端事件 / 合并日志</h2>
      <ul>
        <li v-for="(item, index) in state.log" :key="index">{{ item }}</li>
      </ul>
    </section>
  </div>
</template>
