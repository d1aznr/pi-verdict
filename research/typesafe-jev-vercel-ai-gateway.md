# 调研: jev 后端第二 transport —— Vercel AI Gateway 可行性

> 调研日期: 2026-09-19
> 背景: pi-verdict 的 jev 分类器后端目前只走 OpenRouter（`extensions/jev-adapter.ts` → `POST https://openrouter.ai/api/alpha/decisions`，凭证复用 pi 的 OpenRouter 登录态）。用户提问: 除 OpenRouter 外能否**低成本**支持 Vercel AI Gateway，依据是"pi-ai 已内置对 Vercel AI Gateway 的支持"。
> 来源声明: 全部结论核实自一手来源——本机安装的 pi-ai 源码（0.84.3 与 npm 最新 0.85.1 tarball）、Vercel 官方文档与 changelog、`@ai-sdk/gateway@4.0.87` SDK 源码、AI Gateway live `/v1/models` 目录与端点无鉴权探测、typesafe 官方文档 quickstart、本仓库源码。本机无任何相关 API key（`AI_GATEWAY_API_KEY`/`TYPESAFE_API_KEY` 均未设置），故未做带鉴权的实调用；核验命令与输出摘录见附录。

## 核心结论

1. **用户前提属实，但帮助面有限**: pi-ai 确实内置 `vercel-ai-gateway` provider（0.84.3 与最新 0.85.1 完全一致），但它只是又一个 **chat 类 provider**——API 固定为 `anthropicMessagesApi()`，模型目录 237 个、**没有任何 jev/evaluation 条目**。它对 jev 后端的直接价值只有**凭证管道**（`/login vercel-ai-gateway` 或 `AI_GATEWAY_API_KEY`，与现有 OpenRouter 复用模式完全同构）；transport 本身仍由 adapter 自带的自定义 API 承担，`pi-ai 内置支持`不提供 decisions/evaluation 调用能力（上游 grep 无 evaluation/decisions API 实现）。
2. **决定性事实是反转的**: Vercel AI Gateway **已于 2026-09-16 上架 jev**——live 目录（无鉴权可查）含 `typesafe-ai/jev`，type `evaluation`，input **$0.042/MTok**（与 OpenRouter 实测同价，gateway 声明对 provider 价格零加价）、output $0，且带 `zdr: "all"` / `no_training: "all"`。pi-ai 0.85.1 的目录快照尚无此模型（快照滞后，非 gateway 未上架）。
3. **但 gateway 不经 OpenAI/Anthropic 兼容端点提供它**: 官方文档明说 "Evaluation is available through the **AI SDK only**. It is not supported through the OpenAI-compatible, Anthropic-compatible, or Cohere-compatible endpoints"。wire 契约从开源 `@ai-sdk/gateway` 源码提取并经无鉴权探测活体验证: `POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model`，模型走 **`ai-model-id` 请求头**（不在 body），body 为 `{state, questions}`，响应 `{answers, usage{inputTokens,outputTokens}, warnings, providerMetadata}`（置信度在 `providerMetadata.typesafe.confidence`）。
4. **结论: 可行，且是单文件级低成本**——`extensions/jev-adapter.ts` 增加一个 transport 分支，估计 **40–60 行**，外加 4 处文档更新（README.md / README.zh-CN.md / docs/configuration.md / ADR-0003）。pi-verdict 本体（gate/分类器/契约）零改动。关键映射几乎现成: `verdictText()` 已按 `{answers.verdict:{choice, probabilities, confidence}}` 解析，与 gateway 响应同构，**零改动**；`mapUsage()` 加一个 camelCase 分支；请求体去掉 `model` 字段、加 3 个网关头。
5. **风险与 OpenRouter alpha 同级甚至更低公开承诺**: 网关 wire 端点不是文档化公开 REST（AI SDK only），协议版本头当前 `0.0.1`、spec `v4`、AI SDK 侧标注 experimental；目录条目 `context_window`/`max_tokens` 为 0（用量不受模型窗口校验，但也无上游窗口契约可依）。实现时应把端点/头集中为常量并保留 `PI_VERDICT_JEV_URL` 逃生口语义（按 transport 取默认值）。
6. **若目标只是"摆脱 OpenRouter"**，第三条路 typesafe 直连（`POST api.typesafe.ai/v1/systemone`，`TYPESAFE_API_KEY`，console.typesafe.ai 自助发 key）是 schema 差异最小、官方稳定性承诺最好的路径——请求体与 OpenRouter decisions 完全同构（仅 `model` 值从 `~typesafe/jev-latest` 换成 `jev-latest`）。gateway 路径的增量价值在于 Vercel 生态（credits/预算/请求日志/团队管理、ZDR/No-Training 声明）。

---

## 一、核实前提: pi-ai 内置的 vercel-ai-gateway provider 到底是什么

本机仓库 devDeps 为 `@earendil-works/pi-coding-agent@0.84.3`（`package.json:59`），其依赖 `@earendil-works/pi-ai`。provider 定义全文（0.84.3 与 0.85.1 tarball 逐字一致）:

```js
// node_modules/@earendil-works/pi-ai/dist/providers/vercel-ai-gateway.js
export function vercelAIGatewayProvider() {
    return createProvider({
        id: "vercel-ai-gateway",
        name: "Vercel AI Gateway",
        baseUrl: "https://ai-gateway.vercel.sh",
        auth: { apiKey: envApiKeyAuth("Vercel AI Gateway API key", ["AI_GATEWAY_API_KEY"]) },
        models: Object.values(VERCEL_AI_GATEWAY_MODELS),
        api: anthropicMessagesApi(),
    });
}
```

- provider 标识 `vercel-ai-gateway`，baseURL `https://ai-gateway.vercel.sh`，鉴权环境变量 **`AI_GATEWAY_API_KEY`**（`dist/env-api-keys.js:88`）。
- **API 类型固定为 `anthropicMessagesApi()`**（即 Anthropic Messages chat 协议，pi-ai 的 KnownProvider 列表见 `dist/types.d.ts:19`）。pi-ai 里没有第二种 gateway API——对 chat completions / messages / embeddings 之外的 modality（如 evaluation）无任何实现（0.85.1 tarball 全量 grep `evaluate|evaluation` 无相关命中）。
- 模型目录来自 `dist/providers/data/vercel-ai-gateway.json`（脚本生成，`models.generated.js:34,74` 挂载）: 顶层唯一分组键 **`anthropic-messages`**，共 **237 个模型**，**grep `jev|typesafe|decision` 命中 0**。最新发布版 `@earendil-works/pi-ai@0.85.1`（npm view，2026-09-19）快照同样如此——即使用户升级到最新 pi，内置 provider 也**看不到 jev**。
- 凭证/登录: pi 官方文档 `docs/providers.md:86` 列出该 provider——`/login`（存入 auth.json，key 名 `vercel-ai-gateway`）或环境变量 `AI_GATEWAY_API_KEY`。这意味着 jev adapter 若走 gateway，可以**照抄现有 OpenRouter 凭证复用模式**: `ctx.modelRegistry.getProviderAuth("vercel-ai-gateway")` + 环境变量回退。
- 上游仓库现为 **earendil-works/pi**（`gh api repos/earendil-works/pi` 确认；仓库内旧链接 badlogic/pi-mono 已随之重定向）。近期提交与 gateway 相关的仅 "fix(ai): preserve Vercel AI Gateway unsigned thinking"，无 evaluation/decisions 计划痕迹。

**判定**: "pi-ai 已内置 Vercel AI Gateway 支持"对**普通 LLM 分类器**成立且今天就可用——`classifierModel` 指到注册表里的任一 gateway chat 模型即可（经 `modelRegistry`，pi-verdict 零改动，未实测）；但对 **jev 后端**，内置 provider 帮不上 transport——decisions/evaluation 类调用必须由 adapter 的自定义 API 自行实现，能复用的只有凭证解析管道。

## 二、决定性问题: Vercel AI Gateway 是否承载 jev——是，且是一等 modality

- **live 目录实锤**（`GET https://ai-gateway.vercel.sh/v1/models`，官方文档注明此端点无需鉴权）: 共 372 个模型，含:

```json
{
  "id": "typesafe-ai/jev",
  "owned_by": "typesafe-ai",
  "name": "Jev",
  "type": "evaluation",
  "supported_specifications": ["v4"],
  "context_window": 0,
  "max_tokens": 0,
  "zdr": "all",
  "no_training": "all",
  "pricing": { "input": "0.000000042", "output": "0" }
}
```

  - `0.000000042 $/token × 1e6 = **$0.042/MTok**`，与 OpenRouter 实测一致（`research/typesafe-jev-classifiermodel.md` §五、`extensions/jev-adapter.ts:184-185`）；gateway 声明 "adds zero markup to provider token prices"（docs/ai-gateway）。output 计 $0。
- **官方 changelog**: 《TypeSafe AI's Jev now available on AI Gateway》（2026-09-16）——model id `typesafe-ai/jev`，经 AI SDK 7 的 experimental `evaluate` API 调用（支持自 `ai@7.0.105`），置信度在 `result.providerMetadata.typesafe.confidence`，请求进 gateway 的 logs/reporting/budgets；唯一声明的 caveat 是 API experimental。
- **文档面**: gateway 把它归入新的 **Evaluation modality**（docs/ai-gateway/modalities → evaluation 页）: "Evaluate shared state against typed questions and get structured answers back"——question 类型 `choice`（criteria 为选项→描述的 record，答案含 `choice` + 每选项 `probabilities`）、`score`、`boolean`（返回 0–1 `probability`）；一个请求可并行多问；`state` 接受 string/object/array。这与 jev-adapter 现在发给 OpenRouter 的 `choice` 问题结构（`VERDICT_QUESTIONS`，`extensions/jev-adapter.ts:51-63`）语义一致。
- **关键限制**（evaluation 文档页原文）: "Evaluation is available through the AI SDK only. It is not supported through the OpenAI-compatible, Anthropic-compatible, or Cohere-compatible endpoints."——即 `/v1/chat/completions`、`/v1/messages` 均不承载 jev（live 探测二者路由存在但对空体 400；`/api/alpha/decisions`、`/v1/decisions` 在 gateway 域名下 404，OpenRouter 专有路径不存在于此）。

## 三、wire 契约: 从 @ai-sdk/gateway 源码提取 + 无鉴权活体验证

官方不把 evaluation 当公开 REST 文档化，但 `@ai-sdk/gateway@4.0.87`（MIT 开源）给出了完整契约。`GatewayEvaluationModel`（dist/index.js）:

- **URL**: `${baseURL}/evaluation-model`，`baseURL` 默认 `https://ai-gateway.vercel.sh/v4/ai` ⇒ **`POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model`**（`/v4` 对应目录字段 `supported_specifications: ["v4"]`）。
- **请求头**: `Authorization: Bearer <key>`；全局 `ai-gateway-protocol-version: 0.0.1`（常量 `AI_GATEWAY_PROTOCOL_VERSION`）；模型专属 `ai-evaluation-model-specification-version: 4` 与 **`ai-model-id: typesafe-ai/jev`**（模型在头里，body 无 model 字段）。
- **请求体**: `{ state, questions, providerOptions? }`。
- **响应 schema**（zod）: `{ answers: Record<string, {type:'choice', choice, probabilities?} | {type:'score', score, probabilities?} | {type:'boolean', probability}>, rounding?, usage?: {inputTokens?, outputTokens?}, warnings?, providerMetadata? }`——注意 usage 是 camelCase 且**无 cost 字段**（计费走 Vercel credits，per-call cost 不随响应返回）；changelog 称 confidence 在 `providerMetadata.typesafe.confidence`。

**活体验证**（本机无 key，用错误响应反证契约，2026-09-19）:

| 探测 | 结果 |
|---|---|
| `POST /v4/ai/evaluation-model`，无 protocol 头 | `400 {"error":{"message":"Unsupported gateway protocol version"}}` |
| 同上，带 `ai-gateway-protocol-version: 0.0.1` + spec 头 + `ai-model-id`，空 body | `400` zod 错误逐字段要求 `state: string`、`questions: record`——**与 SDK 源码 schema 逐字吻合** |
| `GET /v4/ai/evaluation-model` | `405`（路由存在） |
| `GET /v1/models` 无鉴权 | `200`，372 模型含 typesafe-ai/jev |

未做带鉴权的 200 实调用（无凭证）；上述探测已确认路由、协议头、body schema 三要素，剩余未知仅限"成功响应字段是否有 SDK schema 之外的增项"。

## 四、低成本支持路径: 改动清单

全部改动集中在 `extensions/jev-adapter.ts` 单文件（现 255 行），本体零改动:

1. **transport 选择**: 新增环境变量（如 `PI_VERDICT_JEV_TRANSPORT=openrouter|vercel|typesafe`，默认 `openrouter` 保持现状）。可参考社区先例 iefnaf/pi-jev 的 `JEVC_PROVIDER` 选择器设计（README: "auto-detected; both keys present 时 TypeSafe 优先"）。
2. **端点与请求头**: gateway 分支默认 URL `https://ai-gateway.vercel.sh/v4/ai/evaluation-model`（`PI_VERDICT_JEV_URL` 逃生口语义保留，按 transport 取不同默认值；现 `DECISIONS_URL` 逻辑在 `extensions/jev-adapter.ts:43`）。请求头增加 `ai-gateway-protocol-version` / `ai-evaluation-model-specification-version` / `ai-model-id`（模型 id `typesafe-ai/jev`）。`buildDecisionsBody()`（:87-89）在 gateway 分支**去掉 `model` 字段**。
3. **凭证解析**: 照抄 OpenRouter 模式（:210-222）——`getProviderAuth("vercel-ai-gateway")` + `AI_GATEWAY_API_KEY` 回退；`session_start` 重注册的可用性检查逻辑（:239-245）不变。pi 侧 `/login vercel-ai-gateway` 已支持（`docs/providers.md:86`），用户无需在 pi 之外另管 key。
4. **响应映射**:
   - `verdictText()`（:102-116）**零改动**——gateway 的 `{answers:{verdict:{type:'choice',choice,probabilities}}}` 与现有解析同构；`confidence` 字段 gateway 不在 answer 本体，需从 `providerMetadata?.typesafe?.confidence` 补读（约 3 行，缺失时现状逻辑已优雅降级为省略 confText）。
   - `mapUsage()`（:118-131）加 camelCase 分支（`inputTokens`/`outputTokens` → 现有 snake_case 字段；`cost` 恒 0，gateway 不返回 per-call cost——`notifyAllows`/审计里的成本显示需接受此差异，或文档注明）。
5. **文档**: README.md、README.zh-CN.md 的 "Provider: OpenRouter only, for now" 小节（README.md:129）、docs/configuration.md 的 host/provider 说明、ADR-0003 追加 gateway transport 附录。npm 包无新文件（`package.json:8-14` files 列表不变）。

估计代码量 **40–60 行**（含类型与错误文案），一次 PR 可完成；测试沿用现有 `bun test` 对 `buildDecisionsBody`/`verdictText` 的纯函数测法，为 gateway 响应样本补 2–3 个用例。

## 五、三种 transport 对比

| 维度 | OpenRouter（现状） | Vercel AI Gateway | typesafe 直连 |
|---|---|---|---|
| 端点 | `POST openrouter.ai/api/alpha/decisions` | `POST ai-gateway.vercel.sh/v4/ai/evaluation-model` | `POST api.typesafe.ai/v1/systemone` |
| 稳定性承诺 | alpha 端点，schema 随时可能变（changelog/实测均明示） | **AI SDK only**（无公开 REST 承诺）；协议 `0.0.1` / spec `v4` / experimental | 官方 v1 正式 API |
| 请求体 | `{model: "~typesafe/jev-latest", state, questions}` | `{state, questions}` + `ai-model-id` 头 | `{model: "jev-latest", state, questions}`（与 OpenRouter 同构） |
| 响应差异 | `answers.verdict` + `usage{input_tokens, output_tokens, cost}` | `answers.verdict`（无 confidence 本体）+ `usage{inputTokens, outputTokens}`（无 cost）+ `providerMetadata.typesafe.confidence` | `answers`（含 confidence）+ `usage` |
| 账号/凭证 | 复用 pi 的 OpenRouter 登录态，零新增 | Vercel 账号 + credits（或团队 BYOK）；pi `/login vercel-ai-gateway` 已支持 | typesafe 账号 + `console.typesafe.ai/keys` 自助 key |
| 定价 | $0.042/MTok input，output $0（usage.cost 实测结算） | 同价，gateway 零加价；无 per-call cost 返回，走 credits/预算 | 同价口径（博客/前次调研） |
| 数据治理 | OpenRouter 侧策略 | 目录声明 `zdr: "all"`、`no_training: "all"` | 官方 ZDR 政策（docs） |
| 增量价值 | — | Vercel 生态预算/日志/团队管理/故障转移 | 最短依赖链、官方支持渠道 |

## 六、风险与建议

1. **wire 稳定性**: gateway evaluation 契约的公开承诺弱于 OpenRouter alpha（后者至少有 API 文档与目录页面）。建议实现时:(a) 端点、协议头、spec 版本集中为 adapter 顶部常量并加注释指向来源（@ai-sdk/gateway 版本）; (b) 失败路径沿用 fail-closed（现状已保证——`streamDecisions` 异常即 error 事件，分类器回退）。2. **目录滞后于 live**: pi-ai 生成目录不含 jev，若未来 pi 校验模型存在性会有摩擦；adapter 自注册模型不走目录校验（现状 `hasConfiguredAuth` 只查凭证），无碍。3. **顺序建议**: 若近期要动 adapter，typesafe 直连分支（官方 v1、body 同构、改动更小）与 gateway 分支可同 PR 做成同一 transport 选择器；若只挑一个，gateway 的理由是复用 pi 登录态零新账号 + Vercel 预算管理，typesafe 的理由是稳定性。此为产品取舍，非技术约束。4. **上游推动（可选）**: 向 earendil-works/pi 提 issue 请求在 pi-ai 增加 evaluation API 类型（对齐 AI SDK v4 spec），打通后 adapter 的自定义 API 可退役（与前次调研建议的 decisions 类 issue 合并提）。

## 附录: 核验命令与输出摘录

```bash
# 1. live 目录（无鉴权，官方声明免鉴权端点）
$ curl -sS https://ai-gateway.vercel.sh/v1/models | python3 -c "…"
total models: 372
jev/typesafe/systemone: ['typesafe-ai/jev']   decision*: []
# providers: ['alibaba', …, 'typesafe-ai', …]

# 2. 端点路由探测（2026-09-19，无鉴权）
$ POST https://ai-gateway.vercel.sh/v4/ai/evaluation-model   # 无 protocol 头
-> 400 {"error":{"message":"Unsupported gateway protocol version"}}
$ POST 同上 + 'ai-gateway-protocol-version: 0.0.1' + spec/model 头 + '{}'
-> 400 zod: state expected string / questions expected record
$ GET  /v4/ai/evaluation-model -> 405
$ POST /api/alpha/decisions, /v1/decisions（gateway 域）-> 404
$ POST /v1/chat/completions, /v1/messages -> 400（路由存在）

# 3. pi-ai 版本与快照
$ npm view @earendil-works/pi-ai version -> 0.85.1
$ python3 … /pi-ai-0.85.1/.../data/vercel-ai-gateway.json
top keys: ['anthropic-messages']  -> 237 models
jev hits: 0  typesafe hits: 0  decision hits: 0

# 4. @ai-sdk/gateway@4.0.87 关键源码（npm pack 后 dist/index.js）
getUrl() { return `${this.config.baseURL}/evaluation-model`; }
baseURL ?? "https://ai-gateway.vercel.sh/v4/ai"
AI_GATEWAY_PROTOCOL_VERSION = "0.0.1"
getModelConfigHeaders() { return { "ai-evaluation-model-specification-version": "4", "ai-model-id": this.modelId }; }
body: { state, questions, ...providerOptions ? { providerOptions } : {} }
gatewayEvaluationAnswerSchema = z.discriminatedUnion("type", [ choice{choice, probabilities?}, score{score, probabilities?}, boolean{probability} ])
usage: z.object({ inputTokens: optional, outputTokens: optional }).optional()

# 5. 凭证环境变量检查（仅名称）
AI_GATEWAY_API_KEY: unset  VERCEL_AI_GATEWAY_API_KEY: unset  TYPESAFE_API_KEY: unset
```

本地源码引用:
- `node_modules/@earendil-works/pi-ai/dist/providers/vercel-ai-gateway.js`（provider 全文，0.84.3；0.85.1 tarball 同）
- `node_modules/@earendil-works/pi-ai/dist/env-api-keys.js:88`、`dist/models.generated.js:34,74`、`dist/types.d.ts:19`、`dist/providers/data/vercel-ai-gateway.json`
- `node_modules/@earendil-works/pi-coding-agent/docs/providers.md:86`（gateway 登录/env/auth.json 行）
- `extensions/jev-adapter.ts:37-43, 51-63, 87-89, 102-116, 118-131, 148-157, 200-230, 239-245`
- 前次调研: `research/typesafe-jev-classifiermodel.md`（OpenRouter alpha 实测、定价、ADR 依据）

外部一手来源:
- <https://vercel.com/docs/ai-gateway>（端点/零加价/BYOK/预算）
- <https://vercel.com/docs/ai-gateway/modalities> 与 <https://vercel.com/docs/ai-gateway/modalities/evaluation>（"AI SDK only" 声明、question 类型、usage）
- <https://vercel.com/docs/ai-gateway/models-and-providers>（`/v1/models` 免鉴权、模型 id 格式）
- <https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway>（2026-09-16，`ai@7.0.105+`，providerMetadata.typesafe.confidence，experimental）
- `@ai-sdk/gateway@4.0.87`（npm，dist/index.js——wire 契约）
- <https://docs.typesafe.ai/introduction/quickstart>（`POST api.typesafe.ai/v1/systemone`、Bearer、console.typesafe.ai/keys、`jev-latest`、`{state, model, questions}`）
- <https://github.com/iefnaf/pi-jev>（双 transport 先例，`TYPESAFE_API_KEY`/`JEVC_PROVIDER`）
- `gh api repos/earendil-works/pi`（上游仓库现名；相关提交 "fix(ai): preserve Vercel AI Gateway unsigned thinking"）
