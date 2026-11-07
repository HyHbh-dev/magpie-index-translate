/**
 * magpie-index-translate v1.4
 *
 * 把 B 站 Index-Translate 模型家族接成 magpie / OpenCode 的供应商插件。
 * 默认直连官方免费公共 API（OpenAI 兼容、无需 GPU、无需密钥），
 * 也可以在登录时切换到自建 vLLM / SGLang / llama.cpp 服务。
 *
 * 参考：
 *  - https://index-translate.bilibili.com/
 *  - https://github.com/bilibili/Index-Translate （Free Online API / call_api.py / prompts.md）
 *  - https://usemagpie.ai/docs/zh/plugins （编写插件）
 *
 * v1.1 稳健化改写（对照本机已验证可用的 magpie-bilibili-translate）：
 *  1) 默认只用 config 里的静态模型表，不注册会联网的 provider.models / auth.usage 钩子。
 *     magpie 对模型列表钩子有 20s 超时，免费公共 API 偶尔慢，联网钩子容易拖垮插件加载。
 *     需要动态刷新时把选项 dynamicModels 设为 true。
 *  2) loader 无条件可用：没有登录记录也能发请求（免费 API 本来就不需要密钥）。
 *  3) 模型不再标 tool_call:false。magpie 会把这类模型从 agent / auto 模型组里过滤掉，
 *     表现为 `group/auto-index-translate-9b -> 404 unknown model`。
 *     兼容性改由 fetch 删除 tools 字段来保证，模型仍然会出现在可选列表里。
 *  4) 保留 v1.0 的请求规范化：删 tools、夹 max_tokens、关 thinking、
 *     只留最后一条 user 消息、兜底清洗 <think>。
 *  5) v1.2：流式请求强制带 stream_options.include_usage，让官方服务端在最后一个
 *     chunk 回传 prompt/completion_tokens。否则 magpie 的用量面板永远是 0/0。
 *     非流式请求会去掉该字段；自建服务不认时把选项 includeUsage 设为 false。
 *  6) v1.3：system 不再无脑丢弃。翻译扩展的「Translate into Simplified Chinese」
 *     就写在 system 里，丢了模型会回一大段解释（表现为「翻译结果是一大串」）。
 *     现在按内容判定：>800 字符丢；含翻译/语言关键词的短 system 保留为独立 system 消息。
 *  7) v1.4：v1.3 的「>800 字符丢」也会误伤——SnowShot 的 translationSystemPrompt
 *     有 1855 字符，被丢掉后就变成「把报错翻译成一份解决方案」。
 *     现在含翻译/语言关键词的 system 不论多长都保留，8000 字符才是硬上限。
 *     另加 capturePath 选项（默认关）：把原始/规范化后的请求体写入 jsonl，用于排障。
 *
 * 入口模块只导出一个函数：magpie 会把「导出的每个函数」都当作插件执行。
 */

import {
  PROVIDER,
  DEFAULT_BASE,
  USER_AGENT,
  STATIC_MODELS,
  DEFAULTS,
  mergeOptions,
  resolveEndpoint,
  normalizeRequest,
  cleanJsonResponse,
  modelFromApi,
  isSpeechModel,
} from "./lib.mjs"

export const IndexTranslateAuth = async (input = {}, options = {}) => {
  const opts = mergeOptions(input, options)

  /** 只有 dynamicModels=true 时才会被调用；失败一律静默回退到静态表。 */
  const fetchModels = async (auth) => {
    const { baseURL, key } = resolveEndpoint(auth, opts)
    const res = await fetch(`${baseURL}/models`, {
      headers: {
        "user-agent": USER_AGENT,
        authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`/v1/models answered ${res.status}`)
    const data = await res.json()
    return Array.isArray(data?.data) ? data.data : []
  }

  const hooks = {
    /** 声明供应商与静态模型。用 ??= 以免覆盖用户在 plugins.json 里的配置。 */
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "Index-Translate",
        npm: "@ai-sdk/openai-compatible", // chat completions -> /chat/completions
        api: DEFAULT_BASE,
        models: STATIC_MODELS,
      }
    },

    auth: {
      provider: PROVIDER,

      /**
       * 登录不是必需的。prompts 的回答由 magpie 自动存进 auth.metadata：
       * 选 custom 时用于切换到自建服务；选 public 时走官方免费接口。
       */
      methods: [
        {
          type: "api",
          label: "Index-Translate（官方免费 / 自建服务）",
          placeholder: "官方免费 API 随便填，例如 index",
          prompts: [
            {
              type: "select",
              key: "endpoint",
              message: "选择服务",
              options: [
                {
                  label: "官方免费公共 API（零配置，推荐）",
                  value: "public",
                  hint: "https://index-translate.bilibili.com/v1",
                },
                {
                  label: "自建 vLLM / SGLang / llama.cpp",
                  value: "custom",
                  hint: "本地或内网的 OpenAI 兼容服务",
                },
              ],
            },
            {
              type: "text",
              key: "baseURL",
              message: "自建服务地址（需以 /v1 结尾）",
              placeholder: "http://127.0.0.1:8000/v1",
              when: { key: "endpoint", op: "eq", value: "custom" },
              validate: (value) =>
                /\/v1\/?$/.test(String(value || "").trim())
                  ? undefined
                  : "地址需要以 /v1 结尾，例如 http://127.0.0.1:8000/v1",
            },
          ],
        },
      ],

      /** 无条件返回 baseURL + fetch：有没有登录都直接可用。 */
      async loader(getAuth) {
        let auth
        try {
          auth = typeof getAuth === "function" ? await getAuth() : undefined
        } catch {
          auth = undefined
        }
        const { baseURL, key } = resolveEndpoint(auth, opts)

        return {
          baseURL,
          apiKey: key,
          headers: { "user-agent": USER_AGENT },

          async fetch(url, init = {}) {
            const headers = new Headers(init.headers)
            headers.set("user-agent", USER_AGENT)

            let body = init.body
            let streaming = false
            let raw = null
            let normalized = null
            if (typeof body === "string" && body.trim().startsWith("{")) {
              try {
                const parsed = JSON.parse(body)
                raw = parsed
                streaming = Boolean(parsed.stream)
                normalized = normalizeRequest(parsed, opts)
                body = JSON.stringify(normalized)
              } catch {
                // 不是 JSON（例如二进制），原样透传。
              }
            }

            // 排错开关：把调用方原始请求与规范化后的请求写入 JSONL，事后可对比
            // 「指令到底丢在哪一步」。默认关闭，写失败不影响请求。
            if (opts.capturePath && raw) {
              try {
                const { appendFile } = await import("node:fs/promises")
                await appendFile(
                  opts.capturePath,
                  JSON.stringify({
                    at: new Date().toISOString(),
                    url: String(url),
                    raw,
                    normalized,
                  }) + "\n",
                  "utf8",
                )
              } catch {
                // 忽略：没有写权限时不应该让翻译失败。
              }
            }

            // 合并 agent 的取消信号与插件自己的超时。
            const ctrl = new AbortController()
            const timeout = Math.max(1000, Number(opts.timeoutMs) || DEFAULTS.timeoutMs)
            const timer = setTimeout(
              () => ctrl.abort(new Error("Index-Translate request timed out")),
              timeout,
            )
            const onAbort = () => ctrl.abort(init.signal?.reason)
            if (init.signal) {
              if (init.signal.aborted) ctrl.abort(init.signal.reason)
              else init.signal.addEventListener("abort", onAbort, { once: true })
            }

            let res
            try {
              res = await fetch(url, { ...init, headers, body, signal: ctrl.signal })
            } finally {
              clearTimeout(timer)
              init.signal?.removeEventListener?.("abort", onAbort)
            }

            // 流式 SSE 原样逐块传回；非流式只做 <think> 兜底清洗。
            if (streaming) return res
            return cleanJsonResponse(res, opts.stripThinking)
          },
        }
      },
    },
  }

  // 可选：动态模型与额度健康检查。默认关闭，避免联网钩子影响插件加载。
  if (opts.dynamicModels) {
    hooks.provider = {
      id: PROVIDER,
      async models(provider, ctx = {}) {
        const fallback = provider?.models || STATIC_MODELS
        try {
          const list = await fetchModels(ctx?.auth)
          const usable = list.filter((m) => m?.id && !isSpeechModel(m.id))
          if (!usable.length) return fallback
          return Object.fromEntries(
            usable.map((m) => [String(m.id), modelFromApi(m, fallback)]),
          )
        } catch {
          return fallback
        }
      },
    }
    hooks.auth.usage = async (getAuth) => {
      let auth
      try {
        auth = typeof getAuth === "function" ? await getAuth() : undefined
      } catch {
        auth = undefined
      }
      const { baseURL, isPublic } = resolveEndpoint(auth, opts)
      try {
        const list = await fetchModels(auth)
        return {
          plan: isPublic ? "官方免费公共 API" : `自建服务 · ${baseURL}`,
          windows: [
            {
              name: "可用模型",
              display: `${list.length} 个模型 · 免密钥 · 请勿高频调用`,
              aside: true,
            },
          ],
        }
      } catch (error) {
        return { error: `连接失败：${error?.message || error}`, windows: [] }
      }
    }
  }

  return hooks
}
