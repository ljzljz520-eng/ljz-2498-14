# 文稿审阅线程设计

## 1. 选定方案：基于版本差异重新定位

系统保存每个文稿版本的全文、父版本和内容哈希。创建批注时保存：

- 原始文稿字符区间（一个选区可能拆成多个 `ranges`）
- Markdown/预览节点提示（`nodeRanges`，仅作证据，不作为永久地址）
- 可见文本 `quote`
- 前后 80 字符压缩上下文
- 基线版本 `baselineRevision`
- 锚点协议版本 `schemaVersion: 2`

编辑提交后，服务端比较旧版本与新版本：

1. 行级 LCS 找到稳定行；
2. 对删除/插入区域识别唯一整行移动、相似行重写、重复文本；
3. 映射选区字符边界；
4. 结构映射失败时再使用引文和上下文生成候选；
5. 每个候选都记录 `source`、`confidence`、`note` 和证据。

自动迁移阈值为 `0.85`。重复引文通常只有约 `0.52`，上下文同时命中最高也限制在 `0.82`，因此不会“搜到同一句就迁移”。无候选或候选不足时写入 `thread.anchor_dangling`，线程保留为悬挂状态，等待人工确认。

## 2. OT 与版本差异的取舍

| 维度 | 操作变换 OT | 版本差异重定位 |
| --- | --- | --- |
| 协同编辑 | 低延迟位置变换成熟 | 需要等待版本提交 |
| 数据要求 | 所有客户端必须产生可组合操作 | 只需全文版本，粘贴/外部编辑器也可处理 |
| 批注语义 | 能回答“位置怎么变”，不擅长回答“是不是同一段内容” | 可同时利用移动、相似文本、引文、上下文 |
| 离线合并 | 需要操作历史和冲突变换 | 可用版本 DAG + 三方合并统一处理 |
| 错误恢复 | 错误操作可能传播到所有客户端 | 可保留原锚点和候选，人工裁决 |

本项目选择**版本差异重定位**。OT 可用于未来的多人光标同步，但不作为审阅结论的服务端事实来源。

## 3. 节点拆分

批注锚点使用文稿字符范围，节点范围只是提示。编辑后选区若从一个段落拆到多个段落或列表，重定位结果可生成多个 range：

```json
{
  "ranges": [
    { "start": 100, "end": 130, "startOffset": 92, "endOffset": 180 },
    { "start": 210, "end": 235, "startOffset": 205, "endOffset": 260 }
  ],
  "nodeRanges": []
}
```

候选必须解释所有片段，不能只匹配其中一段文本。

## 4. 事件流

SQL 中 `review_thread_events` 是唯一事实表，线程表只是投影：

- `thread.created`
- `thread.replied`
- `thread.resolved`
- `thread.reopened`
- `thread.review_requested`
- `thread.anchor_migrated`
- `thread.anchor_dangling`
- `thread.anchor_reanchored`
- `thread.status_conflict`

回复、解决、重开均只追加，不覆盖历史。`review_resolutions` 额外保存解决时的锚点指纹和引文。

## 5. 解决状态绑定被评阅内容

解决事件记录：

- `anchorFingerprint`
- 当时引文
- 解决人、时间和备注

之后段落移动或重写并自动迁移时，系统比较解决时的内容指纹与新锚点：如果被评阅内容已改变，线程重新打开并显示“解决后内容已改变”；`review_resolutions` 和原 `resolved` 事件仍保留。作者也可以显式发起 `review_requested` 请求新一轮结论。

## 6. 离线编辑合并

离线开始时记录：

```text
snapshot = (baseRevision, baseText, baseEvents)
local    = 本地文本和 provisional thread events
remote   = 离线期间服务端 head
```

重连执行文本三方合并：

1. base/local/remote 行级 LCS；
2. 双方都未改的 base 区域保留；
3. 只有一方修改则采用该方；
4. 双方改同一区域则记录冲突。演示策略是“远端入选、本地保留在 conflict 证据中”，真实产品可提供冲突解决 UI。

本地 provisional 的锚点迁移/悬挂事件全部丢弃，在合并文本上重新计算，防止旧客户端把过期坐标固化。回复事件通过 `client_event_id` 幂等追加。

## 7. 同时解决与重开

如果同一线程一方解决、另一方重开：

- 两个事件都保留；
- 合并时追加 `thread.status_conflict`；
- 投影状态为 `status-conflict`，策略为 `open-until-acknowledged`；
- 用户显式选择“保持解决”或“重新打开”后再追加新事件。

## 8. 旧前端保护

v2 响应包含：

```json
{
  "anchor": { "schemaVersion": 2 },
  "anchorMigratedAt": "..."
}
```

v1 客户端读取到更高版本或已迁移标记时，不能用缓存的 `(nodeId,start,end)` 绘制，也不能搜索同一句后自行重锚；必须显示“需要升级/不可锚定”。服务端触发器拒绝 v1 客户端在迁移后提交 pre-v2 锚点。
