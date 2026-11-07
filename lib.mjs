/**
 * lib.mjs — magpie-index-translate 的内部实现。
 *
 * 这个文件不是插件入口：magpie 会把入口模块导出的「每个函数」都当成插件运行，
 * 因此入口 index.mjs 只导出一个函数，其余纯函数都放在这里，供 selftest.mjs 复用。
 * 零外部依赖，Bun / Node 18+ 均可直接运行。
 */

export const PROVIDER = "index-translate"
export const DEFAULT_BASE = "https://index-translate.bilibili.com/v1"
export const USER_AGENT = "Index-Translate-Client/1.0"
export const DEFAULT_MODEL = "Index-Translate-35B-A3B"

/** 插件选项的默认值，可被 plugins.json 的 options 或 magpie.option 覆盖。 */
export const DEFAULTS = Object.freeze({
  // Index-Translate 是翻译专用模型：agent 自带的超长 system prompt 会污染译文，
  // 默认只保留最后一条 user 消息。设为 true 可把较短的 system 指令一起带上。
  keepSystem: false,
  // 官方公共 API 对 max_tokens 有硬上限，超出直接 400。统一夹到这个值。
  maxTokens: 4096,
  temperature: 0,
  // 兜底清理 <think>…</think>（服务端已通过 chat_template_kwargs 强制关闭思考）。
  stripThinking: true,
  timeoutMs: 120000,
  // 默认关闭：开启后才注册 provider.models / auth.usage 这两个联网钩子。
  // magpie 对模型列表钩子有 20s 超时，免费公共 API 偶尔慢，静态表更稳。
  dynamicModels: false,
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

const DROP_FIELDS = [
  "tools", "tool_choice", "parallel_tool_calls", "functions", "function_call",
  "response_format", "logprobs", "top_logprobs", "reasoning_effort", "thinking",
  "service_tier", "stream_options", "n", "seed", "user", "metadata",
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

function attachSystem(content, system, keepSystem) {
  if (!keepSystem || !system || system.length > 800) return content
  if (typeof content === "string") return `${system}\n\n${content}`
  if (Array.isArray(content)) {
    const first = content.find((p) => p && (p.type === "text" || p.type === "input_text"))
    if (first) {
      return content.map((p) =>
        p === first ? { ...p, text: `${system}\n\n${p.text || ""}` } : p,
      )
    }
    return [{ type: "text", text: system }, ...content]
  }
  return content
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

  // 翻译模型按「单轮 user 指令」训练。只保留最后一条 user 消息，
  // 默认丢掉 agent 的 system prompt（Claude Code 之类会带几千 token 的角色设定）。
  if (Array.isArray(b.messages) && b.messages.length > 0) {
    const lastUser = [...b.messages].reverse().find((m) => m && m.role === "user")
    if (lastUser) {
      const system = b.messages
        .filter((m) => m && (m.role === "system" || m.role === "developer"))
        .map((m) => textOf(m.content))
        .filter(Boolean)
        .join("\n")
        .trim()
      b.messages = [
        { role: "user", content: attachSystem(lastUser.content, system, !!opts.keepSystem) },
      ]
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

  return {
    ...fallback,
    id,
    name: fallback.name || m.name || id,
    limit: {
      context: Math.max(1024, Math.min(context, 262144)),
      // 官方给长文档模型报的是 229376，直接透给 agent 会诱发超大 max_tokens。
      output: Math.max(256, Math.min(output, 16384)),
    },
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    free: true,
  }
}
