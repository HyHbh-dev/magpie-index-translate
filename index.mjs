/**
 * magpie-index-translate
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

  /** 拉取 /v1/models，失败时原样返回已有列表（magpie 会保留原列表）。 */
  const fetchModels = async (auth) => {
    const { baseURL, key } = resolveEndpoint(auth, opts)
    const res = await fetch(`${baseURL}/models`, {
      headers: {
        "user-agent": USER_AGENT,
        authorization: `Bearer ${key}`,
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`/v1/models answered ${res.status}`)
    const data = await res.json()
    return Array.isArray(data?.data) ? data.data : []
  }

  return {
    /** 声明供应商与默认模型。用 ??= 以免覆盖用户在 plugins.json 里的配置。 */
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
       * 一次登录即可用。prompts 的回答由 magpie 自动存进 auth.metadata。
       * 官方公共 API 不校验密钥，输入框里随便填一个（例如 index）即可。
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

      /** 每个账号运行一次，返回 AI SDK 会用到的 baseURL / apiKey / fetch。 */
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth || auth.type !== "api") return {}
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
            if (typeof body === "string" && body.trim().startsWith("{")) {
              try {
                const parsed = JSON.parse(body)
                streaming = Boolean(parsed.stream)
                body = JSON.stringify(normalizeRequest(parsed, opts))
              } catch {
                // 不是 JSON（例如二进制），原样透传。
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

      /** magpie 自有钩子：把 /v1/models 当作一次轻量健康检查，显示在 magpie quota。 */
      async usage(getAuth) {
        const auth = await getAuth()
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
          return {
            error: `连接失败：${error?.message || error}`,
            windows: [],
          }
        }
      },
    },

    /** magpie 为每个账号调用一次，按账号列出模型；失败时保留原列表。 */
    provider: {
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
    },
  }
}
