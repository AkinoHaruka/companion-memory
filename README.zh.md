---
description: "DeepSeek Harness 原生作用域记忆插件。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-riko-memory

[English](README.md) | 中文

## 概述

基于新版 DSH 的原生记忆插件：按稳定 preset 隔离 scope，使用 storage-domain 持久化，要求显式确认，维护 Wiki 和有界 Resident Snapshot，并以可恢复 Dream 管线处理后台提取。密钥只来自 credentials 或进程环境，管理接口和验收脚本均受限且脱敏。

这是 Riko Memory 在新版 DeepSeek Harness 上的原生实现。唯一源码源头是当前 Harness worktree 的 `packages/bundle/riko-memory`；旧的独立 bundle 和根目录 `src/tests` 仅作为迁移参考，不再平行演化。

不单独发布 invariant companion，因为 Loader composition 和 storage-domain 测试就是这个原生 bundle 的权威验收面。

## 目录

- 已实现
- 安装与临时验收配置
- 管理控制面
- 验收与验证
- Model Experience
- 已知限制与后续工作
- 开发备注

## 已实现

- 使用 DSH `storageDomain` 持久化，不使用 `node:sqlite`、固定记忆路径或公共文件存储 API。
- 长期 scope 固定为 `ownerNamespace + stableAgentPresetId`。缺少稳定 preset 身份时 fail-closed，不回退到默认全局 profile。
- L0 原始证据保留 `sessionId`、事件序号和来源引用。
- 模型输出永远只是 pending Candidate；只有原始用户明确证据或显式管理操作可以确认，模型自称“请记住”不会自动授予确认权。
- Wiki 是长期权威；Resident 是有版本、字符预算和来源页引用的派生快照。Dream 或存储失败时保留 last-valid Resident。
- 提供 `memory_remember`、`memory_get_resident`、`memory_correct`、`memory_forget` 四个显式工具。
- Dream 凭据通过 DSH credentials 或进程环境解析。管理 API 只显示引用名及 configured/not-configured 状态，拒绝写入 `apiKey`。Dream endpoint 必须使用 HTTPS，且 URL 中不得内嵌凭据。
- 每个 profile 的 Dream 串行队列、受限 transcript、严格 FILE block 解析、持久化 job cursor，以及在宿主 Session 尚未恢复时从持久化 L0 证据恢复的能力、更正/废止审计链、脱敏 provider 错误和 bearer/profile 校验。Dream 会根据 endpoint URL 自动选择 OpenAI Chat Completions 或 Anthropic Messages 协议，也支持 Xiaomi MiMo。

## 安装与临时验收配置

将插件安装到包含 host web server 的 DSH profile：

```sh
dsh plugin --profile web add /absolute/path/to/packages/bundle/riko-memory
```

OpenRouter 验收只把变量注入当前进程，不通过 UI 保存，也不提交到仓库：

```text
DSH_MEMORY_DREAM_API_URL=https://openrouter.ai/api
DSH_MEMORY_DREAM_MODEL=stealth/union-alpha
DSH_MEMORY_DREAM_API_KEY=<runtime secret>
```

默认 credential ref 是 `DSH_MEMORY_DREAM_API_KEY`。非回环控制面还需要 bearer token 映射。只有配置稳定的 owner namespace 和 agent preset 后，长期记忆才会启用。

## 管理控制面

启动 Web profile 后，管理页面位于 `/memory/v1/ui`。页面不会接收、保存或回显 API key，只能编辑 endpoint、model 和 credential ref。

主要接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/memory/v1/wiki` | Wiki、候选、来源、关系图和状态 |
| GET | `/memory/v1/wiki/graph?hop=1&evidence=1` | 带类型的 L2 Wiki 关系图；`includeEvidence=1` 是等价的兼容查询参数 |
| GET | `/memory/v1/resident` | 当前有界 Resident Snapshot |
| GET | `/memory/v1/sessions/:id` | 可审计的 L0 证据 |
| GET | `/memory/v1/candidates` | 待确认的模型候选 |
| GET | `/memory/v1/config` | 安全配置摘要 |
| POST | `/memory/v1/dream` | 为会话或 profile 在后台排队 Dream 并立即返回 |
| POST | `/memory/v1/wiki/candidates/:id/confirm` | 显式确认候选 |
| POST | `/memory/v1/wiki/candidates/:id/reject` | 拒绝候选 |
| POST/PUT | `/memory/v1/wiki/pages` | 显式管理编辑 |
| POST | `/memory/v1/wiki/pages/:id/supersede` | 从后续 Resident 投影移除页面并保留血缘 |
| GET | `/memory/v1/audits` | 读取当前 scope 的更正、废止、忘记和 Dream 审计记录 |
| DELETE | `/memory/v1/wiki/pages/:id` | 从新 Resident 移除派生记忆 |

多 profile 部署时，bearer token 必须和显式的 `x-dsh-memory-profile` 一致；跨 scope 的 session 会被拒绝。v1 的 forget 删除派生记忆并从新 Resident 移除，原始 Session 证据默认保留，完整 raw Session purge 尚未实现。

## 验收与验证

在 Harness worktree 执行本地门禁：

```sh
pnpm exec tsc -b packages/bundle/riko-memory/tsconfig.json --pretty false
pnpm exec vitest run packages/bundle/riko-memory/tests --reporter=dot
```

独立 provider 基线脚本使用临时目录和临时 profile，按协议发送最小请求，429 最多进行一次有界重试，并按 provider 错误类别记录而不保留完整错误正文。验收产物只包含 `acceptance-summary.json`、`acceptance-events.jsonl` 和 `sanitized-provider-errors.log`，且要求运行时环境中存在 `DSH_MEMORY_DREAM_API_KEY`；不会从包文件读取密钥。

`/demo/run` 默认关闭，仅保留给未来受限验收 harness，不属于生产主流程。

## 开发备注

长期记忆修改必须保持在本 bundle 的 storage-domain、Candidate、Wiki 和 Resident 状态机中；不要引入平行文件存储，也不要让模型输出绕过权威确认。

## Model Experience

### Resident memory injection

#### What the model sees

每个 Agent 只接收所属稳定 preset 的有界 Resident Snapshot。注入块明确标记为记忆数据而不是指令；完整 Wiki 和原始 Session 证据不会进入聊天热路径。

#### Token effect

Resident Snapshot 受 `maxResidentChars` 限制，并作为下一次请求的动态 system context 组装。Dream 失败时继续使用上一次有效投影。

#### KV Cache effect

Resident Snapshot 变化会改变后续请求的动态上下文，并可能使之后的请求前缀缓存失效。读写记忆不会在聊天热路径调用 Dream。

## 已知限制与后续工作

- 原始 Session 删除、embedding/向量召回、多节点存储和公网多租户部署不在本轮范围。
- Dream 是可恢复的后台管线；失败不能阻塞正常聊天，也不能覆盖最后一个有效的 Resident Snapshot。
