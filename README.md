# magpie-index-translate

把 B 站 [Index-Translate](https://index-translate.bilibili.com/) 翻译模型家族接成 [magpie](https://usemagpie.ai/docs/zh/plugins) 的供应商插件。

**开箱即用**：默认直连官方免费公共 API（`https://index-translate.bilibili.com/v1`，OpenAI 兼容），不需要 GPU、不需要 API key、不需要部署。装上插件就能用 `index-translate/<模型>`；登录是可选的，只有切换到自建服务时才需要。

同一个包也是标准 OpenCode v1 供应商插件，在 OpenCode 里也能直接加载（magpie 自有钩子会被忽略）。

```sh
magpie plugin add github:HyHbh-dev/magpie-index-translate
```


---

## 0. 版本修复记录

### v2.0：把两个同类插件的优点合并

对照公开实现 [`Kleistr/magpie-bilibili-translate`](https://github.com/Kleistr/magpie-bilibili-translate)（MIT）重新审了一遍：它的核心经验是**只在会 400 的地方动手，其余一概不碰**。v1.2 / v1.3 / v1.4 那三个 bug 全部来自本插件对 `messages` 的裁剪，v2.0 直接把这条路砍掉。

| 改动 | 之前（v1.x） | 现在（v2.0） |
| --- | --- | --- |
| 消息处理 | 只留最后一条 `user`，system 按关键词与长度判定 | **原样透传**（system + 全部历史）；`trimHistory: true` 才回到旧行为 |
| `Origin` 请求头 | 未处理 | 删除（浏览器形态的 Origin 会触发官方 WAF） |
| 模型列表 | 静态表，需手动开 `dynamicModels` | 默认动态拉 `/v1/models`：5 分钟缓存 + 5 秒超时 + 静态表兜底 |
| `provider.models` 返回形态 | 只有 `modalities` | 同时给 `capabilities` 与 `cost`，magpie 才能正确判断图片支持 |
| 入口导出 | 命名导出函数 | `export default { id, server }`（官方推荐形态，辅助函数不会被误当插件） |

保留下来的是对方没有的两件事：流式请求强制 `stream_options.include_usage`（否则 magpie 用量面板永远是 0/0）、以及免登录开箱可用 + `capturePath` 排障。v1.3 / v1.4 的 system 判定逻辑没有删，只是退到 `trimHistory: true` 后面。

自检 18 项全通过，含真实翻译、图片、流式与 Origin 头断言。

### v1.4：修复 SnowShot 截图翻译「把报错翻译成一份解决方案」

现象：用 SnowShot 截图翻译一段英文报错，返回的却是一份中文「故障排查指南」（`### Steps to Fix: 1. **Use the Correct Passphrase** …`），700 tokens 起步。

原因：SnowShot 的翻译请求是 `system` 放 **1855 字符**的 `translationSystemPrompt`、`user` 只放 OCR 出来的原文。而 v1.3 有「system 超过 800 字符一律丢弃」的规则（本意是挡 Claude Code 那种几千字的角色设定），恰好把这段指令整段扔掉，模型只看到一句裸报错，于是开始「解答问题」。

对照实验（同一句报错、同一模型）：

| 请求 | 输出 |
| --- | --- |
| 丢掉 system（v1.3 行为） | 475 tokens，`The error message indicates… ### Steps to Fix: 1. **Use the Correct Passphrase**` |
| 保留 SnowShot 原始 system | **27 tokens**，`密码短语无法打开服务器上的文件：该文件是用另一个密码短语加密的；请使用您其他计算机上设置的密码短语。` |

v1.4 改成按内容判定，长度只做兜底上限：

1. 含翻译/语言关键词（`translat`、`翻译`、`译文`、`language`、`中文`…）→ **不论多长都保留**；
2. 超过 8000 字符 → 仍丢弃（只可能是 agent 的角色设定）；
3. 800 字符以内的短 system → 直接透传（少干预）；
4. `keepSystem: true` → 中等长度的一并保留。

v1.3 的第 1 条（800 字符一刀切）自 v1.4 起失效。

新增调试选项 `capturePath`（默认空，即关闭）：填一个本机 `.jsonl` 路径，插件会把每次请求的**原始 body 与规范化后的 body** 追加写入，用于排查「某个客户端发来的请求长什么样」。它记录的是真实译文内容，排查完请及时清空该选项，不要长期开着。

### v1.3：修复「翻译结果是一大串」

现象：翻译一句话，回来的却是一大段英文解释或闲聊，输出 500~700 tokens，耗时 10 秒以上。

原因：浏览器翻译扩展把**翻译指令写在 system 里**（如 “Translate into Simplified Chinese”），而插件默认把 system 整段丢掉，模型收到一段裸文本，不知道要干什么，就自顾自解释起来。对照实验：

| 请求 | 输出 | 内容 |
| --- | --- | --- |
| 只有 user | 85 tokens | `The sentence ... is a well-known example of a Pangram... could you clarify what it says?` |
| 带 system 指令 | 16 tokens | `那只敏捷的棕色狐狸跳过那只懒惰的狗。` |

v1.3 改成按内容判定，不再无脑丢弃：

1. 超过 800 字符的 system 一律丢（agent 的角色设定，如 Claude Code）；
2. `keepSystem: true` 时保留；
3. 含翻译/语言关键词（translate、翻译、中文、日本語…）的短 system **自动保留**，并以独立的 `system` 消息发送。

实测同一条请求：输出从 580 tokens 降到 16 tokens，耗时从 11 秒降到 1 秒内。

### v1.2：修复用量面板里 token 一直是 0

magpie 的用量记录（`usage.jsonl` 和用量面板）里，这个插件的 `in` / `out` 全是 `0`：

```text
"model":"Index-Translate-9B" ... "in":0,"out":0,"status":200
```

原因是 OpenAI 兼容接口的**流式响应默认不返回 usage**，而 v1.1 为了兼容把 `stream_options` 整段从请求里删掉了。agent 调用几乎都是流式，于是每次都拿不到 token 数。

v1.2 改成：流式请求强制带 `stream_options.include_usage`，官方服务端（vLLM）会在最后一个 chunk 回传真实用量：

```text
data: {...,"choices":[],"usage":{"prompt_tokens":28,"total_tokens":38,"completion_tokens":10}}
```

magpie 随即记录为 `in=28 out=10`。非流式请求会去掉这个字段（部分服务端不认）。自建服务不支持时，把 `includeUsage` 设为 `false`。

> 升级后只对新请求生效，历史记录不会补数字。改完插件源码记得在应用里把插件**关掉再打开**。

### v1.1：修复 magpie 里的 404 报错

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

## 1. 安装

一行装好，之后 `magpie plugin update` 可自动升级：

```sh
magpie plugin add github:HyHbh-dev/magpie-index-translate
```

**想改源码 / 离线用**：clone 后按文件夹添加，效果完全相同：

```sh
git clone https://github.com/HyHbh-dev/magpie-index-translate.git
cd magpie-index-translate
magpie plugin add .
```

之后更新：`git pull` → 再执行一次 `magpie plugin add .`（重复 add 会触发重载）。

> 附注：`github:` 简写底层是 `bun add <URL>`，走 GitHub 的 tarball API，**不支持私有仓库鉴权**（bun 维护者原话：「github: syntax is only supported for public repositories in Bun」）。本仓库此前为 private 时用这条必然 `tarball/ - 404`，与 token 无关——magpie 设置里的 GitHub token 不会传给 bun 的这次抓取。现已公开，两条路都可用。

### 注意：只留一份

两种方式的安装目录不同，同时装会出现两个条目、同一个 provider id（`index-translate`）冲突。切换前先删掉旧的：

```sh
magpie plugin                                   # 看现有条目和状态
magpie plugin rm <之前那条的 spec>
```

---

## 2. 三步上手

> 前提：已安装 magpie（终端能运行 `magpie`）。Node / Bun 不是必须的，只有跑自检脚本才需要 Node 18+。

**Windows PowerShell**（把路径换成你实际存放本文件夹的位置）：

```powershell
cd C:\path\to\magpie-index-translate

# 1) 添加插件（文件夹就地加载，不安装任何依赖）
magpie plugin add C:\path\to\magpie-index-translate

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

模型表**默认动态刷新**：加载时请求一次 `<Base URL>/models`，成功结果缓存 5 分钟，5 秒超时，任何失败都静默回退到上面的静态表——网络抖动不会让插件不可用。想要完全离线、零联网钩子，把 `dynamicModels` 设为 `false`。语音模型（Index-Echo S2TT / S2ST）不在列表里：它们需要官方推理包处理音频，不能走 chat completions 文本接口。

所有模型标了 `free: true`，不占 magpie 的额度统计。并发默认限制为 2，避免给公共接口添压力。

---

## 4. 怎么用（重要）

这是**翻译专用模型，不是通用聊天模型**。正确用法是把一段翻译指令作为用户消息发给它；不要把它设成 Claude Code / Codex 之类 agent 的主模型去跑带工具调用的任务。

插件会自动帮你处理这些坑（都是实测过的）：

- 删除 `tools`、`tool_choice`、`response_format` 等字段 —— 官方接口带 `tools` 会直接 400（`"auto" tool choice requires --enable-auto-tool-choice`）。这也是为什么模型表不标 `tool_call: false`：既让模型能被 agent 选中，又不会真的把工具定义发给翻译模型。
- 把 `max_tokens` 夹到 4096 —— 超上限会 400（`max_tokens cannot be greater than max_model_len`）。
- 强制 `chat_template_kwargs.enable_thinking = false`，并兜底清理 `<think>` 标签，否则思维链会顶掉译文。
- 删掉 `Origin` 请求头 —— 浏览器形态的 Origin 会触发官方 WAF。
- **不改 `messages`**：system 与多轮历史原样透传（v2.0 起）。客户端把翻译指令写在 system 里也照样生效；只有显式开 `trimHistory` 才会裁成「最后一条 user + 判定后的 system」。
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
magpie plugin options index-translate '{"maxTokens":8192,"dynamicModels":false}'
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `dynamicModels` | `true` | 注册 `provider.models` / `auth.usage` 两个钩子动态刷新官方模型列表（5 分钟缓存 + 5 秒超时 + 静态表兜底）。想完全离线设 `false`。 |
| `trimHistory` | `false` | 只留最后一条 `user` 消息（v1.x 行为）。默认透传全部 messages；只有确认客户端历史会污染译文时才开。 |
| `keepSystem` | `false` | 仅在 `trimHistory: true` 时生效：连不含翻译关键词的中等长度 system 也保留。 |
| `maxTokens` | `4096` | 请求输出上限。跑 Nailong 长文档可调到 `16384`，但别用到 35B 上（会超模型上限）。 |
| `temperature` | `0` | agent 没指定时的默认值，官方推荐 greedy。Homura 建议 0.3，可在单次请求里覆盖。 |
| `stripThinking` | `true` | 兜底清理非流式响应里的 `<think>…</think>`。 |
| `includeUsage` | `true` | 流式请求带 `stream_options.include_usage`，magpie 才能记下输入/输出 token。自建服务不认这个字段时设为 `false`。 |
| `timeoutMs` | `120000` | 单次请求超时（毫秒），长文档可适当调大。 |
| `baseURL` | — | 临时覆盖服务地址，不改登录信息。 |
| `capturePath` | 空（关闭） | 排障用：填本机 `.jsonl` 路径，把每次请求的原始 body 和规范化后的 body 追加写入。**记录真实译文内容，查完请清掉。** |

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
| 用量面板里输入/输出 token 一直是 0 | v1.1 把 `stream_options` 删掉了，流式响应不带 usage。升级到 v1.2；只对新请求生效，历史记录不会补。 |
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
| `index.mjs` | 插件入口，`export default { id, server }`。负责 `config` / `auth` / `provider` 钩子与请求改写。 |
| `lib.mjs` | 内部纯函数：静态模型表、请求规范化、响应清洗、模型映射、地址解析。零外部依赖。 |
| `selftest.mjs` | 自检脚本，Node 18+ 直接跑。 |
| `package.json` | 清单与 `magpie` 扩展字段（名称、图标、简介、并发、建议选项）。 |
| `examples/prompts.md` | 官方提示词模板速查。 |

## 参考

- 项目主页：https://index-translate.bilibili.com/
- GitHub（免费 API、call_api.py、prompts、自建部署）：https://github.com/bilibili/Index-Translate
- magpie 插件文档：https://usemagpie.ai/docs/zh/plugins
- magpie 社区插件仓库：https://github.com/magpie-community/plugins
- 同类实现（v2.0 的「最小干预」思路与 Origin / 动态模型列表做法来自这里）：https://github.com/Kleistr/magpie-bilibili-translate （MIT）

> 官方项目采用 Apache-2.0；本插件为独立封装，未包含任何官方模型权重。公共免费接口请按官方用途合理使用。
