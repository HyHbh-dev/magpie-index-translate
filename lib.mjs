/**
 * lib.mjs — magpie-index-translate 的内部实现。
 *
 * 这个文件不是插件入口：入口 index.mjs 用官方推荐的 `export default { id, server }`
 * 形态导出，纯函数都放在这里供 selftest.mjs 复用（入口模块别导出函数，
 * 否则会被 magpie 当成第二个插件执行）。
 * 零外部依赖，Bun / Node 18+ 均可直接运行。
 */

export const PROVIDER = "index-translate"
export const DEFAULT_BASE = "https://index-translate.bilibili.com/v1"
export const USER_AGENT = "Index-Translate-Client/1.0"
export const DEFAULT_MODEL = "Index-Translate-35B-A3B"

/** 插件选项的默认值，可被 plugins.json 的 options 或 magpie.option 覆盖。 */
export const DEFAULTS = Object.freeze({
  // v2.0：默认把 messages 原样透传（system 与全部历史都不动）。
  // 置 true 才启用 v1.x 的裁剪：只留最后一条 user + 按 pickSystem 判定 system。
  // 只在你确认「客户端发的历史会污染译文」时才需要开。
  trimHistory: false,
  // 仅在 trimHistory=true 时生效：连不含翻译关键词的中等长度 system 也保留。
  keepSystem: false,
  // 官方公共 API 对 max_tokens 有硬上限，超出直接 400。统一夹到这个值。
  maxTokens: 4096,
  temperature: 0,
  // 兜底清理 <think>…</think>（服务端已通过 chat_template_kwargs 强制关闭思考）。
  stripThinking: true,
  timeoutMs: 120000,
  // 流式请求带 stream_options.include_usage，让响应末尾回传真实 token 数。
  // magpie 靠它统计输入/输出 token；自建服务不认这个字段时设为 false。
  includeUsage: true,
  // v2.0：默认开启动态模型列表（5 分钟缓存 + 5 秒超时 + 静态表兜底）。
  // 想要完全离线、零联网钩子，设为 false。
  dynamicModels: true,
  // 排错用：填一个文件路径，就会把每个进来的原始请求体按行追加进去（JSONL）。
  // 用来确认调用方到底发了什么 messages，默认关闭。
  capturePath: "",
})

/**
 * 静态模型表（默认唯一来源，不联网）。
 * 语音模型（Index-Echo S2TT/S2ST）不在此列出：它们需要官方推理包处理音频，
 * 不能通过 chat completions 文本接口调用，列出来只会让用户误选。
 *
 * 注意：这里刻意不写 tool_call:false。magpie 会把标记了「不支持工具调用」的模型
 * 从 agent / auto 模型组里过滤掉，表现为 `group/auto-index-translate-9b -> 404 unknown model`。
 * 兼容性由 index.mjs 的 fetch 删除 tools 字段来保证。
 */
export const STATIC_MODELS = {
  "Index-Translate-35B-A3B": {
    name: "Index-Translate 35B-A3B · 旗舰 / 图片翻译",
    limit: { context: 24576, output: 4096 },
    modalities: { input: ["text", "image"], output: ["text"] },
    free: true,
  },
  "Index-Translate-9B": {
    name: "Index-Translate 9B · 均衡",
    limit: { context: 32768, output: 4096 },
    modalities: { input: ["text"], output: ["text"] },
    free: true,
  },
  "Index-Translate-2B": {
    name: "Index-Translate 2B · 轻量 / 最快",
    limit: { context: 32768, output: 4096 },
    modalities: { input: ["text"], output: ["text"] },
    free: true,
  },
  "Index-Nailong-9B": {
    name: "Index-NativeLong 9B · 长文档 / 整本小说",
    limit: { context: 229376, output: 16384 },
    modalities: { input: ["text"], output: ["text"] },
    free: true,
  },
  "Index-Nailong-2B": {
    name: "Index-NativeLong 2B · 长文档 / 轻量",
    limit: { context: 262144, output: 16384 },
    modalities: { input: ["text"], output: ["text"] },
    free: true,
  },
  "Index-Homura-9B": {
    name: "Index-Homura 9B · 配音音节数控制",
    limit: { context: 32768, output: 4096 },
    modalities: { input: ["text"], output: ["text"] },
    free: true,
  },
  "Index-Homura-2B": {
    name: "Index-Homura 2B · 配音音节数控制 / 轻量",
    limit: { context: 32768, output: 4096 },
    modalities: { input: ["text"], output: ["text"] },
    free: true,
  },
}

/** 合并插件选项：默认值 < 宿主传入的 magpie.options < plugins.json 的 options。 */
export function mergeOptions(input = {}, options = {}) {
  const fromHost = input?.magpie?.options ?? input?.magpie?.option ?? {}
  return { ...DEFAULTS, ...(fromHost || {}), ...(options || {}) }
}

/**
 * 从账号登录信息里解析服务地址。
 * - 默认走官方免费公共 API，不需要真实密钥。
 * - 登录时选择 custom 并填了 /v1 地址，就走自建 vLLM / SGLang / llama.cpp。
 * - 插件选项 baseURL 优先级最高，方便临时改地址不用重新登录。
 */
export function resolveEndpoint(auth, opts = {}) {
  const meta = auth?.metadata || {}
  const isCustom =
    meta.endpoint === "custom" &&
    typeof meta.baseURL === "string" &&
    meta.baseURL.trim().length > 0

  let baseURL = String(opts.baseURL || (isCustom ? meta.baseURL : DEFAULT_BASE) || DEFAULT_BASE)
    .trim()
    .replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(baseURL)) baseURL = "http://" + baseURL

  // 官方公共 API 不校验密钥；vLLM 自建服务通常约定 EMPTY。
  const key =
    typeof auth?.key === "string" && auth.key.trim()
      ? auth.key.trim()
      : isCustom
        ? "EMPTY"
        : "index"

  return { baseURL, key, isCustom, isPublic: !isCustom }
}

// stream_options 不在删除列表里：流式响应必须靠它带回 usage，否则 magpie 的
// 输入/输出 token 会一直是 0（见 normalizeRequest 里的强制注入）。
const DROP_FIELDS = [
  "tools", "tool_choice", "parallel_tool_calls", "functions", "function_call",
  "response_format", "logprobs", "top_logprobs", "reasoning_effort", "thinking",
  "service_tier", "n", "seed", "user", "metadata",
  "modalities", "prediction", "audio", "web_search_options", "safety_settings",
]

function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && (p.type === "text" || p.type === "input_text"))
      .map((p) => p.text || "")
      .join("\n")
  }
  return ""
}

/**
 * 翻译指令通常写在 system 里（"Translate into Simplified Chinese"），
 * 丢掉它模型就不知道要干什么，会回一大段解释/闲聊——用户看到的就是「翻译是一大串」。
 * 但 agent（Claude Code 等）的 system 是几千字符的角色设定，留下来会污染译文。
 *
 * 判定规则（按顺序）：
 *  1) 超过 8000 字符一律丢弃（只可能是 agent 的角色设定）；
 *  2) 含翻译/语言关键词时保留，**不受长度限制**——SnowShot 等截图翻译工具给的
 *     translationSystemPrompt 有 1800+ 字符，按长度丢弃就等于把指令扔了；
 *  3) keepSystem=true 时保留中等长度的 system；
 *  4) 其余（例如 "You are Claude Code"）一律丢弃，避免污染译文。
 */
const TRANSLATE_HINT =
  /translat|locali[sz]e|翻译|翻譯|译成|譯成|译文|譯文|language|语言|語言|中文|英文|英语|英語|汉语|漢語|简体|簡體|繁体|繁體|日文|日语|日語|韩文|韩语|韓語|法文|法语|法语|德文|德语|西班牙|俄语|日本語|한국어|español|français|deutsch|русск|português|italiano/i

/** 再长的 system 只可能是 agent 的角色设定/工具说明，翻译时带上纯属干扰。 */
const MAX_SYSTEM = 8000

export function pickSystem(messages, keepSystem = false) {
  const system = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === "system" || m.role === "developer"))
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join("\n")
    .trim()

  if (!system) return ""
  if (system.length > MAX_SYSTEM) return ""
  if (TRANSLATE_HINT.test(system)) return system
  if (keepSystem) return system
  return ""
}

/**
 * 把 agent 发来的 chat completions 请求改写成 Index-Translate 能接受的形式。
 * 实测的两个坑：
 *  1) 带 tools 会 400："auto" tool choice requires --enable-auto-tool-choice；
 *  2) max_tokens > 模型上限会 400：max_tokens cannot be greater than max_model_len。
 * 另外强制 enable_thinking=false，否则思维链会顶掉译文（官方 call_api.py 同款做法）。
 */
export function normalizeRequest(body, opts = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const b = { ...body }

  for (const key of DROP_FIELDS) delete b[key]

  b.chat_template_kwargs = {
    ...(b.chat_template_kwargs && typeof b.chat_template_kwargs === "object"
      ? b.chat_template_kwargs
      : {}),
    enable_thinking: false,
  }

  const cap = Math.min(
    Math.max(1, Number(opts.maxTokens) || DEFAULTS.maxTokens),
    65536,
  )
  const clampTokens = (value) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return cap
    return Math.max(1, Math.min(Math.floor(n), cap))
  }

  if (b.max_tokens != null) b.max_tokens = clampTokens(b.max_tokens)
  else b.max_tokens = cap
  for (const key of ["max_completion_tokens", "max_output_tokens"]) {
    if (b[key] != null) b[key] = clampTokens(b[key])
  }
  if (b.temperature == null && opts.temperature != null) {
    b.temperature = Number(opts.temperature)
  }

  // 关键：OpenAI 兼容接口的流式响应默认不返回 usage，magpie 因此把每次请求的
  // 输入/输出 token 记成 0（用量面板一片空白）。官方服务端是 vLLM，
  // 支持 stream_options.include_usage，会在最后一个 chunk 带上 prompt/completion_tokens。
  // 自建服务万一不认这个字段，可把选项 includeUsage 设为 false 关掉。
  if (b.stream === true && opts.includeUsage !== false) {
    b.stream_options = {
      ...(b.stream_options && typeof b.stream_options === "object" ? b.stream_options : {}),
      include_usage: true,
    }
  } else if (b.stream_options && typeof b.stream_options === "object") {
    // 非流式请求带 stream_options 没有意义，部分服务端会直接 400。
    delete b.stream_options
  }

  // v2.0：默认不改 messages。翻译指令、system、多轮历史一律原样透传——
  // 少改一处就少一个 bug 来源（v1.2~v1.4 的三个问题全由这里引发）。
  // 只有显式开 trimHistory 时才走 v1.x 的裁剪逻辑：
  //   翻译模型按「单轮 user 指令」训练，只保留最后一条 user 消息；
  //   system 走 pickSystem 判定（翻译指令保留，agent 的超长角色设定丢弃）。
  if (opts.trimHistory === true && Array.isArray(b.messages) && b.messages.length > 0) {
    const lastUser = [...b.messages].reverse().find((m) => m && m.role === "user")
    if (lastUser) {
      const system = pickSystem(b.messages, !!opts.keepSystem)
      // 保留为独立的 system 消息：官方模型对 system 角色的支持比「拼进 user」更好，
      // 实测同一条翻译指令放进 system 时输出 16 tokens 干净译文，拼进 user 容易带上寒暄。
      b.messages = system
        ? [
            { role: "system", content: system },
            { role: "user", content: lastUser.content },
          ]
        : [{ role: "user", content: lastUser.content }]
    }
  }

  return b
}

/** 官方 call_api.py 的 strip_think 同款兜底。 */
export function stripThink(text) {
  if (typeof text !== "string") return text
  let t = text
  const end = t.indexOf("</think>")
  if (end !== -1) t = t.slice(end + 8)
  t = t.replace(/^\s*<think>\s*/, "")
  return t.trim()
}

function replay(res, text) {
  const headers = new Headers(res.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(text, { status: res.status, statusText: res.statusText, headers })
}

/** 只清洗非流式 JSON 响应；流式 SSE 原样透传（与官方脚本一致，零改写风险）。 */
export async function cleanJsonResponse(res, enabled = true) {
  if (!enabled || !res || !res.ok) return res
  const contentType = res.headers?.get?.("content-type") || ""
  if (!contentType.includes("json")) return res

  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return replay(res, text)
  }

  let changed = false
  for (const choice of Array.isArray(data?.choices) ? data.choices : []) {
    const message = choice?.message
    if (!message) continue
    if (typeof message.content === "string") {
      const clean = stripThink(message.content)
      if (clean !== message.content) {
        message.content = clean
        changed = true
      }
    } else if (Array.isArray(message.content)) {
      message.content = message.content.map((part) => {
        if (part && typeof part.text === "string") {
          const clean = stripThink(part.text)
          if (clean !== part.text) {
            changed = true
            return { ...part, text: clean }
          }
        }
        return part
      })
    }
  }
  return replay(res, changed ? JSON.stringify(data) : text)
}

export const isSpeechModel = (id) => /S2TT|S2ST/i.test(String(id))

/** 把 /v1/models 返回的条目转成 OpenCode / magpie 的 Model。 */
export function modelFromApi(m, existing = {}) {
  const id = String(m.id)
  // 未知模型继承静态表（含 magpie 补齐的 api/limit 等字段），不要凭空造一个对象。
  const fallback = existing[id] || existing[DEFAULT_MODEL] || {}
  const context =
    Number(m.context_length || m.max_context_length) || fallback.limit?.context || 32768
  const output =
    Number(m.max_output_tokens || m.max_tokens) || fallback.limit?.output || 4096
  const vision = Boolean(
    m.capabilities?.vision ||
      m.supports_vision ||
      m.vision ||
      (Array.isArray(m.input_modalities) && m.input_modalities.includes("image")),
  )

  const inputs = vision ? ["text", "image"] : ["text"]

  return {
    ...fallback,
    id,
    name: fallback.name || m.name || id,
    limit: {
      context: Math.max(1024, Math.min(context, 262144)),
      // 官方给长文档模型报的是 229376，直接透给 agent 会诱发超大 max_tokens。
      output: Math.max(256, Math.min(output, 16384)),
    },
    modalities: { input: inputs, output: ["text"] },
    // provider.models 钩子要的是 OpenCode 的 Model 形态（capabilities），
    // config 钩子要的是 modalities。两个都给，哪条路径读哪个都不会错——
    // magpie 从 capabilities.input 判断图片支持，漏了它截图会走错模型。
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: vision,
      toolcall: false,
      input: Object.fromEntries(inputs.map((kind) => [kind, true])),
      output: { text: true },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    free: true,
  }
}
