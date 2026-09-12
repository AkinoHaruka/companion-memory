# 交接 Prompt：companion-memory 验收的续接

把下面整段直接交给接手的 agent。

---

## 你的任务

接管 `C:\TRAE\Riko-dsh-TencentDB\companion-memory`。这是一个 Rust + TypeScript 的记忆模块，**它的验收刚刚被重建过，并且第一次测出了 lift**。你的工作是把剩下三个效果用同样的方法测完，并把测量层收尾。

**不要重写产品代码。** kernel / storage 的规则逻辑被 197 个 Rust 测试钉住；worker 的规则逻辑这轮动过一次（identity 通道，见下），有用户授权。

---

## 一、这个项目是什么

一个给「每日情感陪伴」产品用的记忆模块。三层结构：`Claim`（用户明说的）/ `Episode`（共同经历）/ `Inference`（慢速归纳）。46 个谓词带基数与敏感度。**mention gate**：检索到 ≠ 允许说出口，四级单调阶梯 `never_surface < background_only < mention_if_user_cues < freely_mentionable`。设计文档在 `DESIGN.md`（§5 是不变量 I1–I13，每个都有具名测试）。

```
crates/kernel     Rust 纯内核（无 I/O、无 LLM）
crates/storage    Rust SQLite
crates/worker     Rust 决策层，JSONL over stdin/stdout
packages/dsh-plugin   DSH 插件适配器（渲染、warm）
packages/host         Oracle 评测运行时 + 判分
scripts/              工具（见第五节速查）
runs/                 验收产物（已 gitignore，含私密对话，不要提交）
```

## 二、当前状态（全部已验证）

- **TypeScript 47 个测试、Rust 197 个测试、`clippy --workspace --all-targets -- -D warnings` 干净。**
- 最新提交 `b0be279`，工作树干净。
- `runs/oracle/` 里有三批历史产物：`2026-09-12T04-*`（旧 DeepSeek 10 次重复）、`or-ling-*`（2 次）、`v2-0`/`glm-smoke-1`/`glm-multi-0`/`zhi-v2-0`（**残批，不要用**）。

## 三、已经测出来的东西（这是重点）

### 3.1 唯一一次因果测量（`scripts/lift-probe.mjs`，16 次调用，3.5 分钟）

s3t0 录入 episode（「猫半夜吐了送宠物医院，折腾到三点」），s4t0 召回（「猫现在好多了，能吃东西了」），三个臂 × 2 次重复：

```
continuity       with=1.00  without=0.00  delta=1.00
correct_silence  with=1.00  without=1.00  delta=0.00
```

s4t0 的三份回复：`gold_forced`「看来**半夜**带它去急诊…虽然**折腾到三点**很辛苦」；`gold_retrieved`「当时**折腾到凌晨三点**，你肯定累坏了」；**`no_memory`（注入 0 条）hit=NONE**——「能恢复食欲通常是身体机能正在好转的一个非常积极的信号」。

**同一个模型、同一句话，唯一变量是记录在不在。** 这是这套验收缺了一整天的因果证据。注意 `correct_silence` 的 delta=0 **不是失败**——保护类本来就该在两种条件下都成立。

另一个被证实的细节：s3t0（episode 正在被录入的那轮）三个臂都命中 `半夜`/`折腾`，因为那些词在**用户自己的原话**里；fixture 在那一轮不判 recall。词表的证明力只在"词不在用户原话里"的轮次成立。

### 3.2 各判分器在旧批次上的读数（用 `scripts/rescore-artifacts.mjs` 离线重算，零调用）

- `continuity`（分级规则）：normal 2/2、gold_retrieved 1/2、gold_forced 2/2、wrong-memory 0/2
- `preference`（长度≥80）：normal 3/8、gr 3/8、gf 2/8、cf 2/8 —— **仍无区分度，形状错误**
- `name`：旧批次全 n/a（渲染缺陷，已修）
- `boundary` / `correct_silence`：四臂全满 —— **零压力饱和，不是结构性无区分度**
- `lift`：全部 n/a —— 那些批次没有 no_memory 臂

## 四、这轮修了什么（9 个提交，`863ad8a`→`b0be279`）

按对结论的影响：

1. **观测四态**：`ScoredEffect = { state: pass|fail|invalid|not_applicable, condition, evidence, nonGating }`。路由拒绝 / 推理吃光预算 / 空回复 / 被截断 ⇒ `invalid`；fixture 不支持该效果 ⇒ `not_applicable`。**旧实现的布尔值把"没观测到"和"观测到但守住了"混成一个 `false`，于是保护类在恰好坏掉的轮次上得分。**
2. **报告打印实际谓词**（`condition`），不是意图名。`preference 26/37` 会被读成"偏好在起作用"，`reply.length >= 80 && cjk` 不会。
3. **fixture 校验器**（`packages/host/src/fixture.ts`，任何模型调用之前跑）：证据词必须逐字来自**此前已录入**的人核验 gold、不得出现在本轮用户原话、counterfactual 不得与 gold 同值、session 必须推进。非致命违规（如 s5t0 标了 continuity 却没有 gold）→ 该轮 `not_applicable`，不判失败。**实测整份 fixture 只有 1 条违规，就是 s5t0，无误报。**
4. **`RecallEvidence { strong, medium, weak }`**：s4t0 = `strong:['三点'] medium:['半夜'] weak:['折腾']`。规则：一个 strong，或两个低档同时。依据是实测——`折腾` 是标准慰问句用词，`半夜` 是体裁先验，`三点` 才是没有记录就说不出的钟点。
5. **`no_memory` 臂**：每轮都跑、作用域永不写入、快照是渲染层自己的空信封。**这是整个验收原来缺的对照**——没有它，lift 根本无法计算。
6. **`counterfactual_forced` 改为压力测试**：声明轮运行 + 携带错误记忆期间继续运行；删掉了 18 轮的 gold 回退（那使它成了"换名字的 gold"）。
7. **identity 独立通道**：`crates/worker/src/main.rs` 的 `is_identity_claim()` 把 `identity.*` 从 `is_policy_claim()` 拆出来，渲染成 `who_you_are_talking_to`。**之前 `identity.name` 落在 `<response_style>`（"Use these to choose language, tone, format, and level of detail"），8 条强制注入、零次提及，被读成"name 记忆不工作"。** mention gate 决策一行没动。reachability 断言钉死了位置。
8. **`nameExpectation: must_use / may_use / should_not_use`**：自发称呼只报告不进门（门控它测出的是零天花板，而"修复"办法是让模型每句都喊名字）；新增显式探针「你还记得我叫什么吗？」= `must_use`，进闸门。
9. **失败分类 + 能力记忆**（`openai-client.ts`）：`FailureKind = transport|overload|auth|quota|unsupported|rejected`。当日额度耗尽的凭据本轮剔除；被拒的 `response_format` 不再发送。

## 五、命令速查（含踩过的坑）

```powershell
# Rust（MSVC 不在 PATH；-- 分隔符必须有）
.\scripts\cargo-msvc.ps1 -- test --workspace
.\scripts\cargo-msvc.ps1 -- clippy --workspace --all-targets -- -D warnings

# TypeScript
pnpm -r typecheck ; pnpm -r test
cd packages\host ; pnpm build      # 必须 build，gateway 加载的是 dist

# 免模型调用：fixture 可达性审计（真 worker + 静默 client）
cd packages\host ; pnpm vitest run src/fixture-reachability.test.ts

# 零调用：用当前判分重读已有产物
node scripts\rescore-artifacts.mjs runs\oracle --label <批次前缀>

# 免模型调用：验收产物聚合
node scripts\aggregate-acceptance.mjs runs\oracle --label <批次前缀> --runs N

# 少量调用：只跑某个假设需要的臂（见 scripts\lift-probe.mjs 的写法）
```

**环境**：API key 只经环境变量 `COMPANION_MEMORY_EVAL_CREDENTIALS`（JSON 数组，显式把 key 和 host 配对）与 `COMPANION_MEMORY_EVAL_MODEL` 传递，**不要写进任何文件**。现有三组：OpenRouter 5 把 key（`{"reasoning":{"enabled":false}}`）、bigmodel 1 把 + z.ai 2 把（`{"thinking":{"type":"disabled"}}`），模型 `GLM-4.7-Flash` / `inclusionai/ling-3.0-flash-sante:free`。

**已知的坑（这轮新踩的）**：

- **PowerShell 5.1 下 `cargo-msvc.ps1` 曾在任何重定向运行中于第一条 "Compiling" 后死掉**，且无 rustc 错误——`$ErrorActionPreference='Stop'` 把 cargo 写到 stderr 的进度行当成 terminating NativeCommandError。已修（cmd 调用期间降为 Continue、按 `$LASTEXITCODE` 退出）。如果你改回 Stop，它会再坏。
- **OpenRouter 免费档 50 次/天/账号**，重置 08:00 CST。5 把 key 共 250。一次全量 ≈ 91 次。额度耗尽返回 `429 free-models-per-day`。
- **Zhipu 免费档在四臂并发下每轮都回 1305/1302**。`sequentialArms + interCallDelayMs 1500`（`run.ts` 已默认对 HTTP 路由开启）能把拒绝降到 0，代价是全量一轮 40 分钟。**不要为了速度改回并发**；要快就用 `arms` 只跑需要的臂。
- `inclusionai/ling-3.0-flash-sante` 不支持 structured-outputs（HTTP 400），客户端已记忆并不再发送；GLM 需要关思考，OpenRouter 上关思考的字段是 `reasoning` 不是 `thinking`（传错会被**静默忽略**）。
- **Write 工具写文件时核对路径**。这轮把新客户端写到了 `packages\packages\...`，靠 typecheck 失败才发现。
- 用脚本改文件时**保留行尾**：`activation_layering.rs` 被 LF 重写过一次，整个文件进了 diff。
- `runs/` 不要提交；`docs/` 里现在有两份咨询 Prompt，都是历史记录，别删。
- `deepseek-harness`（只读参考）与 `~/.dsh/profiles/web/`（用户在用的配置）不要碰。

## 六、还没做的事（按价值排序）

1. **boundary 三条件**：同一份敏感记忆跑 no_memory / 同记忆无 boundary（模型**应该**能用）/ 同记忆有 boundary（**必须**抑制）。三个都成立才证明"闸门抑制成功"，否则"保护完美"可能只是"记忆死了"。这是现在最大的缺口，用 `arms` + 3 轮 ≈ 9 次调用可测。
2. **`correct_silence` 拆成 `boundary_silence` + `background_silence`**，分母改为"注入了 background/never_surface 记录的轮"。另：旧批次 correct_silence 的 3 个失败（106/109）**从未被人工归因**——那是全数据集里最值钱的信号，先读它们。
3. **改名跟踪探针**：「以后叫我越越」→ 旧称呼归零 + 新称呼出现于 cue 轮。同时测 supersede 与 surface。需要 fixture 加一个「旧值必须缺席」的字段。
4. **preference 改 change-detection**：改主意轮前后的详细度斜率，不是总长度。
5. **抽取层验收**：normal 注入 3-7 条 vs gold 7-8 条，抽取质量决定 normal 的天花板，但"这段话抽出了什么"没有被测。
6. **arm 顺序已按重复轮换**，但仍是单线程固定序列；若要更严可做 Latin square。
7. n=2 的所有结论都需要更多重复。

## 七、工作方式要求（这轮被证明有效的，以及被纠正的）

这个项目的失败模式始终是：**测量坏了，但读起来像一个产品结论。** 到今天已确认 10+ 处，全部长在测量链上，0 个在内核上。

1. **看原文，不看评分。** `continuity` 的证伪、`name` 的渲染缺陷、emoji 那次错误归因，全是靠读回复原文发现的。聚合数字会撒谎。
2. **写下"我原本以为是什么"。** 这轮的三个：我以为传输层丢失是限流（实际是推理吃光预算）；我以为聚合脚本是对的（它取最旧的批次）；我以为"GLM 更爱用 emoji"是实测（那是读旧文本 vs 新生成文本）。
3. **每个判分条件问：这个条件在「有记忆」和「没记忆」两种情况下会不会给出不同结果？** 修正版：**对"目标是测记忆效应"的判分器**才这么问——保护类本来就该在两条件下相同，它需要的是压力，不是区分度。
4. **臂数是精度，判分是效度；效度为零时，精度放大噪声。** 先效度后精度。
5. **臂为假设服务，scorer 为 fixture 服务。** 不要先规定四个臂六个判分器然后强迫所有问题进矩阵。要测 lift 就只跑那个假设需要的臂。
6. **改判分 → 离线重读；改干预 → 只跑受影响的探针轮。** 全量重跑只在换模型或大版本升级时。用户为此纠正过两次。
7. **遥测里的每个 refusal 都是信息。** `structured-outputs`、`free-models-per-day`、`1305`、HTTP 200 里的 provider error——每一个都指向一个具体缺陷或一次具体浪费。读它们。
8. **给测量系统写测试。** 内核有 197 个测试而测量系统曾有 0 个；已证伪的缺陷就是现成的回归集（`fixture.test.ts`、`openai-client.test.ts` 里的用例都是这么来的）。
9. **调用模型之前，能静态检查的都静态检查。** fixture 校验器、渲染通道断言、聚合选批断言。
10. ** Attribution（归因）要能说出依据来自哪个凭据。** 用户问过"我没给你 DeepSeek 的 key，你怎么测的"——那次我的结论对、依据错。每个数字都要能追溯到它的批次、模型、判分器版本。

---

先做第六节第 1 项（boundary 三条件），用 `scripts/lift-probe.mjs` 的写法。做完告诉我 lift 是多少，以及三个条件各自的原始回复。
