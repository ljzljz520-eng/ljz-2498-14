import { computed, reactive, ref } from 'vue'
import { ANCHOR_SCHEMA_VERSION, buildAnchorFromSelection } from './anchor.js'
import { relocateAnchor } from './diff.js'
import { THREAD_EVENTS, mergeEvents, projectThreads } from './events.js'
import { syncMerge } from './graph.js'
import { fingerprintAnchor, hashText, uniqueId } from './ids.js'

export function useReviewStore(initialSource) {
  const source = ref(initialSource)
  const state = reactive({
    revision: 1,
    baseHash: hashText(initialSource),
    offline: false,
    threads: [],
    events: [],
    activeThreadId: '',
    draft: '',
    pendingSelection: null,
    conflicts: [],
    log: ['初始化：保存节点范围、引文上下文和文稿基线 v1'],
    clientAnchorSchema: ANCHOR_SCHEMA_VERSION,
    branchSnapshot: null,
    remoteHeadWhileOffline: null,
    localSequence: 0
  })

  const threads = computed(() => state.threads)
  const visibleEvents = computed(() => state.events)

  function now() {
    return new Date().toISOString()
  }

  function addLog(message) {
    state.log.unshift(`v${state.revision} ${new Date().toLocaleTimeString()} · ${message}`)
  }

  function makeEvent(threadId, type, payload = {}, actor = '当前审阅者', provisional = false) {
    state.localSequence += 1
    return {
      id: uniqueId('evt'),
      documentId: 'doc-demo',
      threadId,
      type,
      actor,
      createdAt: now(),
      seq: null,
      revision: state.revision,
      clientEventId: uniqueId('client'),
      provisional,
      payload
    }
  }

  function reproject(events) {
    state.events = mergeEvents([], events)
    state.threads = projectThreads(state.events)
  }

  let committedText = initialSource

  function commitCurrentEdit(reason = '提交编辑：服务端基于版本差异重定位锚点') {
    const text = source.value
    if (text === committedText) return
    if (state.offline) {
      committedText = text
      state.revision += 1
      state.baseHash = hashText(text)
      addLog('离线编辑已写入本地分支；锚点结论等待合并时重算')
      return
    }
    commitLocalText(text, committedText, reason)
    committedText = text
  }

  function commitLocalText(text, oldText, reason) {
    if (oldText === text) return
    source.value = text
    state.revision += 1
    state.baseHash = hashText(text)
    const generated = []
    for (const thread of state.threads) {
      if (!thread.anchor) continue
      const result = relocateAnchor(thread.anchor, oldText, text)
      const next = result.status === 'anchored' ? result.candidates[0] : null
      generated.push(makeEvent(
        thread.id,
        result.status === 'anchored' ? THREAD_EVENTS.ANCHOR_MIGRATED : THREAD_EVENTS.ANCHOR_DANGLING,
        result.status === 'anchored'
          ? {
              anchor: { ...next.anchor, baselineRevision: state.revision },
              confidence: next.confidence,
              source: next.source,
              note: next.note,
              candidates: result.candidates
            }
          : { reason: result.reason, candidates: result.candidates },
        'system'
      ))
    }
    reproject(state.events.concat(generated))
    addLog(reason)
  }

  function createThread(selection, blocks, comment) {
    if (!comment.trim()) throw new Error('请填写批注内容')
    const anchor = buildAnchorFromSelection(source.value, selection.start, selection.end, state.revision, blocks)
    const threadId = uniqueId('thread')
    const created = makeEvent(threadId, THREAD_EVENTS.CREATED, {
      anchor,
      quote: anchor.quote,
      comment: comment.trim(),
      resolutionPolicy: 'status-bound-to-anchor-fingerprint'
    })
    reproject(state.events.concat(created))
    state.activeThreadId = threadId
    state.pendingSelection = null
    state.draft = ''
    addLog('创建审阅线程：事件流保存首条结论，状态绑定被评阅内容')
    return threadId
  }

  function appendThreadEvent(threadId, type, payload, actor = '当前审阅者') {
    const event = makeEvent(threadId, type, payload, actor, state.offline)
    reproject(state.events.concat(event))
    return event
  }

  function reply(threadId, body) {
    if (!body.trim()) return
    appendThreadEvent(threadId, THREAD_EVENTS.REPLIED, { body: body.trim() })
    state.draft = ''
    addLog(state.offline ? '离线回复已加入本地分支（client_event_id 幂等）' : '回复已追加；不更新锚点')
  }

  function resolve(threadId, note = '', actor = '当前审阅者') {
    const thread = state.threads.find((item) => item.id === threadId)
    appendThreadEvent(threadId, THREAD_EVENTS.RESOLVED, {
      note,
      anchorFingerprint: fingerprintAnchor(thread.anchor),
      quote: thread.anchor?.quote
    }, actor)
    addLog('解决事件记录当时内容指纹；后续改写不会删除旧结论')
  }

  function reopen(threadId, reason = '', actor = '当前审阅者') {
    appendThreadEvent(threadId, THREAD_EVENTS.REOPENED, { reason }, actor)
    addLog('重开事件已追加，历史解决结论仍保留')
  }

  function requestReview(threadId, reason) {
    appendThreadEvent(threadId, THREAD_EVENTS.REVIEW_REQUESTED, { reason }, '作者')
    addLog('原句重写后重新请求审阅；旧 resolved 事件保留在历史中')
  }

  function confirmCandidate(threadId, candidate) {
    const event = makeEvent(threadId, THREAD_EVENTS.ANCHOR_REANCHORED, {
      anchor: { ...candidate.anchor, baselineRevision: state.revision },
      confidence: candidate.confidence,
      source: candidate.source,
      note: `人工确认：${candidate.note}`,
      restoreStatus: 'open'
    }, '当前审阅者')
    reproject(state.events.concat(event))
    addLog('人工确认候选位置，悬挂线程重新锚定')
  }

  function setOffline(value) {
    if (value === state.offline) return
    state.offline = value
    if (value) {
      state.branchSnapshot = { revision: state.revision, text: source.value, events: state.events }
      state.remoteHeadWhileOffline = { revision: state.revision, text: source.value, events: state.events }
      addLog('进入离线：本地以修订 DAG 分支保存编辑与回复')
    } else if (state.branchSnapshot) {
      const localBranch = { revision: state.revision, text: source.value, events: state.events }
      const remoteHead = state.remoteHeadWhileOffline || state.branchSnapshot
      const merged = syncMerge(state.branchSnapshot, localBranch, remoteHead, {
        documentId: 'doc-demo',
        createId: uniqueId
      })
      source.value = merged.text
      state.revision = merged.revision
      state.baseHash = hashText(merged.text)
      state.conflicts = merged.conflicts
      reproject(merged.events)
      committedText = merged.text
      state.branchSnapshot = null
      state.remoteHeadWhileOffline = null
      addLog(`离线分支已合并为 v${merged.revision}；${merged.conflicts.length} 个文本冲突，状态冲突保持打开待确认`)
    }
  }

  function moveParagraphRemote() {
    const paragraphs = source.value.split(/\n\s*\n/)
    if (paragraphs.length < 2) return
    const [first, ...rest] = paragraphs
    const moved = rest[0]
    rest.shift()
    const next = [moved, first, ...rest].join('\n\n')
    receiveRemoteText(next, '服务端模拟：整段移动；唯一块使用结构差异自动迁移')
  }

  function duplicateQuoteRemote() {
    const firstThread = state.threads.find((thread) => thread.anchor)
    if (!firstThread) return
    const quote = firstThread.anchor.quote
    const next = `> ${quote}\n\n${source.value}`
    receiveRemoteText(next, '服务端模拟：相同引文被复制到别处；只生成低置信候选')
  }

  function deleteSelectionRemote() {
    const thread = state.threads.find((item) => item.anchor)
    if (!thread) return
    const range = thread.anchor.ranges[0]
    const next = `${source.value.slice(0, range.start)}${source.value.slice(range.end)}`
    receiveRemoteText(next, '服务端模拟：选区删除；无唯一候选时线程悬挂')
  }

  function receiveRemoteText(next, reason) {
    if (state.offline) {
      state.remoteHeadWhileOffline = {
        revision: state.remoteHeadWhileOffline.revision + 1,
        text: next,
        events: state.remoteHeadWhileOffline.events
      }
      addLog('离线期间收到远端新版本，等待三方合并')
      return
    }
    commitLocalText(next, committedText, reason)
    committedText = next
  }

  function prepareRemoteResolveForOfflineConflict() {
    const thread = state.threads[0]
    if (!thread) return
    if (state.offline) {
      const resolve = {
        ...makeEvent(thread.id, THREAD_EVENTS.RESOLVED, {
          anchorFingerprint: fingerprintAnchor(thread.anchor),
          quote: thread.anchor?.quote,
          note: '离线期间由远端解决'
        }, '服务端审阅者'),
        provisional: false
      }
      state.remoteHeadWhileOffline.events = state.remoteHeadWhileOffline.events.concat(resolve)
      addLog('离线期间远端解决线程；本地随后可点击“重开”制造冲突')
      return
    }
    resolve(thread.id, '远端先解决', '服务端审阅者')
  }

  function setSelection(selection) {
    state.pendingSelection = selection
  }

  function setClientSchema(version) {
    state.clientAnchorSchema = version
  }

  return {
    source,
    state,
    threads,
    visibleEvents,
    commitCurrentEdit,
    commitLocalText,
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
  }
}
