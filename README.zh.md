---
description: "DeepSeek Harness 原生作用域记忆插件。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-riko-memory

[English](README.md) | 中文

## 概述

这是一个按稳定 Agent preset 隔离、使用 DSH storage-domain 持久化、要求显式确认、以 Wiki 为长期权威并用有界 Resident 注入提示词的原生 DSH 记忆插件。密钥只来自 credentials 或进程环境，控制面和验收路径都有明确范围。

## 目录

- [这是什么](#what-this-package-is)
- [总体方案与数据流](#architecture-at-a-glance)
- [安装与配置](#installation-and-configuration)
- [验收与验证](#acceptance-and-verification)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="what-this-package-is"></a>
## 这是什么

`@deepseek-ai/dsh-riko-memory` 是 Riko 风格作用域长期记忆在新版 DeepSeek Harness 上的原生实现。它直接接入 DSH 的 Cordis 插件加载、Session 事件、稳定 Agent preset、`storageDomain`、system prompt 注入、显式工具、credentials 和后台 job。它不是 MCP memory server，不是第二套 SQLite 服务，也不是通用文件存储适配器。

这个插件只有一个严格承诺：一条记忆只有在拥有可追溯来源、通过 scope 边界、进入权威 Wiki 状态机并被选入有界 Resident Snapshot 后，才可能影响后续回答。模型输出本身永远不是权威。

唯一源码源头是 DSH Harness worktree 中的 `packages/bundle/riko-memory`。GitHub 仓库 [AkinoHaruka/companion-memory](https://github.com/AkinoHaruka/companion-memory) 是这个 bundle 的用户侧源码镜像。旧 standalone 实现和历史根目录副本仅用于迁移参考，不再作为平行运行时。

规范性的 V3.1 决策增补见 [docs/v3.1-decision-semantics.md](docs/v3.1-decision-semantics.md)；其实现状态见 [docs/memory-v3-progress.md](docs/memory-v3-progress.md)。

<a id="architecture-at-a-glance"></a>
## 总体方案与数据流

```text
User conversation
  -> DSH session/event listener
  -> L0 evidence: sessionId + event sequence + source span
  -> explicit tool or background Dream
   -> L1 Candidate: proposal with source record and consent state
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

- 超出可选且有界的 dense-recall provider 与 index seam 之外的生产级后台 vector-index compaction 和多节点 index ownership。
- 多节点协调、公网多租户部署和分布式 job ownership。
- 所有 evidence、audit 以及外部备份副本的完整加密擦除。
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
- `storageDomain`：`riko_memory`，`per-record` 版本 `5`，兼容版本 `[1, 2, 3, 4]`。
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

只有 confirmed、已同意、未 supersede、未过期且符合 Resident permission 的页面参与编译。当前 runtime 默认排除 `sensitive` 页面；V3.1 还要求在显式 policy 允许前拒绝 `provisional_sensitive` 进入 Resident。sensitive canonical page 仍可审计，并可通过明确的 Mention Gate 参与召回，但不会进入普通 Resident 注入。source 页面、pending Candidate 和原始 Transcript 不进入聊天热路径。结果按规则排序，受 `maxResidentChars` 限制，生成内容版本号，并只持久化实际选中 block 对应的 page IDs。DSH 只把当前稳定 preset 的 Resident 作为标记为“记忆数据”的 system context 注入，而不是当作指令。

## 四个显式工具

### `memory_get_resident`

读取当前稳定 Agent preset 的 Resident 和版本号。缺少 preset 时拒绝读取；它是只读热路径操作，不调用 Dream。

### `memory_remember`

把一条明确偏好或事实作为 managed、confirmed memory 保存。内容必须非空，并且必须出现在当前 Session 最新原始用户消息中。模型推断或从其他 Session 复制的内容不能写入。

### `memory_correct`

在验证替换内容出现在当前原始用户消息后，更正指定 Wiki 页面的用户可见内容。页面继续保持 confirmed，版本与审计血缘保留，Resident 立即重建。

### `memory_forget`

要求最新用户消息包含“忘记”“删除”“forget”“remove”等明确删除意图，并包含准确 memory ID。它从后续 Resident 移除派生 Wiki 记忆并记录操作；v1 不删除原始 raw Session 证据。

## Query-Time Recall v1

可选的 `recallEnabled` 会在 Resident 之外按当前用户 query 召回长尾细节，默认关闭。第一阶段使用 scope 内 canonical lexical search，并以原始用户证据作 secondary recall。预算先用 `min(recallMaxCandidates, recallAuthoritativeReserve)` 为非 evidence 权威结果保留席位，再在融合结果中考虑剩余候选；raw evidence 受 `recallRawEvidenceMaxCandidates` 限制，canonical 文本标为 `[authoritative]`，选中的 supporting evidence 标为 `[supplement]`，而当已选非 L0 文本覆盖 raw 细节的全部词项时会抑制重复 raw 细节。最终上下文仍受 `recallMaxContextChars` 限制。`embeddingProvider` 可启用 deterministic-local 或 OpenAI-compatible dense recall；provider 失败会降级到 lexical/RRF，不阻断聊天。keyless deterministic 消融在 companion 对比中测得 unique recall gain 为 0/16、dense noise 为 2/9、gate rejection 为 0/9；更大的 12 个场景、每场景 20 页的 keyless chaos probe 在本次运行打印了 unique gain 0/12、noise 60/60、gate rejection 36/96。这些是 keyless routing 和 selection 测量，不是 BGE 质量结果。BGE 门控的语义语料（`tests/dense-semantic-gain.spec.ts`）测量 lexical 排序在结构上无法达到的改写召回：在本地 BGE-small-zh-v1.5 服务上记录的结果是 lexical-only 命中 0/5，deterministic hash provider 命中 2/5，BGE 向量命中 5/5；该运行需要 `DSH_MEMORY_BGE_ENDPOINT`，因此默认 package run 不报告 BGE 质量测量。live hook 也不会提供 `MemoryReranker`，rerank 只可由直接 helper/store 调用和测试触达。Recall 还支持调用方提供明确的 `atTime` 或 `history` 来读取保留的时间线。suppression cue 会作为 policy evidence 保留并驱动 suppression；在 suppression 生效期间，它不会作为普通 raw recall 返回。详见 [docs/recall-v1.md](docs/recall-v1.md) 与 [docs/migration-phase-2-temporal-resident.md](docs/migration-phase-2-temporal-resident.md)。

Observation 管理、图谱扩展和 raw Session purge 分别由 `recallObservationEnabled`、`recallGraphEnabled`、`purgeEnabled` 控制，默认全部关闭。启用的 Dream reflection 可以创建带 anchor 的 Observation candidate；创建 candidate 或更新 evidence 时，只要记录仍是 candidate、敏感度为 `normal`、没有强矛盾，并满足配置的 evidence、不同 Session 和 confidence 下限，runtime 就可以自动激活它。另一个路径是经过认证的 `POST /memory/v1/observations/:id/activate` 管理操作；它在通过 store 的最少 evidence 检查后显式激活记录，匹配的路由可以让记录 invalidated 或 suppressed。两条激活路径都不会确认 fact 或授予 explicit mention permission。Observation 必须有 raw/confirmed evidence anchor，始终与 Wiki fact 分开。普通 `memory_forget` 仍会保留 raw Session 证据。

Safe-use projection 会从规范页面和 Observation 重建，持久化到 `projections` 表，并由 query-time recall 路径读取。Renderer 会执行 projection 的 disclosure policy，不使用 per-turn sanitizing model call；V3.1 禁止这类调用。

## Temporal validity 与结构化 Resident

Canonical page 支持 `observedAt`、`recordedAt`、`validFrom`、`validTo`、supersede lineage，以及带 `atTime`/`history` 的历史召回。Temporal update 会关闭旧页面的有效区间并发布新的 page identity；correction 则保留原 page identity 并记录审计 lineage。当前 Resident 会排除 superseded、过期、source-only、未授权和 sensitive 页面。

Resident 会编译为有界 block（`identity`、`preferences`、`relationships`、`currentState`、`communicationStyle`、`activePeople`、`openThreads`）。持久化的 snapshot 就是实际注入值，并带确定性版本和实际选中的 source page IDs。旧的非结构化 Resident 记录在迁移期仍可读取。

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

Dream 和 embedding secret 在执行时从 DSH credentials 或进程环境解析。UI 和 HTTP 配置只接受 endpoint、model、token limit 和 credential reference，拒绝原始 `apiKey` 或 secret-like credential 写入。provider endpoint 必须 HTTPS，不能内嵌用户名、密码或 token。

### 控制面

回环开发可以使用本机边界；远程控制必须使用 bearer token 并匹配 `x-dsh-memory-profile`。`apiTokens` 将每个 token 绑定到一个 profile。单 token 模式下，设置 `apiTokenProfile` 时只允许该 profile；留空时 token 是 owner-wide admin，控制面返回 `scopeBinding: owner-admin`。跨 scope Session 会被拒绝。

### 敏感内容

Dream 生成的敏感候选保持 pending，必须显式 review。显式 user 或 trusted management action 有独立 authority，但 V3.1 把 sensitivity 定义为 usage permission 而不是 truth claim，并要求三状态 policy 保守收紧。提取 prompt 禁止推断秘密、诊断信息和指令，但这只是保护措施，不能替代部署策略。

### 删除语义

普通“forget”的准确含义是“从权威 Wiki 投影和新编译的 Resident 中移除派生记忆”，并保留 raw Session evidence。显式开启 `purgeEnabled` 后，`POST /memory/v1/purge` 会启动带 journal 的 raw Session purge，并协调 session、source、page、candidate、observation、derived index 和 Resident 状态。它要求 dry-run 或 plan 返回的精确 confirmation，并报告完成 verification；store reopen 时可以重试中断的 journal。storageDomain 之外的完整加密擦除仍属于部署责任。

## 控制 API 与 UI

UI 是管理与审计界面，不是绕过状态机的后门。它展示 Resident、Wiki 页面、候选、来源 Session、关系边、版本、置信度、同意、过期和状态。下表中的 `/memory/v1` 可替换为实际配置的 `apiPath`。

| 方法 | 路径 | 用途 | 访问 / flag | surface |
|---|---|---|---|---|
| OPTIONS | `/memory/v1/*` | CORS preflight | 不需要 auth；无 flag | 协议 |
| GET | `/memory/v1`、`/memory/v1/` 或 `/memory/v1/ui` | 人工控制和审计页面 | HTML 不需要 auth；数据 API 仍需 auth | 仅管理 |
| GET | `/memory/v1/config` | 安全的 endpoint/model/credential 状态 | profile auth；无 flag | 仅管理 |
| POST | `/memory/v1/config` | 更新非 secret Dream 设置 | profile auth；无 flag | 仅管理 |
| GET | `/memory/v1/wiki` | Wiki snapshot、候选、来源、图谱和状态 | profile auth；无 flag | 仅管理 |
| GET | `/memory/v1/wiki/pages/:id` | 读取一个 Wiki 页面；sensitive/unknown body 默认隐藏，`reveal=sensitive` 才显示 | profile auth；无 flag | 仅管理 |
| GET | `/memory/v1/wiki/graph` | 读取有界 Wiki 图谱；`hop`、`evidence`、`includeEvidence` 是 query 选项 | profile auth；无 flag | 管理检查；graph recall 另受 flag 控制 |
| GET | `/memory/v1/wiki/search` | Wiki lexical 检查；不是 live Agent recall | profile auth；无 flag | 仅管理 |
| GET | `/memory/v1/wiki/sources` | 列出 scope 内 source metadata | profile auth；无 flag | 仅管理 |
| GET | `/memory/v1/resident` | 读取当前有界 Resident 和 raw 保留说明 | profile auth；无 flag | 管理检查 |
| GET | `/memory/v1/sessions` 或 `/memory/v1/sessions/:id` | 列出 Session 或读取已隐藏的 L0 metadata；`reveal=sensitive` 会审计 | profile auth；无 flag | 仅管理 |
| GET | `/memory/v1/candidates` | 列出待处理 Dream Candidates | profile auth；无 flag | 仅管理 |
| GET | `/memory/v1/observations` | 列出推断 Observation 及状态 | profile auth；无 flag | 管理/验收专用 |
| GET | `/memory/v1/purges` | 读取 scope 内 purge journal metadata | profile auth；无 flag | 管理/验收专用 |
| GET | `/memory/v1/conflicts` | 列出 contested 和 resolved conflict overlay | profile auth；无 flag | 仅管理 |
| GET | `/memory/v1/audits` | 读取 scope 内 lifecycle audits | profile auth；无 flag | 仅管理 |
| POST | `/memory/v1/recall` | 执行有界 query-time recall | profile auth；`recallEnabled` | 管理检查；live Agent recall 使用独立 pre-step hook |
| POST | `/memory/v1/recall/debug` | 读取 Recall 计划、通道、gate 和降级状态 | profile auth；`recallEnabled` | 管理/诊断专用 |
| POST | `/memory/v1/observations` | 创建带 anchor 的 Observation candidate | profile auth；无 flag | 管理/验收专用；不是 Dream/Agent 创建 |
| POST | `/memory/v1/observations/:id/activate`、`/invalidate` 或 `/suppress` | 修改一个 Observation 状态 | profile auth；无 flag | 管理/验收专用 |
| POST | `/memory/v1/conflicts/:id/resolve` | 使用 JSON `{ "resolution": "correction" | "temporal_transition" | "management" }` 解决 contested overlay；其他值返回 `400`，状态未变化时返回 `404` | profile auth；无 flag | 仅管理 |
| POST | `/memory/v1/purge` | flag 开启后 purge 一个 raw Session | profile auth；`purgeEnabled` | 管理/验收专用 |
| POST | `/memory/v1/wiki/candidates/:id/confirm` 或 `/reject` | 确认或拒绝 Candidate | profile auth；无 flag | 仅管理 |
| POST | `/memory/v1/candidates/:id/confirm` 或 `/reject` | Candidate 操作的兼容别名 | profile auth；无 flag | 仅管理 |
| POST | `/memory/v1/wiki/pages` | 创建 locked canonical page | profile auth；无 flag | 仅管理 |
| PUT | `/memory/v1/wiki/pages/:id` | 编辑一个 canonical page；显式提供 `sensitivity` 时以管理 authority 修改敏感性并写入审计 | profile auth；无 flag | 仅管理 |
| POST | `/memory/v1/wiki/pages/:id/supersede` | 废止页面但保留血缘 | profile auth；无 flag | 仅管理 |
| POST | `/memory/v1/wiki/pages/:id/temporal` | 发布 temporal replacement | profile auth；无 flag | 仅管理 |
| POST | `/memory/v1/memories` | 创建 confirmed manual memory convenience record | profile auth；无 flag | 仅管理 |
| DELETE | `/memory/v1/memories/:id` | 删除派生 memory 但保留 raw evidence | profile auth；无 flag | 仅管理 |
| DELETE | `/memory/v1/wiki/pages/:id` | 删除派生 Wiki memory 但保留 raw evidence | profile auth；无 flag | 仅管理 |
| POST | `/memory/v1/dream` | 排队 Session/profile Dream，返回 `202` | profile auth；无 flag | 管理/验收专用 |

<a id="installation-and-configuration"></a>
## 安装与配置

将 bundle 安装到包含 Web host 的 DSH profile：

```sh
dsh plugin --profile web add /absolute/path/to/packages/bundle/riko-memory
```

插件使用 DSH workspace 依赖和 `0.1.6-alpha.2` 基线。GitHub 镜像是源码/包镜像，实际运行仍应安装到兼容的 DSH Harness worktree。

配置 owner namespace 和稳定 Agent preset。两者缺一时长期记忆读写都会 fail-closed。下表完整列出 42 个 live `Config` 字段。`configResponse()` 只返回安全的运行状态；`ownerNamespace`、`apiToken` 和 `apiTokens` 因为会暴露 scope 或凭据而特意不返回。OpenAI-compatible embedding 必须配置非空 model、credential reference 和 HTTPS endpoint（仅环回主机接受明文 HTTP）；deterministic embedding 使用配置的 dimension。OpenRouter 临时验收只把变量注入当前进程：

| 配置字段 | 默认值 | 说明 | `configResponse()` |
|---|---:|---|---|
| `ownerNamespace` | `local` | 用于派生隔离记忆 scope 的 owner namespace。 | 不返回：scope 私有。 |
| `apiPath` | `/memory/v1` | 管理 API 和 UI 的 HTTP 前缀。 | 返回。 |
| `apiToken` | `''` | 默认 profile 使用的单一 bearer token。 | 不返回：secret。 |
| `apiTokens` | `{}` | 将 profile 绑定到不同 scope 的 bearer-token 映射。 | 不返回：secret 且 scope 私有。 |
| `apiTokenProfile` | `''` | 单 token 认证模式选择的 profile。 | 仅非空时返回。 |
| `ownerAdminToken` | `''` | 授予跨 profile 管理访问权限的 owner-admin bearer token。 | 仅以 `ownerAdminConfigured` 返回；令牌值本身永不返回。 |
| `dreamApiUrl` | `https://api.deepseek.com/api/v1/chat/completions` | Dream Wiki 提取使用的 provider endpoint。 | 通过持久化 Dream 设置返回。 |
| `dreamCredentialRef` | `DSH_MEMORY_DREAM_API_KEY` | Dream 调用 provider 时解析的 credential reference。 | 返回；不会返回 secret 值。 |
| `dreamModel` | `deepseek-chat` | 发送给 Dream provider 的模型名。 | 通过持久化 Dream 设置返回。 |
| `dreamMaxTokens` | `1200` | Dream completion 的最大 token 数。 | 通过持久化 Dream 设置返回。 |
| `dreamIntervalMs` | `3600000` | 定时 Dream 恢复和 sweep 的间隔。 | 返回。 |
| `debounceMs` | `5000` | Session 活动触发 Dream 调度前的延迟。 | 返回。 |
| `maxResidentChars` | `12000` | Resident prompt 序列化后的最大长度。 | 返回。 |
| `maxSessionChars` | `40000` | Dream 输入和恢复使用的最大 transcript 长度。 | 返回。 |
| `recallEnabled` | `false` | 启用 Agent hook 和 HTTP route 的 query-time recall。 | 返回。 |
| `recallVectorEnabled` | `false` | 启用 planner 控制的 dense vector recall。 | 返回。 |
| `recallRawEvidenceEnabled` | `true` | 允许有界 raw L0 evidence 作为 recall 通道。 | 返回。 |
| `recallObservationEnabled` | `false` | 允许 active observation 作为 recall 通道。 | 返回。 |
| `recallGraphEnabled` | `false` | 启用 recall 时有界的 Wiki graph 扩展。 | 返回。 |
| `purgeEnabled` | `false` | 启用经过认证的 raw-session purge transaction。 | 返回。 |
| `recallMaxCandidates` | `8` | 渲染前允许的最大 recall 结果数。 | 返回。 |
| `recallMaxContextChars` | `3000` | 渲染后的 recall context 最大长度。 | 返回。 |
| `recallAuthoritativeReserve` | `4` | 为非 evidence 权威 recall 候选保留的最小席位数。 | 返回。 |
| `recallRawEvidenceMaxCandidates` | `2` | 每次 recall 最多考虑的 raw L0 evidence 候选数。 | 返回。 |
| `residentV2Enabled` | `true` | 启用结构化 Resident projection 路径。 | 返回。 |
| `residentBlocksEnabled` | `true` | 启用有界的结构化 Resident block。 | 返回。 |
| `sensitiveResidentEnabled` | `false` | 允许符合条件的 sensitive page 进入 Resident 输出。 | 返回。 |
| `temporalEnabled` | `true` | 启用 temporal validity 和历史 recall 语义。 | 返回。 |
| `evidenceClassificationEnabled` | `false` | 在捕获时对 user-origin L0 evidence 分类；关闭时未标记 evidence 保持未分类，而 capture-rule marker 按 fail-closed sensitive 处理。 | 返回。 |
| `unclassifiedEvidenceDisclosure` | `user_explicit_only` | 只用于真正未分类 L0 evidence 的 fallback：`user_explicit_only` 或 `never_explicit`。已存储的 `sensitive` evidence，以及分类关闭时按 sensitive 处理的 capture-rule evidence，仍保持 `never_explicit`。 | 返回。 |
| `minObservationEvidence` | `2` | Observation candidate 所需的最少不同有效锚点数。 | 返回。 |
| `observationActivationMinEvidence` | `3` | 自动激活 Observation 所需的最少不同证据锚点数。 | 返回。 |
| `observationActivationMinSessions` | `2` | 自动激活 Observation 所需的最少不同 Session 数。 | 返回。 |
| `observationActivationMinConfidence` | `0.8` | 自动激活 Observation 所需的最小置信度。 | 返回。 |
| `reflectionEnabled` | `false` | 启用 Dream reflection 以提出带锚点的 Observation。 | 返回。 |
| `reflectionMaxObservations` | `3` | 一次 reflection 接受的最大 Observation proposal 数。 | 返回。 |
| `temporalReconcileEnabled` | `false` | 启用 Dream 处理期间的 temporal reconciliation。 | 返回。 |
| `embeddingProvider` | `off` | 选择关闭、deterministic 或 OpenAI-compatible embedding。 | 返回。 |
| `embeddingEndpoint` | `''` | OpenAI-compatible embedding provider 使用的 endpoint；必须 HTTPS，仅环回主机允许明文 HTTP。 | 返回。 |
| `embeddingCredentialRef` | `DSH_MEMORY_EMBEDDING_API_KEY` | embedding provider 使用的 credential reference。 | 返回；不会返回 secret 值。 |
| `embeddingModel` | `''` | 发送给 OpenAI-compatible embedding provider 的模型名。 | 返回。 |
| `embeddingDimension` | `256` | deterministic 和 compatible provider 使用的向量维度。 | 返回。 |

Provider 提议可以收紧敏感性，但不能降低已有页面的敏感性。`memory_remember` 使用确定性保守提升。管理端通过 `PUT /memory/v1/wiki/pages/:id` 显式设置 `sensitivity` 为 `normal`、`provisional_sensitive` 或 `sensitive` 时，转换会写入审计。

L0 evidence 本身也带一层使用许可；打开 `evidenceClassificationEnabled` 后，它在捕获时而不是读取时确定。Recall 首先读取 `evidenceSensitivityState`：缺少 marker 时是 `unclassified`，使用 `unclassifiedEvidenceDisclosure`；明确存储的 `normal` 或 `provisional_sensitive` marker 使用各自的 disclosure policy；明确存储的 `sensitive` marker 使用 `never_explicit`；capture classification 关闭时，`deterministic_rule` marker 按 `sensitive` 处理。这意味着全局 default 只适用于系统确实从未分类的 evidence，不能放宽已存储的 sensitive evidence 或暂停中的 fail-closed capture marker。设置 `unclassifiedEvidenceDisclosure: never_explicit` 会让真正未分类的 raw text 即使匹配请求也保持静默。捕获规则写入的值在能力关闭时是挂起而不是删除，重新打开并重启后会从同一条记录恢复。状态、权威矩阵与回滚语义以 [docs/v3.1-decision-semantics.md](docs/v3.1-decision-semantics.md) 为准。

`SafeUsageProjection.disclosure` 是唯一的原文 disclosure policy 字段：`normal` 允许原文，`user_explicit_only` 只有在用户主动发起 turn、明确回忆该主题且主题匹配时才返回原文和已记录的来源引用，`never_explicit` 即使 query 匹配也永远不返回原文。Recall eligibility 检查和 mention renderer 都执行这个字段；`never_explicit` projection 始终保持 silent。普通 turn 只有在 projection 同时置了 `ordinaryRawText`、且 query 的词汇全部出现在存储文本中时才会拿到原文——这正是 preference 页面与 interaction rule 保持只给指引的原因；`allowedEffects` 只描述这条记忆可以被如何使用，不参与是否返回原文的判定。

```text
DSH_MEMORY_DREAM_API_URL=https://openrouter.ai/api
DSH_MEMORY_DREAM_MODEL=stealth/union-alpha
DSH_MEMORY_DREAM_API_KEY=<runtime secret>
```

不要通过 UI 保存 key，不要写入 `dream-settings.json`，不要提交到仓库，不要放进 URL，也不要粘贴到 issue 或日志。MiMo 兼容验收使用 Anthropic-compatible endpoint，例如 `https://api.xiaomimimo.com/anthropic` 和 `mimo-v2.5`。

<a id="acceptance-and-verification"></a>
## 验收与验证

在 DSH Harness worktree 执行定向门禁：

```sh
pnpm exec tsc -p packages/bundle/riko-memory/tsconfig.json --noEmit --pretty false
pnpm exec vitest run packages/bundle/riko-memory/tests --reporter=dot
```

原生测试覆盖 contracts、provider 协议提取、严格 FILE 解析、Loader composition、scope 隔离、显式 remember/correct/forget、Candidate 确认、fingerprint 合并、过期、证据图别名、Dream 回退和重启恢复。

独立 provider 基线脚本使用临时目录和临时 profile，发送最小请求，检查响应形状，429 最多一次有界重试，并将 401/403/404/429/5xx/timeout/empty/non-JSON 分别归类。只保留：

```text
acceptance-summary.json
acceptance-events.jsonl
sanitized-provider-errors.log
```

不会保存 API key、Authorization header 或完整 provider 回复。Provider 验收只能证明协议可达和受控输出，不能证明某次回答差异一定由记忆导致。记忆验收还必须区分正确注入、漏注入、正确静默、错误注入和模型自然波动。独立 acceptance script 仍与生产插件路径分离。

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
- Deterministic 和 OpenAI-compatible embedding provider 已 live-wired，并在失败时降级到 lexical；runtime 会把有界 vector-index generation 持久化到 `index_meta` 和 `vectors`，重启后恢复匹配 generation，并在 mismatch 或 rebuild 失败时记录降级；生产级后台 compaction 和多节点 index ownership 仍是独立能力。
- 当前没有接入 live Agent 的 reranker；`MemoryReranker` 只能由直接 helper/store caller 使用。
- Forget v1 只删除派生记忆，不删除 raw evidence。
- Observation candidate 可以由启用的 Dream reflection 产生。创建 candidate 或更新 evidence 时，candidate 只有在敏感度为 `normal`、没有强矛盾，并满足配置的 evidence、不同 Session 和 confidence 阈值时才会自动激活。经过认证的管理路由也可以显式 activate、invalidate 或 suppress Observation；显式 activation 只使用 store 的最少 evidence 检查。两条激活路径都不等于 fact confirmation，也不授予 explicit mention permission。
- `storageDomain` 是宿主边界，不是分布式共识；公网多节点部署需要额外设计。
- Provider 质量仍有波动，严格解析保护状态机，但不能保证每个候选都相关或完整。

## 当前状态与后续工作

当前已实现：scope 安全的 L0 evidence、L1 Candidate、L2 Wiki、L3 Resident 契约；DSH 持久化与重启恢复；显式工具；profile/token 校验；安全 Dream/embedding credential；OpenAI-compatible 和 Anthropic-compatible Dream 协议；deterministic/OpenAI-compatible embedding wiring 和 lexical fallback；FILE 解析；标题/正文限制；wikilink 规范化；候选 fingerprint 合并；来源保留；last-valid Resident 回退；持久化 job/cursor；有界结构化 Resident block；带 `index_meta`/`vectors` 元数据、重启恢复、mismatch invalidation、candidate build 后原子切换和失败时保留旧 index 并标记降级的有界持久 vector-index generation；live Agent 的 lexical/RRF query-time recall 以及可选 dense、raw-evidence、graph 通道、canonical-first budget 和 policy-evidence suppression；Temporal validity 与历史召回；当前的保守 Mention Gate；带持久化/重建、认证 listing/resolution 和 live Agent 抑制的 contested conflict overlay；带可选 Dream reflection 的 anchored Observation candidate 和 HTTP 管理；authority-checked 三状态 sensitivity 转换；带 invalidation、历史解析和不改 canonical 的 rebuild 的可撤销 alias；显式同上下文 alias coreference；带 dry-run、confirmation、verification 和中断重试的 raw Session/page/candidate/source/observation journal purge；管理 UI、候选审核和审计路由；真实 Loader 的 SafeUsageProjection 和 conflict 注入断言；带真实 Loader runner 的 Appendix F companion 语料；以及从原始观测结果算出的 Appendix G 聚合指标，详见 [docs/companion-eval.md](docs/companion-eval.md)。

明确延期：生产级后台 vector-index compaction 和多节点 index ownership；live reranker 接入；sensitivity 假阴率和假阳率；完整 projection 和 answer-side outcome 指标；完整 conflict evaluation matrix；经过验证的 hedged silent use；超出 anchored Observation candidate 的完整 Reflection/consolidation；完整 live HTTP/Agent alias authority matrix；超出有界 wikilink graph expansion 的 entity resolution；storageDomain 之外的完整数据擦除；多节点存储；公网多租户运营；敏感内容的生产级自动确认策略；超出三十场景 companion 语料的 200–500 场景生产 benchmark；超出 focused package probe 的生产级 load/chaos 评测；以及脱离兼容 DSH workspace 的独立 runtime。

当前实现是受治理的 Phase 1–5 substrate，不代表所有生产级评测门槛都已完成。现有 package suite 覆盖已实现的状态转换，并已运行 Appendix F 语料和 Appendix G 聚合；没有 answer generator 时仍有四个 answer-side 语料指标显式标记为 unsupported，同时 focused restart、purge-interruption、load 和 keyless chaos probe 已存在。启用 opt-in flags 前仍需补齐 production benchmark、coverage 和生产级 load/chaos 证据。

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

<a id="dev-note"></a>
## 开发备注

长期记忆修改必须留在 storage-domain、Candidate、Wiki 和 Resident 状态机内。不要添加平行文件存储、悄悄扩大 scope、持久化明文 secret，或让模型输出绕过权威确认。行为改变后依次执行静态检查、定向测试、Loader 测试；只有 Dream 协议变化时才重新 provider probe，并检查原始归因和文档门禁后再发布。

**运行时不变式：** 不发布伴生入口。本包写下的所有持久投影都由共享 storage domain 拥有，运行时关系由走真实 Loader 的契约测试断言，因此不再单独登记运行时所有权。

<a id="model-experience"></a>
## Model Experience

### Resident memory injection

#### What the model sees

每个运行中的 Agent 只接收所属稳定 preset 的有界 Resident Snapshot。注入块标记为记忆数据而不是指令；完整 Wiki、原始 Session 证据和 pending Candidate 不会进入热提示词。

#### Token effect

Resident 内容受 `maxResidentChars` 限制，并作为下一次请求的动态 system context 组装。Dream 失败时继续使用上一次有效投影，Provider 挂掉不会突然删除已经建立的上下文。

#### KV Cache effect

Resident 变化会修改后续请求的动态 system context，并可能让注入点之后的请求前缀缓存失效；读写记忆本身不会在聊天热路径调用 Dream。

### Query-time recall injection

#### What the model sees

启用后，recall 以有界 memory data 注入。canonical 和其他非 evidence 结果是权威候选；raw evidence 支持已选权威结果时标为 `[supplement]`，canonical 文本标为 `[authoritative]`。suppression cue 产生的 policy evidence 会为控制目的保留，但不会进入普通 raw recall。

#### Token effect

`recallAuthoritativeReserve`、`recallRawEvidenceMaxCandidates` 和 `recallMaxContextChars` 共同限制候选组合与序列化上下文。已选非 evidence 文本覆盖其词项时，重复 raw 细节会被省略。

#### KV Cache effect

Recall 上下文变化会修改注入点之后的动态请求上下文，并可能降低后续请求的前缀缓存复用；Recall 不会在聊天热路径调用 Dream。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 插件强依赖 DSH workspace API，不是任意 Node、Rust 或 MCP host 的通用库。
- 稳定 preset 是硬前提；配置缺失时会故意 fail-closed，避免误共享全局记忆。
- Candidate 审核可能延迟自动记忆；用户明确要求时可用显式工具走快速路径。
- Deterministic 和 OpenAI-compatible embedding provider 已 live-wired，并在失败时降级到 lexical；有界 vector-index generation 持久化在 `index_meta` 和 `vectors` 中，重启后恢复匹配状态，rebuild 失败时保留旧 index 并记录降级。生产级后台 compaction、多节点 index ownership 和 rerank 仍是独立能力。
- 真实 Loader Agent 路径已覆盖只注入 SafeUsageProjection 且不带原文或来源标识、conflict quarantine 和认证 release；两个投影指标已有直接测量，answer-side outcome 指标、完整 conflict evaluation matrix 和完整 live HTTP/Agent alias authority matrix 仍未完成。
- 普通 Forget 只从未来 Resident 移除派生记忆，不清除 raw Session 证据；显式 purge 独立受 flag 控制，带 journal、dry-run、confirmation 和 verification。
- Observation candidate 可以来自启用的 Dream reflection。创建 candidate 和更新 evidence 时，candidate 只有在敏感度为 `normal`、没有强矛盾，并满足配置的 evidence、不同 Session 和 confidence 阈值时才会自动激活；需要认证的管理路由也可以显式 activate、invalidate 或 suppress Observation，显式 activation 使用 store 的最少 evidence 检查。两条激活路径都不等于 canonical confirmation，也不授予 explicit mention permission。
- `storageDomain` 是宿主持久化边界，不是分布式共识；公网多节点部署需要额外设计。
- Provider 质量仍有波动，严格解析能保护状态机，但不能保证候选一定相关或完整。
- Appendix F 语料覆盖三十个代表场景；没有 answer generator 时有四个 answer-side 指标 unsupported，Appendix G 产出 21 个字段。`safeUsageProjectionRate` 和 `rawTextWithheldRate` 是直接投影测量，answer-side outcome 字段在没有生成答案时仍 unsupported。keyless dense ablation 是 routing 和 selection probe，不是 BGE 质量结果。sensitivity 假阴率和假阳率、经过验证的 hedged silent-use 评测、完整 Reflection/consolidation、超出有界 wikilink graph expansion 的 entity resolution、storageDomain 之外的完整数据擦除、公网多租户运营、敏感内容自动确认、200–500 场景生产 benchmark、生产级 load/chaos 评测，以及脱离 DSH 的独立 runtime 均为后续工作。
