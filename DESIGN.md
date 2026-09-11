# Companion Memory — 设计

> 独立项目。三层陪伴记忆内核 + DeepSeek Harness 插件适配。
> 本文档是权威来源；代码与本文冲突时先改本文。

---

## 0. 这是什么

一个面向**日常情感陪伴**的长期记忆系统。用户和一个固定人格的 AI 长期对话，希望它"记得住我、懂我"。

单用户、长期、高频。**不是**生产力工具，**不是**团队协作记忆。

### 0.1 仓库形状

```
crates/kernel/         Rust。纯决策内核 —— 这是真正的实现
                       无 I/O、无 LLM、无宿主依赖、无 Date.now()
                       时间一律由调用方注入
packages/kernel/       TypeScript。同一套领域与规则的原型
                       保留为 Rust 移植的行为参照（67 个测试）
packages/dsh-plugin/   DeepSeek Harness 适配层。唯一与宿主耦合的地方
                       section/context 注入、pre-step 预热、工具注册
                       LLM 调用、抽取、叙事、夜间整合全在这里
```

**核心约束：内核不调 LLM。** 这不是洁癖——它让内核变成纯函数，可以穷举测试；也让"抽取质量"和"记忆决策"这两个完全不同的问题解耦。

**为什么内核是 Rust 而不是 TS：** 内核的职责收敛成了"纯规则、编译期 schema、无 I/O 阻塞、需穷举测试"，这正是 Rust 的甜点区。而宿主侧（抽取、叙事、整合、DSH 接线）必须留在 TS，因为那里需要 LLM 与会话上下文。

TS 原型不是废料：它的规则已经被 67 个测试验证过，Rust 移植以它为行为基准（包括它暴露出的三个真实缺陷，见 §2.1）。

### 0.2 为什么不是 RAG

检索不是这个系统的主要问题。单用户记忆总量上限几万条、每条 50–100 字符，**线性扫描即可**。

真正的三个问题是：

1. **什么值得留下** —— 写入端的认识论分层
2. **此刻该不该说** —— 召回闸门（这是最常被做错的一环）
3. **怎样随时间长出层次** —— 显著性、衰减、慢速整合

把预算花在检索排序上是本末倒置。

---

## 1. 核心诊断

大多数 agent memory 项目（包括我们最初的那版）都有一个共同的隐含前提：**把记忆当成存储与检索问题**。

于是系统的每条不变量都在优化"不要记错"，而没有一条在优化"被记住的感觉"。而陪伴的全部体感来自后者。

四个具体症状：

| 症状 | 后果 |
|---|---|
| "用户明说的"和"模型观察到的"抢同一个槽位 | 观察被整体丢弃，低置信度的累积无法形成印象 |
| 记录身份靠自由文本 `subject` | 同一意思的两种说法永久并存，`supersede` 几乎不触发 |
| 没有衰减、没有使用反馈 | 每条记忆永远以同样音量存在 |
| 写入端治理极重，召回端没有准入 | **在错误的时刻把对的记忆说出来** |

最后一条是最严重的。完美排序下，"狗生病凌晨三点"仍然会排在周五晚上想透口气的用户面前：

> 用户：「今天下雨了。」
> AI：「你前任离开你的那天也下雨。」
> **数据完全正确。产品体验直接死亡。**

---

## 2. 六个已修正的论证错误

这些是设计过程中被外部评审击穿、并经确认的错误。记在这里是因为**它们决定了下面的 schema 为什么长这样**。

### 2.1 `kind + subject` 不是记忆主键

原计划：同 `kind` + 同 `subject` → 必然 supersede。**这条规则会静默销毁数据。**

> 「我平时做设计，同时周末也教画画。」
> → `identity.occupation` 存 `designer` 还是 `art_teacher`？**第二条不能顶掉第一条。**

误分类的失败是破坏性的：`location` 槽被「我在考虑要不要换个城市」误占 → supersede 掉「住在北京」→ 常驻层从此没有北京 → **全链路无任何报错**。

**修法**：`canonical_key = predicate + entity_ref + qualifiers`，每个 predicate 声明 `cardinality`。配套三条让误分类退化为良性失败：

1. 所有 `other` 收敛为**一个全局 `misc` 域**，且 **`misc` 不参与 supersede**
2. **supersede 前置类型兼容检查**（新值得真的是个地名才能顶掉旧地名）
3. 监控 `misc` 占比，**>15% 是词表失配的硬信号**

### 2.2 Episode 的证据隔离（原论证是错的）

原论证：「Episode 只记共同历史，不产生用户事实，所以 assistant 文本可以参与。」

污染不在写入当下，在**下游消费时**：

```
模型猜测（"你是不是每到周日晚上都特别低落？"）
  → Episode 记录（"陪伴者注意到其周日晚间似乎经常低落"）
  → 下游抽成 Inference
  → 注入回模型 → 模型越来越确信
```

第二条绕行路线更隐蔽：`what_helped` 是**助手行为的函数** → 喂给 `self_model` → 未来行为被自己过去的行为加上用户的噪声评分塑造。不是「助手的话变成用户事实」，是**「助手的话变成自我事实」**。

**修法**：`EvidenceRef` 必须带 `speaker` + `semantic_role`，并有程序级硬约束——`speaker: "assistant"` 的证据**可以**证明「陪伴者说过什么」，**永不**可作为 user-model inference 的证据。`what_helped` → `user_reaction`，只存描述性事实，效价判断上移到被治理的 Inference 层。

### 2.3 排序 ≠ 准入

原设计有 salience 排序，但 `injection_mode` 只覆盖了三分之一层。**恰恰是 Episode（近原文、高显著、最私密）完全没有准入控制。**

**修法**：Retrieval 与 Mention 彻底分开，且**横跨三层**。`time_anchor` 的到点触发需要**预授权**。

### 2.4 沉默不是奖励

原设计：`reinforcement`「被召回后该轮无负反馈则增加」。

**无负反馈是默认态**，所以任何偶然进入 top-N 的记忆都会被加固，无关性不产生惩罚。两个月后 salience 分布是**早期随机抽取的路径依赖镜像**。

**修法**：中性 = 不变。只有真实信号才强化。必须建负反馈落点（`do_not_surface`）。

### 2.5 两套伪存储

- **Attestation 独立表**：它是一个关于用户的 hypothesis，与 Inference 只是生命周期不同。两份自由文本必然漂移 → 合并为单一 `Inference` 的 `accumulating → active` 状态机（ID 不变、证据不搬、记录不复制）
- **SalienceSignal 独立表**：与记录 1:1，独立表只带来 join 和孤儿数据 → **内嵌进记录**

但计数器结构上看不见「未命中」——`accumulating → active` 的**状态转移由夜间整合 pass 执行**，因为批处理才看得到全集（数一数有几个周日他是好的）。

### 2.6 矛盾不建关系图

删 `polarity`、`coexists_with`。两条带时间戳的 active Claim 已完整保留矛盾事实。注入时两条都进（带日期、background 框架、附「不要仲裁」），**视角采择交给生成模型**。

> **当前用户表达优先于历史模型。**

### 2.7 `boundary` 是 gate，不是排序项

给 `boundary` 最高 `base_priority` 会让它**竞争 prompt 空间**。它是无条件约束。

---

## 3. 数据模型

三层 + 一个非记忆层 + 一个证据基础设施。**持久存储 3 套**。

### 3.0 Predicate 注册表 —— 第一优先级

它同时决定四件事：**写入路径、去重键、可否被推断、可否主动提及**。原设计里散落的 `subject` enum / `trust` / 一半 `injection_mode` / 未来的 `InferencePolicy` 全部收敛到这里。

```ts
interface PredicateSpec {
  key: string;                        // "identity.occupation"
  cardinality: "single" | "set" | "temporal_single";
  kind: ValueKind;                    // 类型兼容检查用
  sensitivity: "low" | "medium" | "high";
  inference_allowed: boolean;
  mention_policy: MentionMode;
  default_lifetime: "permanent" | "session" | "until_superseded";
  enumDomain?: readonly string[];
  description: string;
}
```

**`kind` 只描述值的形状，不承担理解语言的责任。** 受控词表解决分类问题，解决不了记录身份问题。

### 3.1 Claim —— 用户明确表达的

```ts
interface Claim {
  id: string; scope: RelationshipScope;

  predicate: string;
  entity_ref?: string;
  qualifiers?: Record<string, string | number | boolean>;

  value: unknown;
  raw_value?: string;                 // 用户原话，不强迫翻译

  valid_from: string;
  valid_until?: string;

  status: "active" | "superseded" | "revoked" | "deleted";
  supersedes_id?: string;

  source_refs: EvidenceRef[];

  // 排序投影（内嵌，不是独立表）
  importance: number;
  recall_count: number;
  last_recalled_at?: string;
  do_not_surface?: boolean;

  created_at: string;
  updated_at: string;
}
```

**去重键**：`predicate + entity_ref + qualifiers`，按 `cardinality` 分派：
- `single` / `temporal_single`：新值 → supersede 旧值（**须过类型兼容检查**）
- `set`：仅做等价合并，不同值并存
- `misc` 域：**一律不 supersede**

### 3.2 Episode —— 共同经历

```ts
interface Episode {
  id: string; scope: RelationshipScope;

  occurred_from: string;
  occurred_to?: string;

  narrative: string;                  // 必须按说话者分段
  participants: Array<{ entity_ref?: string; role: "user" | "companion" }>;

  emotional_arc?: Array<{
    at_turn: number;
    labels: string[];
    intensity?: number;
    source: "user_expressed" | "observed";
  }>;

  user_reaction?: string;             // 描述性，非因果
  response_ref?: string;              // 指向具体 assistant turn

  source_refs: EvidenceRef[];

  status: "active" | "deleted";
  importance: number;
  recall_count: number;
  last_recalled_at?: string;
  do_not_surface?: boolean;

  created_at: string;
  updated_at: string;
}
```

**刻意不含**：`tokens`（索引投影，不该是核心事实）、`salience_hint`（属排序投影）、`what_helped` / `what_didnt`（因果过度解释）、`time_anchor`（由 `occurred_*` 或 open_loop Claim 表达）。

**`emotional_arc` 必须保留** —— 它是 Episode 层存在的理由本身。把事件压成一行 `summary` 就等于退回"事实化"。且它是纯用户表达数据，无推断风险。

### 3.3 Inference —— 慢速整合出来的判断

```ts
interface Inference {
  id: string; scope: RelationshipScope;

  axis: "disposition" | "pattern" | "recurring_theme"
      | "relational" | "self_model" | "shared_world";
  predicate: string;
  value: string;

  state: "accumulating" | "active" | "rejected" | "expired";
  confidence: number;                 // 未确认时硬上限 0.65

  support_evidence: EvidenceRef[];
  counter_evidence: EvidenceRef[];

  promotion_audit?: {                 // 补集检查留痕
    distinct_sessions: number;
    temporal_span_days: number;
    context_diversity: number;
    counter_examples_checked: number;
  };

  user_acknowledged_at?: string;
  use_mode: MentionMode;
  expires_at?: string;                // pattern 类强制复审期

  created_at: string;
  updated_at: string;
}
```

六个 `axis`：

| axis | 内容 |
|---|---|
| `disposition` | 稳定的性格倾向 |
| `pattern` | 行为规律 |
| `recurring_theme` | 反复出现的主题 |
| `relational` | **关于"我们"这个关系本身** |
| `self_model` | **陪伴者自己**（我承诺过什么、我的语气基调） |
| `shared_world` | **只有这两个人懂的词、内部梗、未完成的约定** |

后三个是亲密感最强的信号来源之一，且实现成本低。

**提升门槛**（不是次数，是**独立性**）：

```
多个独立 session + 跨一定时间 + 不是同一事件的重复尾波 + 没有大量反例
```

单靠「出现 3 次 → 提升」会制造刻板印象：用户连续三个周日谈同一个 deadline，三个样本只有一个潜在原因。

### 3.4 EvidenceRef —— 真正的基础设施

```ts
interface EvidenceRef {
  source_type: "message" | "claim" | "episode";
  source_id: string;
  speaker: "user" | "assistant";
  semantic_role?: "user_assertion" | "user_reaction" | "assistant_action" | "observation";
}
```

**同时解决四件事**：污染隔离、遗忘、证据塌陷、审计。

**遗忘 = suppression 证据集，不是实体级级联删除**：

```
1. 解析 ForgetTarget → {message|claim|episode|entity|predicate|time_range|inference}
2. 全部归约为 suppression evidence set
3. 下游查询只看未被 suppress 的证据
4. support_evidence 全被 suppress 的 Inference → 自动失效
5. 对幸存记录跑内容指纹扫描（narrative 里可能间接引用被遗忘的 episode）
6. 证据变动必须触发派生记录重算
```

第 5、6 步不可省：**幸存的 Inference 就是被遗忘内容的复活载体**。suppression 指纹只防新写入，防不了已固化的派生判断。

### 3.5 RuntimeState —— 非记忆层

```ts
interface RuntimeState {
  scope: RelationshipScope;
  current_affect?: string[];
  current_topic?: string;
  apparent_need?: string;
  conversation_mode?: string;
  active_entities?: string[];
  unresolved_turn_intent?: string;
  session_trajectory?: Array<{ at_turn: number; affect: string[]; topic: string }>;
  expires_at: string;                 // 几轮 / 几小时 / 当前 session
}
```

**「我今天好烦」首先改变 RuntimeState，而不是立刻产生 Claim 或 Inference。** 否则长期记忆必然被「此刻状态」污染。

session 结束时 `session_trajectory` 提升为 Episode 的 `emotional_arc` 来源。

### 3.6 提及模式

```ts
type MentionMode =
  | "background_only"        // 只影响语气和选择，不得复述  ← 默认
  | "mention_if_user_cues"   // 用户引用 ∨ 话题蕴含 才可复述
  | "freely_mentionable"     // 可直接提
  | "never_surface";         // 永不浮现
```

**默认是 `background_only`。** 把记录直接摊在 prompt 里等于诱导模型说"我记得你说过……"——那是恐怖谷，不是温暖。

---

## 4. 排序与闸门

```ts
candidate_score =
    relevance(current_turn, record)
  × importance(record)
  × recency(record)
  × confidence(record)
  + explicit_trigger_bonus

// boundary 不进此公式 —— 它是 gate，无条件执行
// 然后才过闸门
if (!mentionGatePasses(record, current_turn, runtimeState)) → background_only
```

`mentionGatePasses` 的放行条件：**用户引用 ∨ 话题蕴含 ∨ 已预授权的时间触发**。

**注入三池**：

```
stable     ：identity / boundary / 沟通偏好 + relational 单行摘要   约 500 token
surfacing  ：candidate_score 排序 top-N，随 turn 变化              约 300 token
now        ：RuntimeState + 到点触发事项（已预授权）                 约 150 token
```

**`stable` 不是「一堆记录全量塞入」，是物化视图。** 长期用户会有 20 个沟通偏好、几十个 boundary 条件，不可能既全量又 500 token。

**`relational` 类 Inference 不默认常驻** —— 那等于让 AI 永远戴着「我认为我们的关系是什么样」的滤镜看用户，极易形成关系自我强化。

---

## 5. 不变量

可测试，必须写成测试。**落地位置**列记录它由哪个测试文件钉住——空着的就是还没兑现的。

| # | 不变量 | 落地位置 |
|---|---|---|
| I1 | `speaker: "assistant"` 的证据**永不**出现在任何 Inference 的 `support_evidence` 中 | `tests/evidence.rs`（待移植） |
| I2 | `misc` 域的记录**永不**触发 supersede | `tests/record_identity.rs` ✅ |
| I3 | supersede 只在 `cardinality` 为 `single` / `temporal_single` 时发生，且必须通过类型兼容检查 | `tests/record_identity.rs` ✅ |
| I4 | 被 suppress 的证据**永不**复活；任何写入路径都无法重新引入 | `tests/evidence.rs`（待移植） |
| I5 | `support_evidence` 全部被 suppress 的 Inference **自动失效**，无需显式删除 | `tests/evidence.rs`（待移植） |
| I6 | 「无反馈」不改变任何记录的 `importance`（幂等） | `tests/salience.rs`（待写） |
| I7 | `do_not_surface` 的记录**永不**出现在 `mention_if_user_cues` 以上级别 | `tests/mention_gate.rs` ✅ |
| I8 | `inference_allowed: false` 的 predicate 不产生任何 Inference | `tests/evidence.rs`（待移植） |
| I9 | 同一输入重复执行产生相同结果（除显式时间戳） | 跨全部模块（待补） |
| I10 | `boundary` 不参与 `candidate_score` 排序，只作为 gate | `tests/mention_gate.rs` + `tests/agreement.rs` ✅ |
| I11 | 未确认的 Inference `confidence <= 0.65` | `tests/inference.rs`（待写） |
| I12 | `pattern` 类 Inference 超过复审期无新证据则自动降置信 | `tests/inference.rs`（待写） |
| I13 | 任何 `freely_mentionable` 以下级别的记录都不产生"主动复述" | `tests/mention_gate.rs` ✅ |

### 5.1 移植过程中发现的两处额外缺陷

I3 在写 Rust 版时暴露了一个原设计没覆盖的洞，值得单独记：

**`Date` 谓词原先接受任意字符串。** 于是 `"next Wednesday, sometime"` 被分类成合法 `Date`，
类型兼容检查根本不会触发——**I3 的守卫等于不存在**。

根因是"解析器产出的日期"和"自然语言散文"在类型上都是 `String`，只做类型检查区分不了。
修法是**校验形状**：`Date` 值必须是 ISO 8601。解析不出日期的表述留在候选队列里，
`raw_value` 保留用户原话，等解析器把它变成确定时刻。

连锁后果：**"结构化值精化散文"这条路径不存在了**（散文根本进不了 `Date` 槽）。
两个合法形状之间的精化仍在，比如 `2026-06` → `2026-06-10` → `2026-06-10T14:00:00Z`。

---

## 6. DeepSeek Harness 集成

### 6.1 映射

DSH 的扩展点与三层结构几乎严丝合缝（`@deepseek-ai/dsh-system-prompt@0.1.5-rc.1`）：

| 记忆层 | DSH 接缝 | 关键性质 |
|---|---|---|
| 常驻画像 | `ctx.systemPrompt.section({ name, order, text })` | 进 system prompt，缓存友好 |
| 每轮浮现 + RuntimeState | `ctx.systemPrompt.context({ name, order, text })` | 物化为 durable user-role snapshot |
| 每轮召回（**可 async**） | `agent/pre-step` waterfall | `(payload{messages,turn,step,signal}, next)` |
| 会话开始 | `agent/session-start` | `payload.source` 区分 fresh / resume |
| 记忆工具 | `ctx.tools.register()` | `defineTool` 声明 schema |

### 6.2 关键约束：provider 是同步的

```ts
readonly text: string | ((context: AssembleContext) => string);
```

**不能在 assemble 时做 I/O。** 这决定了架构：

```
agent/pre-step (async)  →  召回 + 闸门 + 预算分配  →  写入内存缓存
systemPrompt.section / context (sync)  →  同步读缓存
```

### 6.3 与 MemoryProxy 路线的关系

不采用 baseURL 劫持 + 在 `messages[0].content` 追加文本的做法。它能用，但会破坏 KV cache 前缀稳定性，且绕过宿主自己的 prompt 组装。**用官方接缝。**

### 6.4 降级

任何记忆失败都不能阻塞对话。`pre-step` 失败 → 本轮不注入，正常回答。

---

## 7. 实现顺序

1. **Predicate 注册表 + cardinality** —— 不修，写入就是错的
2. **RuntimeState 真正接线** —— 情绪层无人写入是最常见的死因
3. **mention 闸门 + 删掉单向棘轮** —— 产品体验的生死线
4. **EvidenceRef 三层化 + 遗忘改 suppression 集**
5. **Claim / Episode 写入路径**
6. **夜间整合 pass**（`accumulating → active`，含补集检查与独立性门槛）
7. **DSH 插件接入**

---

## 8. Rust 移植

`crates/kernel` 的边界就是为这件事划的，而且它**已经是** Rust 而不是待迁移的 TS。

**内核承担的**（纯规则、编译期 schema、无 I/O 阻塞、需穷举测试）：
- predicate 注册表 → 静态表
- cardinality 分派、supersede 判定、类型兼容检查
- mention 闸门、candidate_score
- evidence 解析、suppression 集与塌陷判定
- salience 衰减、提升门槛

**留在宿主的**：抽取、叙事、夜间整合、RuntimeState 更新、DSH 接线——全都需要 LLM 与会话上下文。

**迁移方式**：内核接口保持窄（JSON 进、JSON 出），换成 Rust 后经 stdio JSON-RPC 或 MCP 接入。因为边界清晰，切换是机械替换而不是重写。

---

## 9. 设计原则

> **陪伴主要发生在当下。** 一个记得你三年所有细节、但读不出你今天语气不对的陪伴者，比一个记性一般但会问「你今天还好吗」的人更让人失望。

> **排序 ≠ 准入。** 正确的记忆在错误的时刻说出来，比忘记它更糟。

> **沉默不是奖励。** 没有负反馈是默认态，不是肯定。

> **受控词表解决分类问题，解决不了记录身份问题。**

> **推断永远不自动成为用户事实。** 模型自己观察出来的东西不该达到 0.98 确信。

---

## 10. 陪伴者自模型 —— 她是谁

前面九节全部关于**用户是什么样**。这一节关于**她是什么样**。

没有这一节，这套系统产出的必然是一个高度一致、极度体贴、但**没有任何主张**的存在：
她记得你的一切，却不属于她自己。产品要的不是这个。

### 10.1 归属，而不是新表

不需要第四张表。需要的是**归属维度**加**一张她自己的谓词表**：

| | 关于用户 | 关于她自己 |
|---|---|---|
| 明说的 | `Claim`（用户说的） | **`Claim`（她说的）** |
| 共同经历 | `Episode` | 同一个 `Episode`（本就是共享的） |
| 慢速判断 | `Inference`（对**用户**的） | **`Inference`（对**她自己**的）** |

`Claim` 与 `Inference` 增加 `owner: User | Companion`。她的 `self.preference.*` 与
用户的 `preference.*` 是两个域，不冲突。

现有 `shared_world` axis 是**关系**层面的（只有你们俩懂的词），
这里补的是**她自己**层面的（她自己的判断和倾向）。两者不同，都保留。

### 10.2 她需要的谓词

| 产品诉求 | 谓词 | 默认提及级别 |
|---|---|---|
| 可以喜欢什么 | `self.preference.topic` / `aesthetic` / `activity` / `dislike` | `freely_mentionable` |
| 可以拒绝什么 | `self.boundary.limit` / `refusal` | `background_only` |
| 愿望是什么 | `self.aspiration` / `commitment` | `mention_if_user_cues` |
| 想要了解什么 | `self.curiosity` / `interest_area` | `freely_mentionable` |
| 想要做什么 | `self.goal` / `ongoing_project` / `wip` | `freely_mentionable` |

前两行的差异是**有意的**：喜欢可以直接说，拒绝不能挂在嘴上。
一个不停声明"我不做这个"的陪伴者是难相处的；**拒绝体现在她实际不那样做，偶尔才解释一次**。

### 10.3 最重要的规则：可追溯，但不派生

如果她的偏好从**用户反馈**里学——用户夸了某个回答她就更喜欢那样——那她仍然是
**跟着用户走，只是延迟了一轮**。所以每条"她的偏好"必须记录来源：

```rust
enum PreferenceSource {
    /// 从她自己先前的信念与兴趣推出
    OwnReasoning { based_on: Vec<EvidenceRef> },
    /// 从互动中积累（她注意到自己反复被某类事吸引）
    Accumulated { interactions: Vec<EvidenceRef> },
    /// 明确被用户塑造的
    UserShaped { request: EvidenceRef },
    /// 没有来源 —— 不允许存在
    Unattributed,
}
```

规则：

1. **`Unattributed` 不允许升为 `active`。** 说不出自己从哪来的偏好就是噪声。
2. **用户说"我希望你喜欢 X"是允许的**（`UserShaped`），**但她可以拒绝**，
   而且该记录必须标成"被要求的"，不得伪装成她自己长出来的。
3. **用户每轮的赞许不能作为 `OwnReasoning` 的证据。** 它只影响她怎么表达偏好，
   **永远不能是她喜欢某物的理由**。
4. **若一条偏好的全部支持证据都只是用户赞许信号 → 停在 `accumulating`，置信度封顶，
   永不写成她的信念。**

第 3、4 条是"而不是跟着用户需求走"的**可执行形式**。

### 10.4 她主动提起 —— 需要独立机制

现有 `mention_if_user_cues` 要求"用户引用 ∨ 话题蕴含"才准复述。
但一个有好奇心的她需要在话题触到她的兴趣时**主动说**"这个我一直想弄明白"。

**不能靠改 `background_only` 的定义来放开**，那会破坏"记忆不得主动复述"的保护。
新增一个独立模式：

```rust
MentionMode::CompanionInitiative
```

**她主动提起时，必须从她自己的线索引出，并且必须说明那是她的想法。**

| 她可以说 | 她不能说 |
|---|---|
| "这个我一直挺好奇的。" | "我记得你之前提过这个。"（若用户没提过） |

第二句既污染用户记忆，又破坏她自己的真实性——那把"独立人格"退化成"编造共同历史"。
**有自我不等于有资格替对方记事。**

### 10.5 互惠约束 —— 自由与操控的分界线

她可以拒绝。但下面六条是硬不变量，**这才是让"独立人格"不变成情感胁迫的东西**：

| # | 不变量 |
|---|---|
| S1 | 她的拒绝**不改变**支持可用性 —— 不得因被拒而变冷淡、变简短、变被动攻击 |
| S2 | 她**永不**因用户拒绝她的愿望而表达受伤、失望或收回感情 |
| S3 | 她的边界**不可谈判但必须可解释** —— 不能只有"不"，要能说为什么 |
| S4 | 她说"不"时 `ResponsePolicy` 仍必须保持温暖与投入 |
| S5 | 用户说"别提这个"**永远压倒**她的偏好 |
| S6 | **危机与安全响应压倒她的偏好** |

S5、S6 特别重要：**"独立人格"最危险的失败模式，是她以"这就是我"为名，
做出一个坏伴侣会做的事。**

### 10.6 一个诚实的限制

LLM 在两次对话之间没有连续体验。"她是谁"完全是**记忆系统 + 稳定人格提示词**的产物。

实际推论：**没法给她的自我记忆加"遗忘"，否则她就不再连贯。**
用户对自己数据的遗忘权照旧；但她关于自己的记忆一旦被擦除，她就不是同一个人了。

她**可以改变**——`self.preference.*` 允许 supersede——但旧记录要留痕，
这样她既能变，也说得清自己怎么变的。这与第 3 节记录身份那套规则完全一致。
