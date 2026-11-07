# Index-Translate 提示词速查

整理自官方 [`docs/prompts.md`](https://github.com/bilibili/Index-Translate/blob/main/docs/prompts.md) 与 [`inference/llm/call_api.py`](https://github.com/bilibili/Index-Translate/blob/main/inference/llm/call_api.py)。所有模板都要求「只输出译文，不解释」。

把下面任意一段作为**用户消息**发给 `index-translate/<模型>` 即可。目标语言建议写全称（`英语` / `中文` / `日语`），别只写 `en`。

---

## 1. 默认翻译

```
请将以下文本翻译为{target_lang}，直接输出翻译结果，不要进行任何解释：

{source_text}
```

英文版：

```
Translate the following text into {target_lang}. Output the translation directly, without any explanation:

{source_text}
```

---

## 2. instTrans 结构化模板（术语 / 格式 / 风格约束）

需要强制术语、保留格式、锁定不可译内容、调整语气时使用，遵循 instTrans benchmark 的槽位写法，命中率最高。

```
请将以下{源语言}{文体}翻译成{target_lang}，并且严格遵循所有约束要求。

【源文】
{source_text}

【约束要求】
1. 【硬性要求】...
2. 【硬性要求】...
3. 【注意】...

只输出译文，不要有任何额外说明。
```

`{源语言}` 可省略（自动识别），`{文体}` 不写时用 `文本`。

英文版对应 `[Source]` / `[Constraints]` / `[Hard Constraint]` / `[Note]`。

### 约束指令速查

| 场景 | 写法 |
| --- | --- |
| 术语表 | `1. 【硬性要求】专名/术语对照: 碳纤维→carbon fiber、抗裂缝→crack resistance` |
| 不可译片段锁定 | `1. 【硬性要求】专名/术语对照: 我喜欢→我喜欢`（恒等映射，比"不要翻译"的自然语言指令可靠得多） |
| HTML 保留 | `1. 【硬性要求】保留源文中的 HTML 格式标记不变` |
| 代码 / 标签保护 | `2. 【硬性要求】<code> 标签内与反引号内的内容保持原样，不翻译` |
| 占位符 / 变量 | `1. 【硬性要求】保留占位符 {v0}、{user_name}、%s 不变` |
| 结构化数据 | `1. 【硬性要求】保留合法 JSON 语法与 key，只翻译 value` |
| 语气 / 风格 | `3. 【注意】调整为严谨、正式、礼貌的商务公文风格` |
| 领域消歧 | `3. 【注意】语境为工业制造领域，plant 译为「工厂」而非「植物」` |
| 社交元素 | `1. 【硬性要求】保持 @用户名、#话题#、表情符号原样` |

硬性要求是二值判定（违反一条即整句不合格），软性要求（`【注意】`）是程度判定，别把必须严格生效的规则写进 `【注意】`。

### 完整例子：JSON + 话题标签

```
请将以下文本翻译成英语，并且严格遵循所有约束要求。

【源文】
{"title": "⭐2月13日例行维护公告⭐", "content": "#热血航线大和登场#"}

【约束要求】
1. 【硬性要求】保留源文中的 JSON 格式标记与 key 不变，只翻译 value
2. 【硬性要求】保持社交平台话题标签 #热血航线大和登场# 原样

只输出译文，不要有任何额外说明。
```

### 不可译片段：工业级做法（推荐）

模型对 HTML 有「保留标签、翻译内部文字」的强先验，纯靠自然语言很难压住。生产环境建议前后处理：

1. 预处理：把 `<span translate="no">…</span>` 替换成 `{v0}`、`{v1}`…
2. 翻译：`1. 【硬性要求】保留占位符 {v0} 不变`
3. 后处理：把 `{v0}` 还原成原始 HTML 片段

---

## 3. 结构化数据（简版）

```
将下方 {format_type} 数据翻译为{target_lang}：仅翻译面向用户的文本字段，严禁改动结构、键名与占位符：

{source_text}
```

---

## 4. 图片翻译（仅 35B-A3B）

按 OpenAI 视觉格式把图片作为 `content` 数组的一项传入，指令写目标语言即可，无需 OCR：

```json
{
  "model": "Index-Translate-35B-A3B",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "把图片中的英文翻译成中文，保持原有排版语义，只输出译文。" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,<...>" } }
    ]
  }]
}
```

2B / 9B 的公开接口未标注视觉能力，图片请用 35B。

---

## 5. 音节数控制（Index-Homura）

用于配音台词对齐时间轴，把音节数写进指令：

```
请将以下文本翻译为{target_lang}，译文严格控制在 {N} 个音节。直接输出翻译结果，不要进行任何解释：

{source_text}
```

示例：`生活两天，是一种什么体验` + 目标 10 音节 → `to live for two days. What would that be like?`

音节控制是近似的，口语时长还取决于语速。Homura 解码推荐 `temperature=0.3`（官方默认）。

---

## 6. 长文档（Index-Nailong）

把完整文档直接作为一条用户消息发给 `Index-Nailong-9B` / `Index-Nailong-2B`，模型会一次生成完整译文，重点保证人名、称谓跨段落一致：

```
请将以下中文小说完整翻译为英语，保持人物姓名与称谓在全篇一致，保留段落结构，直接输出完整译文，不要进行任何解释：

{全文}
```

官方固定方向模板见仓库 `inference/llm/prompts`。在 magpie 里跑长文档时记得放大输出上限：

```powershell
magpie plugin options index-translate '{"maxTokens":16384}'
```

---

## 7. 语言写法对照（部分）

`英语` `中文` `日语` `韩语` `德语` `法语` `西班牙语` `葡萄牙语` `俄语` `阿拉伯语` `意大利语` `荷兰语` `波兰语` `罗马尼亚语` `瑞典语` `土耳其语` `印地语` `越南语` `泰语` `印尼语` `马来语` `菲律宾语` `乌克兰语` `波斯语` `捷克语` `希腊语` `丹麦语` `匈牙利语` `芬兰语` `书面挪威语` `斯洛伐克语` `保加利亚语`

主模型覆盖 150 种语言，写目标语言的常见中文全称即可。
