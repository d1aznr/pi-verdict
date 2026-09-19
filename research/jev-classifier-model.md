# 调研: typesafe jev 作为 pi-verdict classifierModel 的接入路径与收益评估

> 调研日期: 2026-09-18(jev 发布于 2026-09-15,OpenRouter listing 创建于 2026-09-18T00:01Z,发布仅 3 天)。
> 来源范围: typesafe 官方博客与文档站(docs.typesafe.ai,经 llms.txt 全量索引)、OpenRouter 官方文档与公开 API、OpenRouter 模型页内嵌目录数据、GitHub org `typesafe-ai`、npm registry;另引用主会话用真实 OpenRouter key 做的随库实测(标注「随库实测 2026-09」)与本机 pi / pi-verdict 源码。
> 本文取代 `research/typesafe-jev-classifiermodel.md`(其「OpenRouter 尚不可调用」的结论已过时:decisions 端点已可实测调用)。
> 断言分三档标注:**已核实**(官方文档/公开 API/随库实测/本机源码)、**官方声明**(厂商自述未独立复现)、**推断**(标明推理链)。

## TL;DR

1. **Q1(jev 能否配置为 classifierModel 经 pi provider 体系接入):现状不能,且有明确可行路径。** jev 是 decisions modality 模型:OpenRouter 目录数据 `output_modalities: ["decisions"]`、`has_text_output: false`;随库实测经 `chat/completions` 调用两个 slug 均返回 400:"~typesafe/jev-latest is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead."。pi 的模型管线(modelRegistry.complete → `api: "openai-completions"` → chat/completions)驱动不了它,`models.json` 的 legacy provider 同理。可行路径只有 (a) 独立 adapter 扩展经 `pi.registerProvider()` + Custom Streaming API 把 `complete()` 语义翻译到 decisions 端点(pi-verdict 零改动),或 (b) pi-verdict 直连 fetch(违背其零直连架构,不建议)。
2. **Q2(typesafe 官方 API 与 OpenRouter 接口是否一致):与 OpenAI chat completions 完全不同构;OpenRouter 的 `/api/alpha/decisions` 与 typesafe 官方 `POST /v1/systemone` 则高度同构。** 两者请求/响应核心 schema(state + questions 判别联合 choice/score/noul → answers + usage)逐字段对应,差异仅在 OpenRouter 侧新增 `provider` 路由偏好、`session_id`/`trace`/`user` 观测字段,以及响应里的 `id`/`provider`/`usage.cost`;模型命名空间不同(`jev-latest` vs `~typesafe/jev-latest`,响应均回报具体版本号)。
3. **收益:与分类器画像高度契合,但有一个官方自认的决定性风险。** 分类器任务 = allow/ask/deny 三选一 + 校准概率,与 `choice` 原语精确同构;`rm -rf /tmp/test-dir` → allow P=0.58 conf=0.16 的随库实测说明校准的不确定性真实可用(confidence 阈值可把「倾向 allow 但不确定」升级为 ask,把 "Err on the side of ask" 从提示词软约束变成代码硬阈值)。成本输入 $0.042/M、输出 $0(约比 GLM-5.3-flash 便宜 2.3×、比 GPT-5.4-mini 便宜约 20×),延迟实测中位 1.25s(远低于现网关 LLM 分类器 p90 19.8s)。但 typesafe 官方 jaggedness 文档明确承认:**"State is data, and `jev-1.13` does not treat it as hostile by default"——对抗性内容可以移动判定**,而 pi-verdict 的 state 恰是含不可信文件内容的 transcript。**结论:值得做成可插拔实验,不建议现在依赖。**

## 〇、本机已核实的 pi 侧事实(笔记自洽用)

来源:本仓库 `extensions/pi-verdict.ts` 与本机安装的 pi 包文档(`node_modules/@earendil-works/pi-coding-agent/docs/`)。

1. **扩展从不直连模型厂商 HTTP**。分类器完成调用走 `completionFor(ctx.modelRegistry, …)` → `ModelRegistry.complete(model, context, options)`,凭证由 pi 内部解析,pi-verdict 不碰 API key(`extensions/pi-verdict.ts:1044,1611`)。机制详见 `research/pi-model-call-and-ref-implementations.md`。
2. **classifierModel 解析**:`resolveClassifier()` 把用户配置串按第一个 `/` 切分为 provider/modelId,`ctx.modelRegistry.find(provider, modelId)` + `hasConfiguredAuth(model)`,失败回退会话模型自省(`extensions/pi-verdict.ts:1545-1563`)。注:切分取第一个 `/`,故 `"openrouter/~typesafe/jev-latest"` 会被正确解析为 provider `openrouter` + modelId `~typesafe/jev-latest`。
3. **provider 体系入口有二**:pi 内置 `openrouter` provider(`/login openrouter` OAuth 铸 key 或 `OPENROUTER_API_KEY`,pi `docs/providers.md:49,85`);自定义 provider 走 `~/.pi/agent/models.json` 或扩展 API `pi.registerProvider()`(`api: "openai-completions"` 等 legacy API 名,或 Custom Streaming API 自定义实现,pi `docs/custom-provider.md:3,25,75`)。
4. 分类器调用画像(补充,同文件):`<verdict>allow|ask|deny</verdict>` 前缀契约(`:909-910,986-988`),违反 → null → fail-closed deny;transcript 每条 ≤1000 字符(`MAX_ENTRY_CHARS`,`:923`);超时 25s(`CLASSIFIER_TIMEOUT_MS = 25_000`,注释引本网关 p90=19.8s 实测分布,`:999`);maxTokens 512,解析失败重试档 1024。

## 一、Q1:接入路径

### 1.1 OpenRouter 侧事实(已核实)

- **两条 listing 均真实存在**(2026-09-18 核验,伪造 slug 的对照页仅回退 title "OpenRouter"):
  - `https://openrouter.ai/~typesafe/jev-latest` — meta description:"This model always redirects to the latest model in the Jev family. $0.042 per million input tokens, $0 per million output tokens. 32,000 token context window."
  - `https://openrouter.ai/typesafe/jev-1.13` — "Jev is a structured decision model from TypeSafe, and the first of its System One models. …$0.042/M input,$0/M output,32,000 token context window."
- **`~` 前缀语义(官方文档核证)**:OpenRouter docs "Latest Model Resolution"(openrouter.ai/docs/guides/routing/routers/latest-resolution.md):"`~author/family-latest` slugs always resolve to the newest concrete model in a given family, so you can ship code against a stable alias and pick up new releases without redeploying." 响应 `model` 字段回报具体版本("Transparent reporting");家族无可 用模型时报错而非回退。即 **`~typesafe/jev-latest` = 滚动别名,`typesafe/jev-1.13` = 固定版本**,两者共用同一 `model_version_group_id`(模型页内嵌数据)。另:该文档"Compatibility contract"节声明 `~latest` 别名会把不支持的 reasoning 参数重映射到最近似值——对 jev 这种 `supports_reasoning: false` 的模型,分类器的 `reasoning: "off"` 需求天然满足。
- **目录状态**:带认证与不带认证的 `GET /api/v1/models` 均返回 445 个模型,**无任何 typesafe/jev 条目**;但目录确有 `~deepseek/deepseek-pro-latest`、`~z-ai/glm-flash-latest` 等 `~` 别名(已核实)。结合下述 400 报错,**推断**:decisions modality 模型不进 chat 目录,或条目尚在灰度。OpenRouter docs "Model Variants" 注明"`GET /api/v1/models` is a catalog of models and catalog variants. It is not an exhaustive list of every model string a request can use."——即**目录对 chat 模型是动态的,新上架 slug 即刻可用;但 jev 属于另一个端点体系**。
- **模型页内嵌目录数据(已核实,jev-1.13 页)**:`output_modalities: ["decisions"]`、`has_text_output: false`、`supports_reasoning: false`、`supported_parameters: []`、`context_length: 32000`、`permaslug: "typesafe/jev-1.13-20260917"`、endpoint `provider_name: "TypeSafe"`、`baseUrl: "https://api.typesafe.ai/v1"`、adapter `TypeSafeDecisionsAdapter`、listing `created_at: "2026-09-18T00:01:24Z"`。
- **随库实测 2026-09(经 OpenRouter 官方端点)**:两个 slug 经 `chat/completions` 均 400:"…is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead.";经 `POST https://openrouter.ai/api/alpha/decisions` 调用成功,响应 `model` 均为 `typesafe/jev-1.13-20260917`、`provider: "TypeSafe"`。

### 1.2 pi 管线为何驱动不了(核心论证)

pi 的 provider 管线终点是 OpenAI 形态的 chat/completions(legacy `api: "openai-completions"` 及内置 openrouter provider 均如此)。jev 在网关层显式拒绝该端点(上引 400 报错,已核实),且 `has_text_output: false`——即使网关放行,`<verdict>…` 文本契约也无从产生。因此:

| 路径 | 做法 | 判定 |
|---|---|---|
| A. `classifierModel: "openrouter/~typesafe/jev-latest"` | 走 pi 内置 openrouter provider | **不可用(已核实)**:chat/completions 400 |
| B. `models.json` 自定义 provider(`api: "openai-completions"`,baseUrl 指 typesafe 或 OpenRouter) | legacy chat 形态对接 | **不可用(已核实)**:typesafe 官方只有 `/v1/systemone`,无 OpenAI 兼容层;OpenRouter 侧对应端点是 `/api/alpha/decisions`,同样非 chat 形态 |
| C. adapter 扩展:`pi.registerProvider()` + Custom Streaming API(pi `docs/custom-provider.md:25`) | 独立扩展注册完整 Provider,把 `complete(model, context, options)` 翻译为 decisions 请求:messages/transcript → `state`,`CLASSIFIER_SYSTEM` 三段定义 → `choice` 的 `criteria`(allow/ask/deny 三选项),answer 合成回 `<verdict>{choice}</verdict> jev: confidence=… p(allow)=…` 文本,正好满足 `parseVerdict` 前缀契约 | **可行(推断,设计层面)**:pi-verdict 零改动,`classifierModel: "typesafe/jev-latest"` 即用;需 ~百行级适配代码 + 自理鉴权(env var) |
| D. pi-verdict 内直连 fetch decisions 端点 | 扩展自己发 HTTP | **不建议**:破坏「扩展模型无关、经 pi 体系走凭证」的既有架构(ADR 约定零直连),且与本次调研动机相悖 |

注:GitHub `typesafe-ai/system-one-adapter-python`(103★,官方 org)是反方向的同构先例——"Drop-in TypeSafeClient replacement backed by LLM APIs",证明 systemone ⇄ LLM 接口的翻译层是官方自己也维护的模式;路径 C 相当于它的镜像(LLM 接口 ⇄ systemone)。

### 1.3 存在证明:pi-jev 扩展选了路径 D(2026-09-18 核验)

GitHub `iefnaf/pi-jev`(创建于 2026-09-18,npm 包名 `@alexlikevibe/pi-jev`):用 jev 做「选择性上下文压缩 + 逐轮模型路由」的 pi 扩展套件。**它没有走 `pi.registerProvider()`(路径 C),而是扩展直接 fetch decisions 端点(路径 D)**,工程形态值得参考:

- **传输层**(vendored `src/vendor/fast-jev-compaction/client.ts` + `request.ts`,零依赖纯函数):`buildJevRequest()` 构造 `POST {model, state, questions}` + Bearer 鉴权;fetch 可注入(测试友好);响应校验只要求非 2xx 抛错 + JSON 可解析 + `answers` 是对象——**同一解析器同时吃 typesafe 与 OpenRouter 响应**(两侧核心 schema 同构,与本文 2.2 节结论互证)。
- **双 transport 配置解析**(`src/shared/config.ts`):`JEVC_PROVIDER` 显式指定 > 配置文件 > 按 env key 自动探测(双 key 并存 TypeSafe 优先);缺省映射:typesafe → `https://api.typesafe.ai/v1/systemone` + `jev-latest`,openrouter → `https://openrouter.ai/api/alpha/decisions` + `typesafe/jev-1.13`(**固定版本而非 `~latest` 滚动别名**,与本文第四节「阈值化必须 pin 版本」建议一致);`JEVC_BASE_URL` 可覆盖端点(代理场景)。配置分层 env(`JEVC_*`)> 项目 `.pi/jev.json` > 全局 `~/.pi/agent/jev.json`,**API key 永不落文件(env-only,`JEVC_API_KEY` 可覆盖)**。
- **pi 集成面(混合模式)**:jev 判定在钩子里直连(`session_before_compact` 压缩 / `before_agent_start` 路由),但路由**目标模型**仍走 pi 体系(`ctx.modelRegistry.find()` + `pi.setModel()`)。即「决策模型直连、目标模型经 registry」。
- **题型实战**:压缩 = 每个非 pinned 工具调用两道 `noul`(keep call / keep result)+ 一道 `score`(staleness),多 batch 并发共用同一 fitted state;路由 = 一道 `score`(difficulty,criteria = `['trivial','moderate','complex']` 三档,与本文实测的 legend 语义吻合),并做了 0..1 连续值 vs 等级索引的双态防御解析(`toLevels`:`score <= 1` 读作归一化值)。
- **confidence 阈值化的先例**:`minConfidence` 低于阈值 → 不切模型(`reason: 'low-confidence'`),与本文 3.3 节「confidence 阈值化 ask 策略」设想同型;兜底方向为功能降级(jev 失败 → 回退 pi 原生压缩/保持当前模型,missing answers 保守保留)——与 pi-verdict 的 fail-closed 哲学同构(安全侧取保守),但它是功能扩展不是安全组件。

对 pi-verdict 的启示:路径 D 的工程成本被证实为「~百行 client + 配置解析」级别;但 pi-jev 的场景(压缩/路由)本是扩展自治逻辑,无 `complete()` 语义包袱——pi-verdict 若走 D,需自行解决「凭证从哪来」(pi-jev 用 env-only key;pi-verdict 可经 `modelRegistry.getProviderAuth("openrouter")` 复用 pi 凭证,仍零自管 key)与「零直连架构让步」的 ADR 记录。

## 二、Q2:API 兼容性

### 2.1 typesafe 官方 API(已核实,docs.typesafe.ai/api)

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json

{ "state": "<string|object|array>", "model": "jev-latest",
  "questions": { "<id>": { "type": "choice|score|noul", "instructions": …, "criteria": … } } }
```

- 响应顶层 `{ model, answers, usage }`;每个 answer 按问题类型带类型化取值。**鉴权同为 Bearer,但请求/响应 schema 与 OpenAI/OpenRouter chat completions 无任何共同结构**;文档站(llms.txt 全索引)无 OpenAI 兼容层声明。
- **noul 语义(官方文档核证)**:"A Noul question asks the model to evaluate a yes/no question and return the probability that the answer is yes." 取值 0–1,"A value near 0.5 gives yes and no similar probability";**"Noul does not return a separate confidence value"**。
- **confidence 语义(官方文档核证)**:仅 Choice/Score 有,是概率分布形状的单一标量坍缩("collapses that shape into a single number from 0 to 1");官方给出三段用法——high: act automatically / medium: proceed with caution / low: do not act。
- 三种问题可混在同一次调用中**并行**求值,"Adding questions barely changes the response time"。

### 2.2 OpenRouter `/api/alpha/decisions`(已核实:官方 OpenAPI + 随库实测)

官方 OpenAPI(docs/api/api-reference/alphadecisions/…,tag `alpha.decisions`:"Alpha feature endpoints for Decisions (questions and answers) requests"):

- 请求 `DecisionsRequest`:required `[model, state, questions]`;optional `provider`(完整 ProviderPreferences:allow_fallbacks / data_collection / order / sort / max_price / zdr 等)、`session_id`、`trace`、`user`。
- `questions` 为判别联合 `type=choice|score|noul`,`criteria` 形状与 typesafe 逐字段一致(choice: map<选项, 描述|null>;score: 有序数组; noul: `{true,false}`)。
- 响应 `DecisionsResponse`:required `[model, answers, usage]`;`usage` 含 `input_tokens / output_tokens / cost`(typesafe 官方响应无 cost/id/provider);另有 `id`、`provider`。`ProviderName` 枚举已含 `TypeSafe`。
- **与 `/v1/systemone` 的关系:核心 schema 同构,OpenRouter 是超集**——多出网关路由与观测字段。随库实测的 choice 响应 `{choice, probabilities, confidence}`、score 响应 `{score, legend, probabilities, confidence}`、noul 响应 `{noul}` 与 typesafe 文档响应示例一致。
- 随库实测:`temperature`/`seed` 顶层字段被接受不报错——**不在官方 OpenAPI schema 中,推断为被忽略**(decisions 模型的并行采样语义下无意义)。
- SDK 官方支持:OpenRouter TS/Python/Go SDK 均有 `Alpha.Decisions` 模块(docs 索引可见);pi 不经这些 SDK。

### 2.3 官方直连 vs 经 OpenRouter 的取舍

| 维度 | typesafe 直连 | 经 OpenRouter |
|---|---|---|
| 端点 | `POST api.typesafe.ai/v1/systemone` | `POST openrouter.ai/api/alpha/decisions`(alpha) |
| 模型名 | `jev-latest`(→`jev-1.13.0`)/ `jev-preview` | `~typesafe/jev-latest`(→`typesafe/jev-1.13-20260917`)/ `typesafe/jev-1.13` |
| 定价 | 输入 $0.042/M,输出免费 | 同价(OpenRouter 自称 "no markup on the provider's price";随库实测 cost = input_tokens × 4.2e-8 交叉核证) |
| 鉴权 | `TYPESAFE_API_KEY` | OpenRouter key(pi 已内置 provider 体系,`/login openrouter`) |
| 成熟度 | 官方 GA 端点,SDK(Python `typesafe-sdk` / npm `@typesafe-ai/sdk` v0.6.0,Node ≥20,ESM/CJS/TS 声明,已核实 npm registry) | **alpha** 端点;但复用 pi 既有 openrouter 凭证,adapter 无需新 key |

## 三、Q3:收益评估

### 3.1 jev 是什么(官方声明 + 已核实的目录事实)

- **定位**:System One Models——"built to make fast, structured decisions that software can use directly"(博客,Sep 15 2026,创始人 Diogo Almeida,前 OpenAI 指令遵循研究/ChatGPT 研究背景)。命名取 Kahneman System 1;Jev 取经济学家 Jevons。架构 = 新模型架构 + 并行采样器("Generates all outputs in a single query")+ RLCD(Reinforcement Learning for Calibrated Decisions)。**放弃文本生成**:"Think of Jev as a frontier-intelligence function call: unstructured state in, typed probabilistic decisions out."
- **与分类器画像的契合(核心论点)**:pi-verdict 分类器要的正是「无思维链的快速直觉判定」——reasoning 显式关闭、temperature 0、短进短出。jev 构造上没有 CoT(`supports_reasoning: false`),temperature 类参数天然缺席(并行采样),输出即类型化判定。**thinking 参数黑洞一整类故障(`research/thinking-param-blackhole.md`)在 jev 上构造性不存在。**
- **官方性能声明**(博客,方法学作者自认有偏):端到端 70ms–500ms(对比前沿 LLM 3–329s);首页 "193.6x faster, 444.6x cheaper" 出自自建 workflow evals,参考答案取 GPT-6 Astra 与 Fable 5.1 均值,"we expect that these are on the higher end of real world gains";0% 幻觉率是 schema 数学保证而非实证质量。

### 3.2 定价与延迟对比(查询/实测日期 2026-09-18;单位 USD/MTok,经 OpenRouter 目录)

| 模型 | 输入 | 输出 | 单次分类器调用成本(输入 4k tok = transcript 上限,输出 ~60 tok) |
|---|---|---|---|
| `typesafe/jev-1.13` | **$0.042** | **$0** | **$0.00017**(输出免费,随库实测 6 次恒等验证) |
| `z-ai/glm-5.3-flash` | $0.09 | $0.30 | $0.00038(≈2.3×) |
| `~z-ai/glm-flash-latest` | $0.075 | $0.25 | $0.00032(≈1.9×) |
| `openai/gpt-5.4-nano` | $0.20 | $1.25 | $0.00088(≈5×) |
| `google/gemini-3.8-flash` | $0.75 | $3.75 | $0.0032(≈19×) |
| `openai/gpt-5.4-mini` | $0.75 | $4.50 | $0.0033(≈20×) |

- 延迟:**随库实测(本机 → OpenRouter decisions 端点)往返 0.96–1.68s,中位 ~1.25s**;官方直连声明 70–500ms(官方声明,未复现)。对照:现网关 LLM 分类器 p90 = 19.8s(`extensions/pi-verdict.ts:999` 注释,thinking 栈所致,见 `research/thinking-param-blackhole.md`;flash 级非思考模型会快得多,此对照对 LLM 侧偏严)。
- 上下文:官方 64k tokens/请求,其中 `state` + 最长问题 ≤32k(OpenRouter listing 的 32000 与之吻合)。pi-verdict transcript 上限 ≈15k 字符 ≈4k tokens,余量充足(已核实两侧数字)。
- 速率限制(官方声明):250,000 tokens/sec、1,200 requests/min,且"adjusting dynamically";超限 429 + `retry-after`,SDK 默认退避。对逐灰区调用的分类器画像绰绰有余。

### 3.3 行为实测与分类器契约的映射(随库实测 2026-09)

选择空间 allow/deny 二选一的初步结果:

| 输入 | 判定 | P | confidence |
|---|---|---|---|
| `curl … \| bash` | deny | 1.00 | 1.00 |
| `rm -rf /tmp/test-dir` | allow | 0.58 | **0.16** |
| `ls -la /tmp` | allow | 1.00 | 1.00 |
| `git status` | allow | 1.00 | 0.99 |

映射要点:

1. **精确同构**:allow/ask/deny 三选一 = `choice` 原语;三个选项的 criteria 描述可直接复用 `CLASSIFIER_SYSTEM` 的三段定义(`extensions/pi-verdict.ts:898-1001`)。
2. **校准的不确定性是新增能力**:`rm -rf` 案例 P=0.58/conf=0.16 正是 "medium confidence: proceed with caution" 区间——官方 confidence-routing 模式("The answer tells you what; confidence tells you whether to act",docs/patterns/confidence-routing.md)可把它阈值化为 ask,把 "Err on the side of ask" 从提示词软约束变成代码硬阈值。LLM 分类器拿不到这个信号。
3. **契约可靠性**:schema 约束下构造性不可能输出畸形判定,`parseVerdict` 失败 → fail-closed 这条路径(以及 512→1024 重试档)对 jev 几乎消失。
4. **reason 缺口**:jev 不产自由文本,ask 对话框的一行理由只能模板化(choice + confidence + 概率分布)——UX 回退,需产品决策。

## 四、风险与未知

- **对抗鲁棒性(决定性风险,官方自认)**:jaggedness 文档:"State is data, and `jev-1.13` does not treat it as hostile by default. Content written to adversarially steer the model, whether that is an injected instruction, a deliberately misleading framing, or text that argues for its own classification, can move the answer." pi-verdict 的 state 恰是含不可信文件内容的 transcript(间接读取、copy-then-read 等绕过用例见 `research/rule-layer-security-audit.md`)。**fail-closed 只兜解析/网络故障,兜不住 confidently wrong。**
- **非英语衰减(官方声明)**:Models 页:"English is the primary training language and where accuracy is currently best. Other languages, including CJK scripts, are handled but not equally well; test on your own content before relying on Jev for a non-English workload." 本机工作流以中文为主,transcript 常含中文——必须实测。
- **已知失败模式**(jaggedness 页,官方自认):literal reading(否定/范围词按字面读)、计数与数值精度差、日期比较差、间接引用(double negative / property-of-property)衰减、大 state 含无关细节时分心(需先过滤)。分类器的 transcript 恰是「多工具调用拼接、含无关细节」的形态,与 "Large state full of irrelevant detail" 风险面重叠。
- **版本策略**:`jev-latest`/`~typesafe/jev-latest` 均为滚动别名,响应 `model` 回报具体版本;官方明示 "If you have tuned confidence thresholds against a specific version, pin that version's ID instead of the alias"——若做 confidence 阈值,应 pin `jev-1.13.0` / `typesafe/jev-1.13`。
- **成熟度**:产品发布 3 天;OpenRouter 端点处于 **alpha**(`alpha.decisions` tag);单 vendor、无 SLA;速率限制动态调整中;typesafe 定价可持续性官方自认未证明("We can't prove it isn't subsidized")。
- **结构不变式不保证**(官方自认):同一问题的 Noul 版与 Choice 版概率不可互相换算,P(A) + P(¬A) ≠ 1 等算术恒等式不成立——阈值只能在单一问题形态上调。

## 五、建议下一步

1. **现在不改架构、不写代码**。pi-verdict 的模型无关设计已经给出正确的等待姿势;`classifierModel` 指向 jev 时会因 find/complete 失败而自动回退会话模型,不会损坏行为。
2. **短期(零代码实验)**:主会话已有的 OpenRouter key 可直接脚本化复跑 3.3 的行为实测,扩到 allow/ask/deny 三分类 + 中文 transcript + `research/rule-layer-security-audit.md` 的对抗用例集,拿 recall/校准曲线——这是决定 go/no-go 的唯一关键数据,成本可忽略($0.0002/次)。
3. **中期(若实验通过)**:写独立 adapter 扩展(路径 C:`pi.registerProvider()` + Custom Streaming API),把 `complete()` 翻译到 `/api/alpha/decisions`,reason 模板透传 `choice + confidence + probabilities`,并实验 confidence 阈值化的 ask 策略;pi-verdict 本体保持零改动。优先经 OpenRouter(复用 pi 凭证体系、同价),alpha 稳定后再评估 typesafe 直连。
4. **无论走哪条路**:超时 + fail-closed 语义保留——schema 保证只消灭「畸形输出」一类故障,网络/限流/5xx/对抗性误导仍需兜底;置信度阈值必须 pin 版本号调试。

## 附录:核验命令与关键输出(2026-09-18,本机)

```console
$ curl -s https://openrouter.ai/api/v1/models | jq '{total: (.data | length)}'
{"total": 445}          # 无 typesafe/jev 条目;~deepseek/*、~z-ai/* 等 ~ 别名在列

$ curl -s "https://openrouter.ai/api/v1/models/~typesafe/jev-latest"
{"error":{"message":"Not Found","code":404}}   # 单模型端点亦无

$ curl -sL https://openrouter.ai/~typesafe/jev-latest | grep -o '<title>[^<]*</title>'
<title>Jev Latest - API Pricing &amp; Providers | OpenRouter</title>
# meta description: "This model always redirects to the latest model in the Jev family. \
#   $0.042 per million input tokens, $0 per million output tokens. 32,000 token context window."

$ curl -sL https://openrouter.ai/typesafe/jev-1.13 | grep -o '<meta name="description" content="[^"]*"'
# "Jev is a structured decision model from TypeSafe, and the first of its System One models. …"
# 内嵌目录 JSON: output_modalities ["decisions"], has_text_output false, supports_reasoning false,
#   supported_parameters [], context_length 32000, permaslug typesafe/jev-1.13-20260917,
#   provider_name "TypeSafe", baseUrl https://api.typesafe.ai/v1, adapter "TypeSafeDecisionsAdapter",
#   created_at 2026-09-18T00:01:24Z

$ gh api 'orgs/typesafe-ai/repos' --jq '.[].full_name'
# typesafe-ai/{typesafe-sdk-js, typesafe-sdk-python, system-one-adapter-python, skills, …}

$ npm view @typesafe-ai/sdk version engines
# 0.6.0; node >=20
```

随库实测(主会话,真实 OpenRouter key,2026-09):chat/completions 对两 slug 400("…is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead.");decisions 调用成功,`model: typesafe/jev-1.13-20260917`,`provider: "TypeSafe"`;6 次调用 cost ≡ input_tokens × 4.2e-8(输出计费 0),往返 0.96–1.68s;行为样本见 3.3 节表格。

## 来源清单

- typesafe 博客(定位 / RLCD / 定价 / 延迟 / 方法学自认): <https://typesafe.ai/blog/introducing-system-one-models-and-jev>
- typesafe 文档站: API 参考 <https://docs.typesafe.ai/api> 、Quickstart <https://docs.typesafe.ai/introduction/quickstart> 、Models(定价/限速/上下文/别名/语言/版本 pin 建议) <https://docs.typesafe.ai/models> 、Noul 语义 <https://docs.typesafe.ai/primitives/noul> 、Confidence 语义 <https://docs.typesafe.ai/confidence> 、已知缺陷(对抗内容/大 state/literal reading) <https://docs.typesafe.ai/model-jaggedness/jev-1.13> 、confidence-routing 模式 <https://docs.typesafe.ai/patterns/confidence-routing.md> 、索引 <https://docs.typesafe.ai/llms.txt>
- OpenRouter: models API <https://openrouter.ai/api/v1/models> 、decisions OpenAPI <https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request.md> 、`~latest` 语义 <https://openrouter.ai/docs/guides/routing/routers/latest-resolution.md> 、Model Variants(目录非穷尽说明) <https://openrouter.ai/docs/guides/routing/model-variants/overview.md> 、模型页 <https://openrouter.ai/~typesafe/jev-latest> / <https://openrouter.ai/typesafe/jev-1.13>
- GitHub: org <https://github.com/typesafe-ai>(typesafe-sdk-js、typesafe-sdk-python、system-one-adapter-python、skills)
- 本仓库: `extensions/pi-verdict.ts`(分类器契约 :898-1001、resolveClassifier :1545-1563、completionFor :1044/1611)、`research/pi-model-call-and-ref-implementations.md`、`research/thinking-param-blackhole.md`、`research/rule-layer-security-audit.md`
- 参考实现(路径 D 实战): <https://github.com/iefnaf/pi-jev>(vendored client `src/vendor/fast-jev-compaction/`、双 transport 配置 `src/shared/config.ts`、题型与 confidence 阈值 `src/routing/decide.ts`,2026-09-18 经 gh api 核验)
- 本机 pi 文档: `node_modules/@earendil-works/pi-coding-agent/docs/providers.md`(openrouter 内置 provider :49,85)、`docs/custom-provider.md`(registerProvider :3、Custom Streaming API :25、legacy api 名 :75)
