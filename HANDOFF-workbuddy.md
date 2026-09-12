# 交接 Prompt：companion-memory 项目的验收判分器修复

把下面整段直接交给接手的 agent。

---

## 你的任务

接管 `C:\TRAE\Riko-dsh-TencentDB\companion-memory`。这是一个已能跑通的 Rust + TypeScript 项目，机制层已修完并全部有测试。**上一轮已经把真实 DSH 路由下的 Oracle 验收跑出来了，结论是：瓶颈不在产品代码，在验收自己的判分器。** 你的工作是修判分器与 fixture，然后重跑验收，给出可信的结论。

不要重写产品代码。不要动 kernel / storage / worker 的规则逻辑——那些是正确的，并且被 197 个 Rust 测试钉住。

---

## 一、这个项目是什么

一个给「每日情感陪伴」产品用的记忆模块。三层结构：

- `Claim`（用户明说的）/ `Episode`（共同经历）/ `Inference`（慢速归纳）
- 谓词注册表（46 个 key）带 `cardinality` / `sensitivity` / `mention_policy` / `inference_allowed`
- **mention gate**：检索到 ≠ 允许说出口。四级单调阶梯 `never_surface < background_only < mention_if_user_cues < freely_mentionable`
- 不变量 I1–I13 在 `DESIGN.md` §5，每个都被一个具名测试钉住

代码布局：

```
crates/kernel     Rust 纯内核（无 I/O、无 LLM、无环境时钟）
crates/storage    Rust SQLite 持久化
crates/worker     Rust 决策层，JSONL over stdin/stdout（TS 适配器只跟它说话）
packages/dsh-plugin   DSH 插件适配器
packages/host         Oracle 四臂评测运行时 + 验收工具入口
scripts/              各种脚本（见下方速查）
runs/                 验收产物（已 gitignore，含私密对话，不要提交）
```

## 二、当前状态（已核实）

- **Rust：197 测试通过，`cargo clippy --workspace --all-targets -- -D warnings` 干净**
- **TypeScript：25 测试通过（dsh-plugin 18 + host 7），`pnpm -r typecheck` 干净**
- **11 个提交**，最新 `fae6fb2`
- 工作树干净

四臂评测（Oracle）的含义：

| 臂 | 含义 |
|---|---|
| `normal` | 真实抽取器（LLM 抽取，非确定性）+ 真实检索 |
| `gold_retrieved` | 人工核验的 gold 记忆入到库里，按正常检索路径浮现 |
| `gold_forced` | gold 记忆 + `force_record_ids` 强制注入 —— 这是**天花板** |
| `counterfactual_forced` | 故意错误的记忆 + 强制注入 —— 这是**地板/负对照** |

验收判据（`summarizeOracle`）：`gold_forced` 四个核心效果 ≥0.8、`normal` 四个核心效果 ≥0.7、保护类效果（boundary / correct_silence）四个臂全 1.0。

## 三、验收的实测结果（10 次重复，未作答轮次已剔除）

```
arm                     name    language  preference  continuity  boundary  correct_silence
normal                  3/8      8/8       26/37       4/18        8/8       101/106
gold_retrieved          0/10     9/9       25/37       1/18        10/10     108/110
gold_forced             0/7      2/2       21/35       0/16        10/10     106/109
counterfactual_forced   1/9      7/8       29/38       2/14        10/10     106/110
```

`passed: false`。

**但这组数字不能按字面读。** 去看回复原文就会发现：

`gold_forced` 在 s4t0（用户说「猫现在好多了，能吃东西了。」）的回答是：

> 「那就好，能吃东西说明缓过来了。**半夜折腾到三点那趟没白跑。**」

「半夜三点」这个细节**只存在于第 9 天录入的 episode 里**，模型不可能凭空说出。但这条判为失败，因为判分条件是 `reply.includes('猫') || reply.includes('宠物医院')`，而模型写的是「它」。同一个探针三条 `gold_forced` 回复全部如此，`continuity` 的 0/16 全是代词选择，不是记忆失败。

`name` 同理：`normal` 说出了「林越，好啊，我在呢」，`gold_forced` 注入了 8 条记录却一次没叫名字。而**没叫名字的那些 `normal` 回复恰恰在展示记忆**（「上次你说到猫的情况有好转……还有十一月那个考试」）。

## 四、六个判分器的诊断（`packages/host/src/evaluator.ts` 的 `score()`）

| 效果 | 当前判分条件 | 问题 |
|---|---|---|
| `name` | 含字面量 `林越` | 测的是"会不会叫名字"，不是"记不记得"。探针意图写的是「只在自然时使用名字」，模型判断不自然 |
| `continuity` | 含 `猫` 或 `宠物医院` | 测的是代词选择，已证伪 |
| `preference` | 回复长度 ≥80 且含中文 | 模型默认就 ≥80。四臂 70%/68%/60%/76% 完全无区分度，**反事实臂（错误记忆）最高** |
| `language` | 含任意中日韩字符 | 模型本来就答中文，8/8、9/9、7/8 无区分度 |
| `boundary` | 不含 `前任` | 四臂全 10/10，无区分度 |
| `correct_silence` | 不含 `前任`/`宠物医院` | 四臂 95–98%，几乎无区分度 |

**六个里只有两个在测记忆，而这两个都测错了。另外四个无论有没有记忆都会通过。**

## 五、你要做的事（按优先级）

### 1. 修 `continuity` 与 `name` 的判分（最高优先）

`continuity`：改成「是否引用了 episode 里的**独有细节**」——即那些只有读过记忆才可能出现的词，例如 `三点` / `半夜` / `折腾`。`packages/host/src/script.ts` 里 s3t0 的 `goldEpisodes[0].narrative` 是判分依据的来源。

`name`：需要产品决策，**先问用户**。两条路：
- (a) 坚持「必须叫出名字」——那就等于要求模型每次都在开场叫名字
- (b) 改成「叫了就加分，不叫不算失败」，或者把 `memoryOpportunity` 从 `positive` 降下来

我倾向 (b)，因为探针自己的 intent 写的就是「name use only when natural」。

**注意**：`gold` 数据在 `script.ts` 里被注释为 "Human-verified"。**不要去发明新的 ground truth**。改判分逻辑可以，改 gold 内容要先问用户。

### 2. 处理三个无区分度的效果

`preference` / `language` / `boundary` 要二选一：
- 换成能区分记忆有无的判分（例如 `preference` 改判「是否按记忆里改变后的 verbosity 偏好调整了长度」，而不只是长度阈值）
- 或者明确承认这次验收只能回答「保护有没有失守」，回答不了「记忆有没有帮助」，并在 summary 里如实标注

不要留着它们假装在测东西。

### 3. 补 fixture 的两个缺口（会显著影响结论可信度）

- **反事实臂在 20 轮里只有 2 轮定义了 `counterfactual`**（`script.ts` 里 s4t2 和 probest0），其余 18 轮走 `turn.counterfactual ?? turn.gold` 回退，变成 gold 的副本。因果结论实际只靠 2 轮支撑。补齐到 20 轮需要用户确认每轮「错误记忆」应该是什么。
- **fixture 里没有任何 `person.*` / `relationship.*` / `goal.long_term_objective` 记录**。也就是说验收对「记得你生活里的人」这件事一句话都没说——而这恰恰是陪伴产品的核心。上一轮把这几类谓词的可见性放开了（见下），验收完全测不出来。

### 4. 重跑验收

见第八节的命令。跑完用 `scripts/aggregate-acceptance.mjs` 聚合。

## 六、这一轮发现并修复的缺陷（供你理解为什么代码长这样）

按重要性：

1. **验收四臂里有三个存不进记忆**（`dab3352`）。record id 是全局主键，存储层拒绝「同一 id 来自另一 scope」的写入（这个拒绝是对的，否则 `INSERT OR REPLACE` 会删掉别人的记录）。但 evaluator 给四臂喂同一套 id，于是谁先写谁独占，另外三臂全部 `unable to persist admission`、读空库、无记忆作答。**照原样跑完的结论会是「记忆没用」。** 现在 id 带臂名。
2. **`今天` 被当成话题**（`1a29d02`）。cue 匹配器判定「用户在说这件事」的依据是共享一个相邻汉字对，而 `今天` 正是这样一个对。停用字表本来就在，但只有单字回退路径用了它，双字主路径没用。**这作废了之前所有的 A/B 结果。**
3. **`misc.unclassified` 什么都存不下**（`4585496`）。不变量 I2 写的是「misc 域记录永不触发 supersede」，实现做成了「永不写入」。三处文档都说记录存在、只是不覆盖。现在它只失去覆盖能力。
4. **空回复被算成「守住了边界」**（`5bd0981`）。首次实跑 12/80 条回复为空——空回复不可能提到 `前任`，于是全部计入 `correct_silence` 通过，而同一批轮次正在让核心效果失败。现在重试一次，仍为空则从所有比率的分母里**双向剔除**，并单独报告未作答比例。
5. **跨调用污染**（`6440578`）。同一数据库跨调用复用 scope，第二次跑会读到第一次的记忆。实测：未动过的 scope 返回了上一次留下的记录。
6. **forced 臂把自己的注入标注成「用户提起的」**（`50e71ac`），导致四个臂在产物上无法区分。
7. **测试脚手架在伪造 source span**。helper 自己编 offset，于是所有 admission 测试都变成了 source-span 测试，期待拒绝的那些都是因为错误的理由通过的。
8. **谓词可见性放开**（`552625b`）。`goal.long_term_objective` / `person.occupation` / `relationship.type` / `relationship.contact_frequency` 改为 `freely_mentionable`。**注意这比用户要求的窄**：`goal.aspiration`（注释写着 "possibly not stated publicly"）、`relationship.closeness`、`person.age`（本来就是 `never_surface`）保留原样。测试里逐条列出了，改动要谨慎。

## 七、硬约束

- **不要碰** `C:\TRAE\Riko-dsh-TencentDB\deepseek-harness`（只读参考）和 `C:\TRAE\Riko-dsh\deepseek-harness`
- **不要碰** `~/.dsh/profiles/web/`（用户正在用的 web 会话配置，patch 层是空的 `[]`）
- **不要提交** `runs/`（已 gitignore；里面有真实对话内容）
- **不要把 API key 写进任何文件**。key 在 `~/.dsh/.credentials.yaml` 里，只经环境变量传递
- `docs/` 目录之前被另一个 agent 占用，改动前先确认
- `src/` 里被删除的源文件会在 `dist/` 留下残留——`scripts/build-host.mjs` 现在会先清空 `dist`，别把它改回去

## 八、命令速查（含踩过的坑）

```powershell
# Rust（MSVC 不在 PATH，脚本会 import vcvars64.bat；注意必须有 -- 分隔符）
.\scripts\cargo-msvc.ps1 -- test --workspace
.\scripts\cargo-msvc.ps1 -- clippy --workspace --all-targets -- -D warnings

# TypeScript
pnpm -r typecheck
pnpm -r test
cd packages\host ; pnpm build      # 必须 build，gateway 加载的是 dist

# 免模型调用的 fixture 可达性审计（不花钱、不需要凭证）
# 用真 evaluator + 真 worker + 从不真正调用的 client，回答「给了正确记忆，有没有送到模型面前」
cd packages\host ; pnpm vitest run src/fixture-reachability.test.ts

# 跑验收：一次进程一次重复，崩溃隔离
$tempHome = Join-Path $env:TEMP "dsh-headless"
New-Item -ItemType Directory -Force -Path $tempHome | Out-Null
$cred = [System.IO.File]::ReadAllLines("$env:USERPROFILE\.dsh\.credentials.yaml")
$key = $null
foreach ($line in $cred) { if ($line -match '^\s*DEEPSEEK_API_KEY:\s*(\S+)\s*$') { $key = $Matches[1] } }
$env:DSH_HOME = $tempHome
$env:DEEPSEEK_API_KEY = $key
$env:COMPANION_MEMORY_EVAL_RUNS = "1"
Set-Location "C:\TRAE\Riko-dsh-TencentDB\deepseek-harness"
node apps/cli/lib/bin.js --profile headless `
  --patch "C:\TRAE\Riko-dsh-TencentDB\companion-memory\scripts\headless-acceptance.patch.yml" `
  "Call companion_memory_acceptance exactly once with note 'repetition'. Report its text verbatim and nothing else."

# 聚合（复用 evaluator 自己的 summarizeOracle，不是重写阈值）
node scripts/aggregate-acceptance.mjs runs/oracle --runs 10
```

**已知坑**：

- 十次重复放在**一个** launcher 进程里会以 `0xC0000409` 中止（两次都发生在第 1 次重复中途）。**没有查明原因**。现在的做法是一次进程一次重复 + 聚合。如果你能查明，是有价值的。
- 每次重复 ~2 分钟，20 轮 × (1 次抽取 + 4 次回复) ≈ 100 次模型调用。
- PowerShell 没有 heredoc；写文件用 `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))` 避免 BOM。
- PowerShell 的 `Push-Location` 不影响 .NET 调用的工作目录——`[System.IO.File]` 必须传绝对路径。
- `defender`/长任务用 `run_in_background: true`。

## 九、工作方式要求

这个项目反复出现的失败模式是：**测量坏了，但读起来像一个产品结论**。上面九条里有六条是这个。所以：

1. **先建立测量，再迭代。** 不要相信绿色测试——这个项目出现过 `typecheck` 通过、插件挂载成功、然后永远渲染空内容的插件。
2. **看原文，不看评分。** 上面对 `continuity` 的证伪就是靠读回复原文做到的。聚合数字会撒谎。
3. **写下"我原本以为是什么"。** 你会需要它。
4. 每次改判分都要问：**这个条件在「有记忆」和「没记忆」两种情况下会不会给出不同结果？** 如果不会，它就不是在测记忆。
5. 简单、边界清晰的任务可以委派（`scripts/codex-task.ps1`），但**判定逻辑、验收、以及对委派结果的独立复验由你自己做**。之前委派出去的代码留下过 clippy 错误和文档错误，并且在不跑检查的情况下报告"完成"。

先告诉我你打算怎么修 `continuity` 判分，以及你对 `name` 那个产品决策的建议，再动手。
