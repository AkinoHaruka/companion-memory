---
description: "DeepSeek Harness 原生作用域记忆插件。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-riko-memory

[English](README.md) | 中文

## Summary

这是一个按稳定 Agent preset 隔离、使用 DSH storage-domain 持久化、要求显式确认、以 Wiki 为长期权威并用有界 Resident 注入提示词的原生 DSH 记忆插件。密钥只来自 credentials 或进程环境，控制面和验收脚本都受限且脱敏。

## 这是什么

`@deepseek-ai/dsh-riko-memory` 是 Riko 风格作用域长期记忆在新版 DeepSeek Harness 上的原生实现。它直接接入 DSH 的 Cordis 插件加载、Session 事件、稳定 Agent preset、`storageDomain`、system prompt 注入、显式工具、credentials 和后台 job。它不是 MCP memory server，不是第二套 SQLite 服务，也不是通用文件存储适配器。

这个插件只有一个严格承诺：一条记忆只有在拥有可追溯来源、通过 scope 边界、进入权威 Wiki 状态机并被选入有界 Resident Snapshot 后，才可能影响后续回答。模型输出本身永远不是权威。

唯一源码源头是 DSH Harness worktree 中的 `packages/bundle/riko-memory`。GitHub 仓库 [AkinoHaruka/companion-memory](https://github.com/AkinoHaruka/companion-memory) 是这个 bundle 的用户侧源码镜像。旧 standalone 实现和历史根目录副本仅用于迁移参考，不再作为平行运行时。

## 总体方案与数据流

```text
User conversation
  -> DSH session/event listener
  -> L0 evidence: sessionId + event sequence + source span
  -> explicit tool or background Dream
  -> L1 Candidate: proposal with provenance and consent state
  -> original user evidence or explicit management action
  -> L2 canonical Wiki page: durable, versioned authority
  -> Resident compiler
  -> L3 Resident Snapshot: bounded prompt projection
  -> next request for the same stable Agent preset
```

| 层级 | 名称 | 作用 | 是否直接进入提示词 |
|---|---|---|---|
| L0 | Session evidence | 实际说过什么，以及事件来源 | 否 |
| L1 | Candidate | 提取器建议记住什么，等待审核 | 否 |
| L2 | Wiki | 长期权威页面、版本、关系、来源、过期和审计血缘 | 间接 |
| L3 | Resident Snapshot | 从当前 L2 页面编译出的有界提示词投影 | 是 |

四层回答四个不同问题：L0 是“发生了什么”；L1 是“模型建议了什么”；L2 是“什么已经被接受为长期记忆”；L3 是“现在什么内容既安全又有用”。Resident 可重建、可替换；Wiki 才是长期权威。

## 目标与明确不做的事情

### 目标

- 让同一个稳定 Agent preset 下的多个 Session 共享长期记忆。
- 隔离不同 owner、preset 和 HTTP profile。
- 保留 Session、事件和来源信息，使每个页面都可审计。
- Dream 产物必须经过明确证据或显式管理操作，才能进入权威 Wiki。
- 保持聊天热路径同步且有界：读 Resident 不调用 Dream、不扫描完整 Wiki、不等待后台锁。
- 让 provider、解析、存储、Resident 编译和宿主重启失败都可恢复。
- 让凭据离开源码、设置 JSON 和普通管理请求体。
- 用 UI 展示 Wiki、候选、来源、Session 和图谱，允许人工复核。

### v1 明确不做

- embedding、向量搜索、语义近邻召回或第二套检索数据库。
- 多节点协调、公网多租户部署和分布式 job ownership。
- 完整 raw Session 删除或所有证据记录的加密擦除。
- 把每一句对话都当成记忆。
- 允许模型生成“请记住这个”来自己给自己授权。
- 用 Fastify、固定文件路径、`node:sqlite`、MCP runtime 或 Rust sidecar 替换 DSH 的生命周期和存储模型。

## Scope 与隔离规则

长期记忆的唯一作用域键是：

```text
MemoryScope = ownerNamespace + stableAgentPresetId
```

`ownerNamespace` 表示安装实例或租户边界，`stableAgentPresetId` 表示要共享这份记忆的 DSH Agent preset。Session ID 只是来源证据，不是长期共享键。

规则如下：

1. 同一个 owner、同一个稳定 preset 下的 Session A 和 Session B 共享同一套 Wiki 与 Resident。
2. 同一个 owner 下的不同 stable preset 互相不可见。
3. preset 缺失或不稳定时 fail-closed，不回退到默认全局 profile。
4. HTTP profile、bearer token、Session 和 storage record 必须解析到同一个 scope。
5. 模型不能通过虚构外部 Session ID、profile 名称或来源引用扩大权限。

这里的“全局记忆”不是所有 Agent 共用，而是“同一个稳定 Agent preset 内跨 Session、跨项目共享”；原始 Session 证据仍属于自己的来源上下文。

## 版本化数据契约

核心类型都带 schema 和 scope 信息：

- `MemoryScope`：`schemaVersion`、owner namespace、stable preset 和确定性 scope key。
- `EvidenceRef`：`schemaVersion`、Session ID、事件序号和可选 source span。
- `MemoryCandidate`：scope、内容、状态、同意、证据、来源（`dream` 或 `manual`）、时间、过期和 supersede 信息。
- `WikiPage`：权威正文、版本、状态、同意、证据、来源候选、更新时间和过期时间。
- `ResidentSnapshot`：有界内容、版本、生成时间、scope 和来源 page IDs。
- `DreamJob`：scope、Session、事件 cursor、状态、尝试次数、时间戳和脱敏错误。

Provider 输出不能自己制造有授权的 `EvidenceRef`，当前 DSH event stream 才是来源真相。

## 完整生命周期

### 1. 捕获 L0 证据

插件监听 DSH Session 事件，把受限的序列化证据写入配置的 `storageDomain`。每条记录保留 Session 身份、事件序号和来源信息。scope 在捕获时确定，不会因为模型输出而重新归属。

### 2. 选择写入路径

系统有两条路径：

- 显式路径：用户直接要求 Agent 记住、更正或忘记。工具会校验当前原始用户消息，并立即执行对应状态迁移。
- Dream 路径：Session 活动结束后，带 debounce 的后台 job 按 cursor 消费证据，请 provider 生成结构化 Wiki 文件。Dream 异步执行，不能阻塞正常回答。

### 3. 生成 Candidate

Dream 使用受控 FILE 协议，只接受允许的 `wiki/` 目录。解析器拒绝非法或空 block，忽略模型伪造的来源权威，规范化标题与 wikilink，限制摘要和正文长度，并强制把每个提取页面设为 `candidate`、同意状态设为 pending。

重复候选使用 fingerprint 去重和合并，保留来源会话集合与较高置信度，避免不断生成重复页面。

### 4. 确认或拒绝

确认权威只有两种：

- 原始用户证据：显式工具要求 claim 或 replacement text 出现在当前 Session 最新原始用户消息中。
- 显式管理操作：管理员通过控制 API 确认、拒绝、编辑或创建权威页面。

Provider 返回的 `status: confirmed`、`consent: true`、`locked: true`，或者模型自己写出的“用户让我记住”，都不会授予确认权。

### 5. 写入权威 Wiki

确认会创建或更新带版本的 Wiki 页面，记录来源血缘并移除对应 pending Candidate。更正保留旧版本的审计链。Supersede 会让页面从后续 Resident 消失，但保留页面和来源供审计。

### 6. 编译和注入 Resident

只有 confirmed、已同意、未 supersede 且未过期的页面参与编译。source 页面、pending Candidate 和原始 Transcript 不进入聊天热路径。结果按规则排序，受 `maxResidentChars` 限制，生成内容版本号并持久化使用过的 page IDs。DSH 只把当前稳定 preset 的 Resident 作为标记为“记忆数据”的 system context 注入，而不是当作指令。

## 四个显式工具

### `memory_get_resident`

读取当前稳定 Agent preset 的 Resident 和版本号。缺少 preset 时拒绝读取；它是只读热路径操作，不调用 Dream。

### `memory_remember`

把一条明确偏好或事实作为 managed、confirmed memory 保存。内容必须非空，并且必须出现在当前 Session 最新原始用户消息中。模型推断或从其他 Session 复制的内容不能写入。

### `memory_correct`

在验证替换内容出现在当前原始用户消息后，更正指定 Wiki 页面的用户可见内容。页面继续保持 confirmed，版本与审计血缘保留，Resident 立即重建。

### `memory_forget`

要求最新用户消息包含“忘记”“删除”“forget”“remove”等明确删除意图，并包含准确 memory ID。它从后续 Resident 移除派生 Wiki 记忆并记录操作；v1 不删除原始 raw Session 证据。

## Dream 后台管线与 Provider 行为

Dream 是可恢复的后台整理器，不是长期记忆的权威来源。

1. `turn/end` 和手动触发在证据写入 barrier 之后排队。
2. 同一个 scope 内串行执行，不同 scope 可以并行。
3. 持久化 cursor 防止重复消费，持久化 job 支持重启恢复。
4. Transcript 有字符上限，Provider 只被要求生成少量简短页面。
5. OpenRouter 等 OpenAI-compatible endpoint 使用 Chat Completions；小米 MiMo 等 Anthropic-compatible endpoint 使用 Anthropic Messages，协议由 endpoint 形态推断。
6. 请求使用有界标准字段，credential 不放入 URL；原生后台请求超时 120 秒，HTTP 429 最多一次有界重试。
7. 响应必须先通过严格 FILE 解析再持久化。非法 block、空响应、非预期 JSON 和 provider 错误都只让 job 失败，不替换旧 Wiki 或 Resident。
8. 系统生成的提取 Session 不会再次触发 Dream，避免递归。

Provider 错误会分类并脱敏。控制面只展示 configured/not-configured 状态和 credential reference，不返回密钥、Authorization header 或完整外部错误正文。

## 持久化与恢复

插件把 DSH `storageDomain` 作为持久化边界，不暴露固定路径、`node:sqlite` 数据库或公共文件存储 API。持久化状态包括 scope 内 profile 状态、L0 sources、Wiki pages、Candidates、Resident 元数据、审计记录和 Dream cursor/job。

- storage 初始化失败时，长期记忆不可用，不悄悄回退到全局 profile 或本地文件。
- Dream 失败时记录脱敏错误，旧的有效 Resident 继续可读。
- Resident 编译失败时保留上一次有效投影。
- 宿主重启后，bundle 重新加载即可继续处理持久化证据和 job。
- Provider 返回伪造 Session ID 时，该 ID 被忽略；任务自己的 Session 与 cursor 仍是权威。

## 安全与隐私边界

### 凭据

Dream key 在执行时从 DSH credentials 或进程环境解析。UI 和 HTTP 配置只接受 endpoint、model、token limit 和 credential reference，拒绝原始 `apiKey` 写入。endpoint 必须 HTTPS，不能内嵌用户名、密码或 token。

### 控制面

回环开发可以使用本机边界；远程控制必须使用 bearer token 并匹配 `x-dsh-memory-profile`。A profile 的 token 不能读取或修改 B profile，跨 scope Session 会被拒绝。

### 敏感内容

Dream 不会自动提升敏感内容。敏感候选保持 pending，必须人工确认。提取 prompt 禁止推断秘密、诊断信息和指令，但这只是保护措施，不能替代部署策略。

### 删除语义

v1 的“forget”准确含义是“从权威 Wiki 投影和新编译的 Resident 中移除派生记忆”。它不等同于删除所有 raw Session event，API 会披露这个边界。完整 raw Session purge 是未来能力，需要独立的审计、恢复和擦除策略。

## 控制 API 与 UI

UI 是管理与审计界面，不是绕过状态机的后门。它展示 Resident、Wiki 页面、候选、来源 Session、关系边、版本、置信度、同意、过期和状态。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/memory/v1/ui` | 人工控制和审计页面 |
| GET | `/memory/v1/wiki` | Wiki、候选、来源、图谱和状态 |
| GET | `/memory/v1/wiki/graph?hop=1&evidence=1` | 带证据边的 L2 图谱；`includeEvidence=1` 是兼容别名 |
| GET | `/memory/v1/resident` | 当前有界 Resident 和保留说明 |
| GET | `/memory/v1/sessions/:id` | 某个 Session 的可审计 L0 证据 |
| GET | `/memory/v1/candidates` | 待处理 Dream Candidates |
| GET | `/memory/v1/config` | 安全的 endpoint/model/credential 状态 |
| POST | `/memory/v1/dream` | 排队 Session 或 profile Dream，返回 `202` |
| POST | `/memory/v1/wiki/candidates/:id/confirm` | 显式确认 Candidate |
| POST | `/memory/v1/wiki/candidates/:id/reject` | 拒绝 Candidate |
| POST/PUT | `/memory/v1/wiki/pages` | 显式创建或编辑权威页面 |
| POST | `/memory/v1/wiki/pages/:id/supersede` | 废止页面但保留血缘 |
| GET | `/memory/v1/audits` | scope 内更正、废止、forget 和 Dream 审计 |
| DELETE | `/memory/v1/wiki/pages/:id` | 从后续 Resident 移除派生记忆 |

## 安装与配置

将 bundle 安装到包含 Web host 的 DSH profile：

```sh
dsh plugin --profile web add /absolute/path/to/packages/bundle/riko-memory
```

插件使用 DSH workspace 依赖和 `0.1.6-alpha.2` 基线。GitHub 镜像是源码/包镜像，实际运行仍应安装到兼容的 DSH Harness worktree。

配置 owner namespace 和稳定 Agent preset。两者缺一时长期记忆读写都会 fail-closed。OpenRouter 临时验收只把变量注入当前进程：

```text
DSH_MEMORY_DREAM_API_URL=https://openrouter.ai/api
DSH_MEMORY_DREAM_MODEL=stealth/union-alpha
DSH_MEMORY_DREAM_API_KEY=<runtime secret>
```

不要通过 UI 保存 key，不要写入 `dream-settings.json`，不要提交到仓库，不要放进 URL，也不要粘贴到 issue 或日志。MiMo 兼容验收使用 Anthropic-compatible endpoint，例如 `https://api.xiaomimimo.com/anthropic` 和 `mimo-v2.5`。

## 验收与验证

在 DSH Harness worktree 执行定向门禁：

```sh
pnpm exec tsc -b packages/bundle/riko-memory/tsconfig.json --pretty false
pnpm exec vitest run packages/bundle/riko-memory/tests --reporter=dot
```

原生测试覆盖 contracts、provider 协议提取、严格 FILE 解析、Loader composition、scope 隔离、显式 remember/correct/forget、Candidate 确认、fingerprint 合并、过期、证据图别名、Dream 回退和重启恢复。

独立 provider 基线脚本使用临时目录和临时 profile，发送最小请求，检查响应形状，429 最多一次有界重试，并将 401/403/404/429/5xx/timeout/empty/non-JSON 分别归类。只保留：

```text
acceptance-summary.json
acceptance-events.jsonl
sanitized-provider-errors.log
```

不会保存 API key、Authorization header 或完整 provider 回复。Provider 验收只能证明协议可达和受控输出，不能证明某次回答差异一定由记忆导致。记忆验收还必须区分正确注入、漏注入、正确静默、错误注入和模型自然波动。`/demo/run` 默认关闭，旧版 200-turn 双 Agent Demo 不是生产路径。

## 优点

- 原生 DSH 集成：真实 profile、Loader、storage 和生命周期都可验收。
- 强来源：可以从 Session 证据追到 Candidate、Wiki 页面、Resident 版本和提示词注入。
- 强隔离：owner、preset、token 校验在读写之前执行。
- 故障可预测：普通聊天继续，Dream/provider 失败不会删除旧 Resident。
- 人工控制：候选可查看、拒绝、确认、更正、废止和忘记。
- Prompt 成本有界：原始 Transcript、完整 Wiki 和 pending 队列不进入热路径。

## 缺点与取舍

- 强依赖 DSH，不是任意 Node、Rust 或 MCP host 的通用库。
- 稳定 preset 是硬前提；配置不完整时会故意 fail-closed。
- Candidate 审核会延迟自动记忆；用户明确要求时可用显式工具走快速路径。
- 尚无 embedding/向量召回，超大 Wiki 将来需要单独治理的检索设计。
- Forget v1 只删除派生记忆，不删除 raw evidence。
- `storageDomain` 是宿主边界，不是分布式共识；公网多节点部署需要额外设计。
- Provider 质量仍有波动，严格解析保护状态机，但不能保证每个候选都相关或完整。

## 当前状态与后续工作

当前已实现：scope 安全的 L0 evidence、L1 Candidate、L2 Wiki、L3 Resident 契约；DSH 持久化与重启恢复；显式工具；profile/token 校验；安全 credential；OpenAI-compatible 和 Anthropic-compatible Dream 协议；FILE 解析；标题/正文限制；wikilink 规范化；候选 fingerprint 合并；来源保留；last-valid Resident 回退；持久化 job/cursor；管理 UI；证据图；候选审核和审计接口。

明确延期：raw Session purge、完整数据擦除、embedding、向量召回、多节点存储、公网多租户运营、敏感内容的生产级自动确认策略，以及脱离兼容 DSH workspace 的独立 runtime。

## 常见问题

### Dream 回复会直接变成记忆吗？

不会。它先变成 Candidate，只有原始用户明确证据或显式管理确认创建权威 Wiki 页面后，才可能进入 Resident。

### 两个 preset 可以共用一个记忆池吗？

不可以。stable preset 是长期键的一部分。共享必须有意识地配置同一个稳定 preset 边界。

### Provider 挂了会怎样？

普通聊天继续，任务记录脱敏失败，旧的有效 Resident 继续可用；恢复后可根据持久化 cursor 继续处理。

### API key 放在哪里？

Dream 执行时从 DSH credentials 或进程环境解析，管理 API 不会写入或返回原始 key。

### 删除记忆到底删什么？

从未来 Resident 中删除派生 Wiki 记忆并记录操作；v1 保留原始 Session 证据。

### 这个仓库是完整 DSH Harness 吗？

不是。它是原生记忆 bundle 的源码镜像，应安装到兼容的 DSH Harness workspace 中运行。

## 开发备注

长期记忆修改必须留在 storage-domain、Candidate、Wiki 和 Resident 状态机内。不要添加平行文件存储、悄悄扩大 scope、持久化明文 secret，或让模型输出绕过权威确认。行为改变后依次执行静态检查、定向测试、Loader 测试；只有 Dream 协议变化时才重新 provider probe，并检查原始归因和文档门禁后再发布。

## Model Experience

### Resident memory injection

#### What the model sees

每个运行中的 Agent 只接收所属稳定 preset 的有界 Resident Snapshot。注入块标记为记忆数据而不是指令；完整 Wiki、原始 Session 证据和 pending Candidate 不会进入热提示词。

#### Token effect

Resident 内容受 `maxResidentChars` 限制，并作为下一次请求的动态 system context 组装。Dream 失败时继续使用上一次有效投影，Provider 挂掉不会突然删除已经建立的上下文。

#### KV Cache effect

Resident 变化会修改后续请求的动态 system context，并可能让注入点之后的请求前缀缓存失效；读写记忆本身不会在聊天热路径调用 Dream。

## 已知限制与后续工作

- 插件强依赖 DSH workspace API，不是任意 Node、Rust 或 MCP host 的通用库。
- 稳定 preset 是硬前提；配置缺失时会故意 fail-closed，避免误共享全局记忆。
- Candidate 审核可能延迟自动记忆；用户明确要求时可用显式工具走快速路径。
- 尚未实现 embedding、向量召回、多节点存储和公网多租户运营。
- Forget v1 只从未来 Resident 移除派生记忆，不清除 raw Session 证据。
- `storageDomain` 是宿主持久化边界，不是分布式共识；公网多节点部署需要额外设计。
- Provider 质量仍有波动，严格解析能保护状态机，但不能保证候选一定相关或完整。
- raw Session purge、完整数据擦除、敏感内容自动确认和脱离 DSH 的独立 runtime 均为后续工作。
