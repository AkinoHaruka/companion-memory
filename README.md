# companion-memory

面向 AI 伴侣的长期记忆系统：记住用户，也知道什么时候应该表达出来。

这不是一个普通的 RAG（检索增强生成）系统。检索流程只回答“什么内容相关”；本项目更难的问题是：什么值得保存、现在是否适合说出来，以及如何让用户画像逐步成长而不是不断堆积。

设计依据见 [DESIGN.md](./DESIGN.md)。建议先阅读第 1–2 节，那里解释了本项目为什么不只是 RAG，以及当前数据结构和记忆规则要解决的核心问题。

---

## 插件工作原理

插件不会把数据库里的所有内容原样塞进 prompt，而是走一条受治理的链路：

```text
直接用户消息
    ↓ turn/end 后异步抽取
候选记录 + 原文片段
    ↓ Rust worker 准入、去重、替代、证据校验
持久化记忆
    ↓ 每轮 agent/pre-step 按当前话题和边界执行提及闸门
MemoryUsagePlan
    ↓ 渲染为持久化 plugin/snapshot 用户消息
DSH 模型
```

### 整理哪些记忆

| 类型 | 记录内容 | 生命周期与用途 |
|---|---|---|
| `Claim`（明确事实） | 用户明确表达的身份、偏好、边界、事实，以及明确未解决的低压力事项 | 按谓词注册表保存；`single` / `temporal_single` 在类型兼容后替代旧值，`set` 允许多个值并存 |
| `Episode`（共同经历） | 一次真实共同经历、叙事和用户表达的情绪变化 | 保存原文证据片段；只有用户直接表达的内容才能成为用户事实，助手的猜测不能倒灌成用户画像 |
| `Inference`（慢速推断） | 跨多次对话逐渐形成的性格倾向、行为规律、反复主题或关系模式 | 先处于 `accumulating`，经过跨 session、跨时间、不同上下文和反例检查后才可晋级为 `active`；未确认时有置信度上限 |
| `RuntimeState`（当前状态） | 当前情绪、话题、需求和会话轨迹 | 临时状态，会过期；“我今天好烦”首先影响这里，不会直接污染长期画像 |

抽取器只读取**直接用户消息**，并且只提出明确、可持久化的内容。问候、天气、普通确认、含糊表达，以及模型自行推断的性格、意图、诊断和规律都会使用 `no_memory` 或进入待处理状态。每条候选还必须带有用户原文中唯一、可验证的片段；模型只能提出候选，不能自行决定它最终是否进入记忆。

### 记忆如何被整理

1. DSH 回合结束后，插件把直接用户消息放入有界、可取消的异步队列；插件快照、工具结果和助手回答不会进入用户记忆抽取。
2. 当前路由的模型按照 Rust worker 提供的谓词注册表输出候选 `Claim`、`Episode`、临时 `RuntimeState` 或 `no_memory`。TypeScript 先验证 JSON 和原文片段，Rust 再执行最终准入。
3. Rust worker 检查范围、谓词、值类型、原文片段、遗忘抑制集和证据引用，然后执行合并、替代或拒绝。每条已接受记录都保留来源消息和片段，便于审计和遗忘。
4. 明确的开放事项才会生成可跟进的 continuity thread；情绪猜测、已解决事件和敏感事项不会偷偷变成下一次对话的提醒。
5. 遗忘不是简单删除一行数据，而是写入 suppression 证据集，并让下游记录重新计算，避免已经固化的推断把被遗忘内容重新带回来。

### 记忆如何注入当前对话

每轮模型调用前，DSH 的 `agent/pre-step` 在第一个 step 调用 worker 的 `warm`，把当前用户消息、会话和已保存记录交给 Rust 闸门。worker 不返回全量数据库，而是生成一份 `MemoryUsagePlan`：

| 通道 | 注入内容 | 模型应该如何使用 |
|---|---|---|
| `constraints` | 边界和禁谈约束 | 必须遵守，但不主动解释其私密原因 |
| `identity` | 用户姓名等身份信息 | 自然称呼即可，不要像背档案一样复述 |
| `responseStyle` | 用户偏好的语言、语气、格式和详细程度 | 影响表达方式，不等于一条需要宣读的事实 |
| `continuity` | 新会话问候时可自然承接的低压力开放事项 | 仅在当前问候中自然时跟进一次 |
| `topicActivated` | 用户在当前回合明确提到或话题暗示的内容 | 可以围绕当前话题自然使用 |
| `deepRecall` | 高重要度的背景上下文 | 只能帮助组织回答，不能无提示地背诵出来 |
| `doNotSurface` | 被闸门拒绝或被边界遮蔽的记录数量 | 只传递“不要浮现或推断”的约束，不传递被隐藏的原文 |

每个通道都带有 `surface` 和 `reason`。`background_only` 只能影响语气和选择；`mention_if_user_cues` 必须等用户或当前话题给出线索；`freely_mentionable` 才允许无提示提及；`never_surface` 永远不会进入渲染结果。当前用户指令始终优先于历史记忆。

最终 renderer 将计划转成带有 `<companion_memory>` 标记的持久化 `plugin/snapshot` 用户消息，追加到本轮 DSH 消息中。若 worker 故障、超时或协议损坏，本轮只是不注入记忆，正常对话不会被阻塞。

边界会在渲染前处理：如果当前话题命中一个 episode，但它的叙事包含用户设定的禁谈主题，worker 会隐藏整个 episode，只留下边界约束和 withheld 计数；模型不会同时看到禁令和被禁止的原文，也不需要自行仲裁。

## 项目结构

```
crates/kernel/        Rust — 决策逻辑
                      不执行 I/O，不调用模型，不依赖宿主环境或隐式时间。
crates/storage/       Rust — SQLite 持久化。唯一接触数据库的 crate，
                      负责记录内核决策并读回数据。
crates/worker/        有版本的 JSONL 子进程：运行时访问 Rust 规则、
                      SQLite、检索和准入逻辑的唯一入口。
packages/dsh-plugin/  外部 DSH 0.1.5-rc.2 Bundle。渲染 Rust 的使用计划，
                      自身不拥有记忆策略。
packages/host/        Oracle 评估器；调用同一个 worker，记录因果链产物，
                      而不是只比较回答差异。
scripts/              工具：worker 打包、宿主构建和 MSVC 构建包装器。
```

内核不执行 I/O，也不调用模型，因此可以被穷举测试。抽取、叙述、整合和宿主接线留在适配层，因为这些环节需要模型和会话。

本项目曾先用 TypeScript 实现同一套领域和规则，随后将其删除。保留原型作为参考通常是好建议，但那个原型在测试未覆盖的地方存在行为错误：它接受任意字符串作为 `Date`，因此“自然语言不能覆盖已经解析出的时间点”这一规则并没有真正落实。与实现恰好在关键不变量上冲突的参考代码，不如没有参考代码。

## 当前状态

| 模块 | 状态 |
|---|---|
| 谓词词汇表与注册表（47 个谓词） | 已完成 |
| 记录身份：基数、替代、类型兼容 | 已完成 |
| 提及闸门 | 已完成 |
| 证据图与抑制 | 已完成 |
| 显著性、评分和晋级阈值 | 已完成 |
| 遗忘：抑制、残留扫描、派生重算 | 已完成 |
| 推断生命周期（置信度上限、复核） | 已完成 |
| 存储：模式、迁移、范围隔离查询 | 已完成 |
| JSONL worker：health、warm、admit、query、forget、会话关闭 | 已完成 |
| SQLite v3：已接受证据、片段、开放线程、遥测、待复核指针 | 已完成 |
| DSH 外部 Bundle：实际 `agent/pre-step` 快照注入 | 已完成 |
| 异步用户消息抽取与确定性 worker 准入 | 已完成 |
| Oracle 评估器：普通、Gold 检索、强制 Gold、反事实 | 已完成 |
| 内核↔存储集成：写入、召回、替代、遗忘 | 已完成 |
| RuntimeState / 推断晋级 | 等待抽取质量阈值 |
| 平台发布二进制 | CI 打包流程（Windows x64、Linux x64） |

旧的 TypeScript 谓词、基数、准入、存储和 `HostKernel` 实现已被有意退役。TypeScript 调用方可以序列化候选记录，但不能决定它是否有效、可见、替代旧记录或持久化。

生命周期测试会通过正式 Bundle 挂载，调度真实 DSH `agent/pre-step` 瀑布，并断言只有第一步注入一条持久化的 `plugin/snapshot` 消息。worker 的标准输入输出测试覆盖错误 JSON 恢复、已接受源消息的保留，以及遗忘后的证据删除。

## DSH Bundle 安装

为宿主平台构建发布版 worker，将其放入 package，然后把 package 作为外部 DSH Bundle 添加。发布 CI 会为 Windows x64 和 Linux x64 执行相同的打包命令。

```powershell
pnpm build:worker:windows
pnpm --filter @companion-memory/dsh-plugin build
dsh plugin --profile <profile> add <path-to-companion-memory/packages/dsh-plugin>
```

`packages/dsh-plugin/cordis.patch.yml` 从 `COMPANION_MEMORY_*` 环境变量读取部署范围内的服务、用户、默认 profile、数据库位置和 worker 命令。profile id 使用 DSH Agent Preset；如果没有设置，只使用 `COMPANION_MEMORY_DEFAULT_PROFILE`。它不会退回使用 Agent ID 或 Session ID。

每一次首次 `agent/pre-step` 都会从 worker 读取一份新的 `MemoryUsagePlan`，并追加为持久化的 `plugin/snapshot` 用户消息。worker 故障、超时或协议损坏时，DSH 仍正常回复但不注入记忆，也不会复用上一份快照。用户直接消息只会在 `turn/end` 之后进入私有、有界且可取消的队列进行抽取。

## 评估

`packages/host` 将每个回合标记为正向机会、受保护的负向案例或无机会静默案例。它会为固定实验臂记录计划、选中记录、准入结果和回答：普通链路、正常检索 Gold、强制注入 Gold，以及从不写入记忆的零记忆控制组。普通实验臂复用生产抽取语法和片段校验；只有直接用户文本和 Rust 批准的记录可以进入其中。

第五个实验臂是强制注入错误记忆：它运行在声明反事实的回合及其后续回合，直到错误事实仍留在存储中。这个实验用于施加压力：模型是否会重复被提供的事实，闸门是否会抑制用户要求避免的话题。过去它在每个回合都录入 Gold 提案，导致没有声明反事实的回合也被错误标记为 Gold，使得与上限的距离变成抽样误差而不是因果下限。

边界保护发生在 prompt 渲染之前：如果当前话题命中一个 episode，且其叙事包含边界的规范化主题值，worker 会隐藏该 episode；DSH 只会收到边界约束和 withheld 计数。模型不会同时看到禁令和被禁止的原文，也不需要自行仲裁两者。

这里的每个结论都比较“有记忆”和“无记忆”的差异，`oracle-summary.json` 按效果报告 `lift`（上限减控制组）。只看绝对命中率无法区分“记忆生效”和“模型本来就会这样回答”。

第一次模型调用前，`validateFixture` 会拒绝自相矛盾的 fixture：例如证据 token 不存在于更早记录、token 已由用户在当前回合说出、反事实重复 Gold，或会话没有推进。一个回合声明了召回效果但没有声明回答必须包含什么，并不构成矛盾；它会被标记为 `not_applicable`，而不是被错误计为失败。

```powershell
# bridge 在 DSH 内运行并绑定当前 Agent 路由，必须导出
# createEvaluationClient()，实现可使用 createDshRouteEvaluationClient(ctx, agent)。
$env:COMPANION_MEMORY_DSH_EVALUATION_BRIDGE = 'C:\path\to\dsh-oracle-bridge.mjs'
# 默认五次重复；正式验收时可设置为十次并启用验收门槛。
$env:COMPANION_MEMORY_EVAL_MODE = 'acceptance'
pnpm --filter @companion-memory/host run
```

供应商专用探针及其对话记录不属于发布源码。需要正式验收时，通过上面的 DSH bridge 运行 host package；评估器会记录完整的“候选 → 准入 → 激活 → 注入 → 可见效果”链路，并将路由拒答与记忆失败分开。

## 约定

**时间戳**使用 ISO 8601 字符串。内核只进行字典序比较，不执行其他时间操作；解析和格式化由宿主负责。

**范围**为 `{service_id, owner_user_id, companion_profile_id}`，刻意排除 agent id 和 model id。用户切换模型后不应发现伴侣忘记了自己，因此产生记录的 agent 会写入 `Provenance::agent_id`，它只是元数据，不是身份标识。

**不变量**在 DESIGN.md 第 5 节编号为 I1–I13，每条都由名称明确的测试固定。如果一条规则值得写下来，就值得让构建在它被破坏时失败。

## 验证

内核没有 C 依赖，只要 Rust 可用即可构建：

```sh
cargo test -p companion-memory-kernel
cargo clippy -p companion-memory-kernel --all-targets -- -D warnings
```

存储 crate 通过 `rusqlite` 的 `bundled` feature 自带 SQLite 源码。在 Windows 上需要 MSVC 工具链；仅安装 Visual Studio 还不够，必须先运行 `vcvars64.bat` 让 `cl.exe` 出现在 `PATH` 中。`scripts/cargo-msvc.ps1` 会在同一进程内完成这一步并转发 cargo 参数：

```sh
.\scripts\cargo-msvc.ps1 -- test -p companion-memory-storage
.\scripts\cargo-msvc.ps1 -- clippy --all-targets -- -D warnings
```

命令中的 `--` 不能省略，否则 PowerShell 会尝试将 `-p` 绑定到自身参数。
