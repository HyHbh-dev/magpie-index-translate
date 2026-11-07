/**
 * selftest.mjs — 不需要安装 magpie 就能验证插件。
 *
 * 用法：node selftest.mjs
 *
 * 它会像 magpie 宿主那样调用插件的各个钩子，并真实请求官方免费 API
 * （共 3 个很小的请求）。请勿高频运行，这是公共免费服务。
 */

import assert from "node:assert/strict"
import { IndexTranslateAuth } from "./index.mjs"
import {
  PROVIDER,
  DEFAULT_BASE,
  DEFAULT_MODEL,
  STATIC_MODELS,
  normalizeRequest,
  stripThink,
  resolveEndpoint,
  isSpeechModel,
} from "./lib.mjs"

let failed = 0
let passed = 0

async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${name}`)
    console.error(`        ${error?.message || error}`)
  }
}

const watchdog = setTimeout(() => {
  console.error("\n整体超时（90 秒），请检查网络或代理后重试。")
  process.exit(1)
}, 90000)
watchdog.unref()

console.log("\nmagpie-index-translate 自检")
console.log("─".repeat(56))
console.log("1/2  离线逻辑（不联网）")

await check("请求规范化：删除 tools、夹住 max_tokens、关闭 thinking", () => {
  const out = normalizeRequest(
    {
      model: DEFAULT_MODEL,
      max_tokens: 32000,
      tools: [{ type: "function", function: { name: "x" } }],
      tool_choice: "auto",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are Claude Code. Always use tools." },
        { role: "user", content: "把下面翻成英语：你好" },
      ],
    },
    { maxTokens: 4096 },
  )
  assert.equal(out.tools, undefined)
  assert.equal(out.tool_choice, undefined)
  assert.equal(out.response_format, undefined)
  assert.equal(out.max_tokens, 4096)
  assert.equal(out.chat_template_kwargs.enable_thinking, false)
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].role, "user")
  assert.match(out.messages[0].content, /你好/)
})

await check("keepSystem=true 时保留短 system 指令，超长 system 仍丢弃", () => {
  const base = {
    messages: [
      { role: "system", content: "只输出译文" },
      { role: "user", content: "你好" },
    ],
  }
  assert.match(normalizeRequest(base, { keepSystem: true }).messages[0].content, /只输出译文/)
  const long = { messages: [{ role: "system", content: "x".repeat(2000) }, { role: "user", content: "你好" }] }
  assert.equal(normalizeRequest(long, { keepSystem: true }).messages[0].content, "你好")
})

await check("图片消息（content 数组）规范化后不被破坏", () => {
  const parts = [
    { type: "text", text: "Translate the image into Chinese." },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ]
  const out = normalizeRequest({ messages: [{ role: "user", content: parts }] }, {})
  assert.equal(out.messages[0].content.length, 2)
  assert.equal(out.messages[0].content[1].type, "image_url")
})

await check("<think> 兜底清洗", () => {
  assert.equal(stripThink("<think>让我先想想</think>Hello, world."), "Hello, world.")
  assert.equal(stripThink("  <think>\n</think>  Hi.  "), "Hi.")
  assert.equal(stripThink("Plain text."), "Plain text.")
})

await check("服务地址解析：默认公共 API / 自建服务", () => {
  const pub = resolveEndpoint({ type: "api", key: "index", metadata: { endpoint: "public" } })
  assert.equal(pub.baseURL, DEFAULT_BASE)
  assert.equal(pub.isPublic, true)
  const own = resolveEndpoint({
    type: "api",
    key: "EMPTY",
    metadata: { endpoint: "custom", baseURL: "http://127.0.0.1:8000/v1/" },
  })
  assert.equal(own.baseURL, "http://127.0.0.1:8000/v1")
  assert.equal(own.isCustom, true)
})

await check("语音模型被正确识别（不进入模型选择器）", () => {
  assert.equal(isSpeechModel("Index-Echo-S2TT-9B"), true)
  assert.equal(isSpeechModel("Index-Echo-S2ST-2B"), true)
  assert.equal(isSpeechModel(DEFAULT_MODEL), false)
})

await check("模型表不带 tool_call:false（否则会被 magpie 从 agent 组过滤掉）", () => {
  for (const model of Object.values(STATIC_MODELS)) {
    assert.notEqual(model.tool_call, false)
    assert.equal(model.free, true)
    assert.ok(model.limit.context > 0)
  }
})

console.log("\n2/2  钩子与真实接口（需要联网）")

const input = { magpie: { options: {} }, directory: process.cwd() }
const hooks = await IndexTranslateAuth(input, {})
const cfg = {}

await check("config 钩子声明供应商与静态模型", async () => {
  await hooks.config(cfg)
  assert.ok(cfg.provider[PROVIDER])
  assert.equal(cfg.provider[PROVIDER].npm, "@ai-sdk/openai-compatible")
  assert.equal(Object.keys(cfg.provider[PROVIDER].models).length, Object.keys(STATIC_MODELS).length)
})

await check("默认不注册联网钩子（provider.models / auth.usage）", () => {
  assert.equal(hooks.provider, undefined)
  assert.equal(hooks.auth.usage, undefined)
})

const auth = { type: "api", key: "index", metadata: { endpoint: "public" } }
const getAuth = async () => auth

await check("loader 未登录也能用", async () => {
  const bare = await hooks.auth.loader(async () => undefined)
  assert.equal(bare.baseURL, DEFAULT_BASE)
  assert.ok(bare.apiKey)
  assert.equal(typeof bare.fetch, "function")
})

await check("dynamicModels=true 时才注册动态模型与 usage 钩子", async () => {
  const dynamic = await IndexTranslateAuth(input, { dynamicModels: true })
  assert.equal(typeof dynamic.provider.models, "function")
  assert.equal(typeof dynamic.auth.usage, "function")
  const models = await dynamic.provider.models(cfg.provider[PROVIDER], { auth })
  const ids = Object.keys(models)
  assert.ok(ids.length >= 7, `只拿到 ${ids.length} 个模型`)
  assert.ok(ids.includes(DEFAULT_MODEL))
  assert.ok(!ids.some(isSpeechModel))
  assert.equal(models[DEFAULT_MODEL].free, true)
  assert.notEqual(models[DEFAULT_MODEL].tool_call, false)
  const usage = await dynamic.auth.usage(getAuth)
  assert.ok(usage.plan)
  assert.ok(!usage.error, usage.error)
})

const loaded = await hooks.auth.loader(getAuth)
assert.ok(loaded.fetch, "loader 没有返回 fetch")
assert.equal(loaded.baseURL, DEFAULT_BASE)

const post = (payload) =>
  loaded.fetch(`${DEFAULT_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.key}`,
    },
    body: JSON.stringify(payload),
  })

await check("真实翻译请求：模拟 agent 的 system + tools + 超大 max_tokens", async () => {
  const res = await post({
    model: DEFAULT_MODEL,
    stream: false,
    max_tokens: 32000,
    temperature: 0,
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    tool_choice: "auto",
    messages: [
      { role: "system", content: "You are Claude Code, an AI coding assistant. Always use tools." },
      { role: "user", content: "请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n欢迎使用 Index-Translate。" },
    ],
  })
  const text = await res.text()
  assert.equal(res.status, 200, `HTTP ${res.status}: ${text.slice(0, 400)}`)
  const data = JSON.parse(text)
  const content = data.choices?.[0]?.message?.content || ""
  assert.ok(content.length > 0, "译文为空")
  assert.ok(!content.includes("<think>"), "译文里残留 <think>")
  console.log(`        译文：${content.slice(0, 120)}`)
})

await check("图片翻译（35B 视觉能力）", async () => {
  const res = await post({
    model: DEFAULT_MODEL,
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Translate the text in the image into Chinese." },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            },
          },
        ],
      },
    ],
  })
  const text = await res.text()
  assert.equal(res.status, 200, `HTTP ${res.status}: ${text.slice(0, 400)}`)
  assert.ok((JSON.parse(text).choices?.[0]?.message?.content || "").length > 0)
})

await check("流式 SSE 原样透传", async () => {
  const res = await post({
    model: DEFAULT_MODEL,
    stream: true,
    max_tokens: 64,
    messages: [
      { role: "user", content: "请将以下文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n你好，世界。" },
    ],
  })
  assert.equal(res.status, 200, `HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    for (let i = 0; i < 8 && buf.length < 2000; i++) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  assert.match(buf, /chat\.completion\.chunk/)
  assert.match(buf, /data: /)
})

console.log("─".repeat(56))
console.log(`${passed} 项通过，${failed} 项失败`)
if (failed) {
  console.error("\n自检未通过。若全部是网络类失败，请检查代理设置后重试。")
  process.exit(1)
}
console.log("插件逻辑与官方接口均可用。接下来执行：magpie plugin add <本文件夹绝对路径>\n")
process.exit(0)
