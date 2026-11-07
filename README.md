# magpie-index-translate

把 B 站 [Index-Translate](https://index-translate.bilibili.com/) 翻译模型家族接成 [magpie](https://usemagpie.ai/docs/zh/plugins) 的供应商插件。

**开箱即用**：默认直连官方免费公共 API（`https://index-translate.bilibili.com/v1`，OpenAI 兼容），不需要 GPU、不需要 API key、不需要部署。装上插件就能用 `index-translate/<模型>`；登录是可选的，只有切换到自建服务时才需要。

同一个包也是标准 OpenCode v1 供应商插件，在 OpenCode 里也能直接加载（magpie 自有钩子会被忽略）。

---

## 0. v1.1：修复 magpie 里的 404 报错

如果 magpie 日志里出现过这两条：

```text
gateway: ... bili-translate/Index-Translate-9B ... 404: provider switched off
gateway: ... group/auto-index-translate-9b ... 404: unknown model
```

对照本机已能正常工作的 `magpie-bilibili-translate` 插件，v1.1 做了这些改动：

| 问题 | v1.0 | v1.1 |
| --- | --- | --- |
| 模型从 agent 组里消失，选 Auto 时 `unknown model` | 静态表标了 `tool_call: false`，magpie 会把这类模型从 agent / auto 模型组里过滤掉 | 去掉该标记；兼容性改由 `fetch` 删除 `tools` 字段保证，模型仍可被选中且不会 400 |
| 插件加载被联网钩子拖慢 | `provider.models` / `auth.usage` 每次都请求 `/v1/models`，而 magpie 对模型列表钩子有 20s 超时 | 默认只用 `config` 里的静态表；需要动态刷新时开 `dynamicModels` |
| 未登录就不可用 | `loader` 在 `auth.type !== "api"` 时返回空对象 | 无条件返回，登录与否都能发请求 |

另外两条属于 magpie 里的**配置残留**，需要在应用里手动改一次：

1. `provider switched off` 是因为旧的 `bili-translate` 插件被关掉了，但默认 agent 模型还指向它。到模型选择里把默认模型改成 `index-translate/Index-Translate-9B`。
2. `group/auto-index-translate-9b` 是之前生成的自动模型组。升级后重新选一次模型，不要继续用旧的 auto 组条目。
3. 改完源码后把插件**关掉再打开**，让 magpie 重新加载（终端命令每次都会按当前文件重新加载）。

如果同时装了 `magpie-bilibili-translate`，两个供应商指向同一个免费 API，留一个即可；旧的可以保持关闭，避免模型列表重复。

---

## 1. 从私有 GitHub 仓库安装

本仓库是 **private**。先在本机完成 GitHub 登录（`gh auth login`，或 VS Code / Git Credential Manager 登录），然后任选一种：

```sh
# 方式 A：让 magpie 直接拉仓库（需要 gh CLI 登录）
magpie plugin add github:HyHbh-dev/magpie-index-translate

# 方式 B：先 clone 再按文件夹添加（最稳，不依赖 gh）
git clone https://github.com/HyHbh-dev/magpie-index-translate.git
magpie plugin add ./magpie-index-translate
```

若拉取时报 401 / 403，说明本机命令行没有 GitHub 凭据，补一次登录即可。

---

## 2. 三步上手

> 前提：已安装 magpie（终端能运行 `magpie`）。Node / Bun 不是必须的，只有跑自检脚本才需要 Node 18+。

**Windows PowerShell**（把路径换成你实际存放本文件夹的位置）：

```powershell
cd C:\Users\64177\WorkBuddy\2026-11-07-09-09-20\magpie-index-translate

# 1) 添加插件（文件夹就地加载，不安装任何依赖）
magpie plugin add C:\Users\64177\WorkBuddy\2026-11-07-09-09-20\magpie-index-translate

# 2) 验证
magpie provider test index-translate
magpie plugin
```

登录是可选的。想切换到自建服务、或让 magpie 里有明确的账号条目时再执行：

```powershell
magpie plugin login index-translate
# 选择服务 -> 选「官方免费公共 API（零配置，推荐）」
# API key   -> 随便填，例如 index（官方接口不校验）
```

**macOS / Linux**：

```sh
magpie plugin add /绝对路径/magpie-index-translate
magpie provider test index-translate
```

`magpie provider test index-translate` 会给每种 API 发一个很小的请求，看到 `✓ chat` 就通了。

**在 magpie 应用里操作**：打开「插件」→「添加插件」→ 填入本文件夹路径；模型选择里选 `index-translate/Index-Translate-9B`。改过插件源码后，把插件关掉再打开即可重新加载。

---

## 3. 可用模型

模型 ID 写成 `<供应商>/<模型>`，例如 `index-translate/Index-Translate-35B-A3B`。

| 模型 ID | 用途 | 上下文 | 图片 |
| --- | --- | --- | --- |
| `Index-Translate-35B-A3B` | 旗舰，150 语言、指令跟随、梗/文化语境，**支持图片翻译** | 24K | ✅ |
| `Index-Translate-9B` | 均衡，质量接近旗舰 | 32K | — |
| `Index-Translate-2B` | 轻量、最快 | 32K | — |
| `Index-Nailong-9B` | 长文档 / 整本小说，人名与称谓一致性 | 224K | — |
| `Index-Nailong-2B` | 长文档轻量版 | 256K | — |
| `Index-Homura-9B` | 配音台词：按目标音节数控制译文长度 | 32K | — |
| `Index-Homura-2B` | 配音台词轻量版 | 32K | — |

模型表默认**静态、不联网刷新**（magpie 对模型列表钩子有 20s 超时，静态表更稳）。需要跟随官方上新模型时把 `dynamicModels` 设为 `true`，失败会自动回退到静态表。语音模型（Index-Echo S2TT / S2ST）不在列表里：它们需要官方推理包处理音频，不能走 chat completions 文本接口。

所有模型标了 `free: true`，不占 magpie 的额度统计。并发默认限制为 2，避免给公共接口添压力。

---

## 4. 怎么用（重要）

这是**翻译专用模型，不是通用聊天模型**。正确用法是把一段翻译指令作为用户消息发给它；不要把它设成 Claude Code / Codex 之类 agent 的主模型去跑带工具调用的任务。

插件会自动帮你处理这些坑（都是实测过的）：

- 删除 `tools`、`tool_choice`、`response_format` 等字段 —— 官方接口带 `tools` 会直接 400（`"auto" tool choice requires --enable-auto-tool-choice`）。这也是为什么模型表不标 `tool_call: false`：既让模型能被 agent 选中，又不会真的把工具定义发给翻译模型。
- 把 `max_tokens` 夹到 4096 —— 超上限会 400（`max_tokens cannot be greater than max_model_len`）。
- 强制 `chat_template_kwargs.enable_thinking = false`，并兜底清理 `<think>` 标签，否则思维链会顶掉译文。
- 只保留最后一条 `user` 消息，默认丢掉 agent 的超长 system prompt（翻译模型按单轮指令训练）。
- 带上官方约定请求头 `User-Agent: Index-Translate-Client/1.0`。

**最简指令**（直接发给该模型）：

```
请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释：

你好，世界。今天天气不错，我们去公园散步吧。
```

**带术语表 / 格式保留**（官方 instTrans 规范，命中率最高）：

```
请将以下文本翻译成英语，并且严格遵循所有约束要求。

【源文】
{"title": "⭐2月13日例行维护公告⭐", "content": "#热血航线大和登场#"}

【约束要求】
1. 【硬性要求】专名/术语对照: 碳纤维→carbon fiber、抗裂缝→crack resistance
2. 【硬性要求】保留源文中的 JSON 格式标记与 key 不变
3. 【注意】保持社交平台话题标签原样

只输出译文，不要有任何额外说明。
```

更多模板（不可译片段锁定、HTML/占位符保护、领域消歧、图片、音节控制、长文档）见 [`examples/prompts.md`](examples/prompts.md)。

**图片翻译**：把 `image_url`（base64 data URL）作为 `content` 数组的一项发给 35B 模型，和 OpenAI 视觉格式一致。

---

## 5. 插件选项

默认值已经调好，一般不用改。需要调整时：

```powershell
magpie plugin options index-translate '{"maxTokens":8192,"keepSystem":true}'
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `dynamicModels` | `false` | 是否注册 `provider.models` / `auth.usage` 两个联网钩子，动态刷新官方模型列表。默认关闭更稳。 |
| `keepSystem` | `false` | 是否把较短（≤800 字符）的 system 指令并入用户消息。默认丢弃，避免 agent 的角色设定污染译文。 |
| `maxTokens` | `4096` | 请求输出上限。跑 Nailong 长文档可调到 `16384`，但别用到 35B 上（会超模型上限）。 |
| `temperature` | `0` | agent 没指定时的默认值，官方推荐 greedy。Homura 建议 0.3，可在单次请求里覆盖。 |
| `stripThinking` | `true` | 兜底清理非流式响应里的 `<think>…</think>`。 |
| `timeoutMs` | `120000` | 单次请求超时（毫秒），长文档可适当调大。 |
| `baseURL` | — | 临时覆盖服务地址，不改登录信息。 |

清掉选项：`magpie plugin options index-translate off`。

---

## 6. 切换到自建服务

想用本地 vLLM / SGLang / llama.cpp（或内网服务）时，重新登录并选择「自建」：

```powershell
magpie plugin login index-translate
# 选择服务 -> 自建 vLLM / SGLang / llama.cpp
# 自建服务地址 -> http://127.0.0.1:8000/v1   （必须以 /v1 结尾）
# API key -> 填 EMPTY 或你服务配置的密钥
```

官方仓库的自建启动方式：

```sh
git clone https://github.com/bilibili/Index-Translate.git
cd Index-Translate
pip install -r inference/llm/requirements.txt
./inference/llm/serve_vllm.sh translate-9b          # vLLM，默认 8000 端口
# 或：./inference/llm/serve_sglang.sh translate-9b --mtp   # SGLang，默认 30000 端口
```

也可以不登录，直接用 `baseURL` 选项临时覆盖。自建服务返回的模型 ID 若与官方不同（例如 HF 路径），静态表里的模型仍可用。

---

## 7. 自检（不装 magpie 也能验证）

```powershell
node selftest.mjs
```

会离线检查请求规范化、`<think>` 清洗、地址解析、静态模型表与钩子行为，并真实打 3 个很小的请求（普通翻译、图片、流式）。全 `PASS` 说明插件逻辑和官方接口都正常。因为用的是公共免费服务，别反复高频跑。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `404 provider switched off` | 旧的 `bili-translate` 插件被禁用，但默认模型仍指向它。把默认模型改成 `index-translate/Index-Translate-9B`。 |
| `404 unknown model` + `group/auto-...` | v1.0 的 `tool_call: false` 让模型被 agent 组过滤。升级到 v1.1，并在应用里重新选一次模型。 |
| `400 "auto" tool choice requires ...` | 说明请求绕过了插件的 fetch（例如直接用 curl 打官方接口时带了 tools）。走 magpie 供应商不会有问题。 |
| `400 max_tokens cannot be greater than max_model_len` | 插件已夹到 4096。若你把 `maxTokens` 调大了，调回 `4096`；长文档只在 Nailong 模型上放大。 |
| 译文里出现解释、寒暄或思维链 | 在指令里写「直接输出翻译结果，不要进行任何解释」；确认 `stripThinking` 没被关掉。 |
| 429 / 超时 / 排队 | 官方免费公共接口有压力，稍后重试，或切换到自建服务。插件并发默认 2。 |
| 想翻译语音 / 给视频配音 | 用官方 [Echo S2TT / S2ST 推理包](https://github.com/bilibili/Index-Translate) 或在线 Demo，本插件只覆盖文本与图片接口。 |
| 长文档被截断 | 用 `Index-Nailong-9B` 并把 `maxTokens` 调到 `16384`；超长内容仍受服务端限制。 |
| 改了源码没生效 | 终端命令每次都会重新加载文件夹；应用里需要把插件关掉再打开。 |

---

## 9. 文件说明

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | 插件入口，只导出一个函数（magpie 会把入口导出的每个函数都当插件跑）。默认只提供 `config` / `auth` 钩子，无联网钩子。 |
| `lib.mjs` | 内部纯函数：静态模型表、请求规范化、响应清洗、模型映射、地址解析。零外部依赖。 |
| `selftest.mjs` | 自检脚本，Node 18+ 直接跑。 |
| `package.json` | 清单与 `magpie` 扩展字段（名称、图标、简介、并发、建议选项）。 |
| `examples/prompts.md` | 官方提示词模板速查。 |

## 参考

- 项目主页：https://index-translate.bilibili.com/
- GitHub（免费 API、call_api.py、prompts、自建部署）：https://github.com/bilibili/Index-Translate
- magpie 插件文档：https://usemagpie.ai/docs/zh/plugins
- magpie 社区插件仓库：https://github.com/magpie-community/plugins

> 官方项目采用 Apache-2.0；本插件为独立封装，未包含任何官方模型权重。公共免费接口请按官方用途合理使用。
