/**
 * magpie-index-translate v2.0
 *
 * 把 B 站 Index-Translate 模型家族接成 magpie / OpenCode 的供应商插件。
 * 默认直连官方免费公共 API（OpenAI 兼容、无需 GPU、无需密钥），
 * 也可以在登录时切换到自建 vLLM / SGLang / llama.cpp 服务。
 *
 * 参考：
 *  - https://index-translate.bilibili.com/
 *  - https://github.com/bilibili/Index-Translate （Free Online API / call_api.py / prompts.md）
 *  - https://usemagpie.ai/docs/zh/plugins （编写插件）
 *  - https://github.com/Kleistr/magpie-bilibili-translate （「最小干预」思路来源）
 *
 * 设计原则：**只在会 400 的地方动手**。
 *
 * v2.0（合并两个同类插件的优点）
 *  1) 消息不再裁剪。默认把 messages 原样透传（含 system 与全部历史），
 *     与 Kleistr 版一致；v1.3/v1.4 的两轮补丁（system 关键词判定、8000 字符上限）
 *     只在 trimHistory=true 时才会走到。少改一处，就少一个 bug 来源。
 *  2) 删掉 Origin 请求头。浏览器形态的 Origin 会触发官方 WAF，官方代理同样会删。
 *  3) 模型列表默认动态刷新：拉 /v1/models，5 分钟缓存 + 5 秒超时 + 静态表兜底，
 *     失败不影响加载。要完全离线可设 dynamicModels:false。
 *  4) 入口改成 `export default { id, server }`（官方文档推荐形态），
 *     避免「导出的每个函数都被当成插件」这一类事故。
 *  5) 保留 v1.2 的用量修复：流式请求强制 stream_options.include_usage，
 *     否则 magpie 面板里的输入/输出 token 永远是 0（Kleistr 版没有处理这点）。
 *
 * 其余历史修复见 README「版本修复记录」。
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

/** 模型列表缓存：成功的结果才缓存，避免把一次网络抖动冻结成整个会话。 */
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000
const modelsCache = new Map()

function cacheKey(baseURL, key) {
  return `${baseURL}|${key}`
}

function cachedModels(baseURL, key) {
  const hit = modelsCache.get(cacheKey(baseURL, key))
  if (!hit) return undefined
  if (hit.expires <= Date.now()) {
    modelsCache.delete(cacheKey(baseURL, key))
    return undefined
  }
  return hit.models
}

function putModelsCache(baseURL, key, models) {
  modelsCache.set(cacheKey(baseURL, key), {
    expires: Date.now() + MODELS_CACHE_TTL_MS,
    models,
  })
}

const server = async (input = {}, options = {}) => {
  const opts = mergeOptions(input, options)

  /** 失败一律静默回退到静态表——模型列表拿不到不该让插件不可用。 */
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
            // 浏览器形态的 Origin 会触发官方 WAF（官方代理同样会删掉它）。
            headers.delete("origin")

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

  // 动态模型：默认开启，但只影响模型列表，失败一律回退静态表。
  if (opts.dynamicModels !== false) {
    hooks.provider = {
      id: PROVIDER,
      async models(provider, ctx = {}) {
        const fallback =
          provider?.models && Object.keys(provider.models).length
            ? provider.models
            : STATIC_MODELS

        const { baseURL, key } = resolveEndpoint(ctx?.auth, opts)
        const hit = cachedModels(baseURL, key)
        if (hit) return hit

        try {
          const list = await fetchModels(ctx?.auth)
          const usable = list.filter((m) => m?.id && !isSpeechModel(m.id))
          if (!usable.length) return fallback
          const models = Object.fromEntries(
            usable.map((m) => [String(m.id), modelFromApi(m, fallback)]),
          )
          putModelsCache(baseURL, key, models)
          return models
        } catch {
          // 不缓存失败结果：网络恢复后下一次调用应该能拿到真实列表。
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

// 官方推荐的入口形态：`export default { id, server }`。
// 这样入口模块里的辅助函数不会被误当成插件执行（测试用的纯函数都在 lib.mjs）。
export default { id: PROVIDER, server }
