export const PROVIDER_PRESETS = Object.freeze({
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4.1-mini' },
  opencode_go: { label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', modelHint: 'kimi-k3' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelHint: 'openai/gpt-4.1-mini' },
  custom: { label: 'OpenAI 兼容', baseUrl: '', modelHint: 'your-model-id' }
});

function safeJson(value) {
  const text = String(value ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const matched = text.match(/\{[\s\S]*\}/);
  if (!matched) throw new Error('模型没有返回可识别的 JSON。');
  return JSON.parse(matched[0]);
}

export function normalizeProvider(input) {
  const kind = PROVIDER_PRESETS[input?.kind] ? input.kind : 'custom';
  const baseUrl = String(input?.baseUrl || PROVIDER_PRESETS[kind].baseUrl).replace(/\/+$/, '');
  const model = String(input?.model ?? '').trim();
  if (!baseUrl.startsWith('https://')) throw new Error('Provider Base URL 必须是 HTTPS 地址。');
  if (!model) throw new Error('请输入 Model ID。');
  return { id: input.id ?? globalThis.crypto?.randomUUID?.() ?? `provider-${Date.now()}`, kind, label: String(input?.label ?? PROVIDER_PRESETS[kind].label).trim() || PROVIDER_PRESETS[kind].label, baseUrl, model, secret: input.secret ?? null, createdAt: input.createdAt ?? Date.now() };
}

export function providerOrigin(provider) { return new URL(provider.baseUrl).origin; }

export function buildAssetOrganizationPrompt(asset, categories) {
  const allowed = categories.map((category) => category.name);
  return [
    '你是 FutureContext 的本地资料库整理助手。只返回一个 JSON 对象，不要 Markdown。',
    '任务：为可复用的通用 Prompt 生成一个简短中文标题（仅当 needsTitle 为 true），并仅从 allowedCategories 中选一个最合适的已有分类；不合适就返回 null。',
    '不得编造用户内容，不得创建分类。',
    `输入：${JSON.stringify({ assetType: asset.type, content: asset.content, needsTitle: asset.type === 'generic' && !asset.title, allowedCategories: allowed })}`,
    '输出格式：{"title": string|null, "categoryName": string|null}'
  ].join('\n');
}

export function buildGroupingPrompt(scope, assets) {
  return [
    '你是 FutureContext 的分类助手。只返回一个 JSON 对象，不要 Markdown。',
    `将以下未分类 ${scope === 'generic' ? '通用 Prompt' : 'Skill'} 分成少量、明确、可复用的中文分类。每个 assetId 必须至多出现一次。`,
    '输出格式：{"groups":[{"name":"分类名","assetIds":["id"]}]}。不要附带解释。',
    JSON.stringify(assets.map((asset) => ({ id: asset.id, title: asset.title, content: asset.content.slice(0, 4000) })))
  ].join('\n');
}

export function buildStructurePrompt(scope, categories, assets) {
  return [
    '你是 FutureContext 的分类结构顾问。只返回 JSON，不要 Markdown。',
    `评估下列 ${scope} 分类是否值得合并、重命名或拆分。不要直接执行。若无明确收益，返回 {"proposal":null}。`,
    '输出格式：{"proposal":{"summary":"一句话建议","groups":[{"from":["旧分类"],"to":"新分类"}]}} 或 {"proposal":null}',
    JSON.stringify({ categories: categories.map((category) => ({ name: category.name, assetIds: assets.filter((asset) => asset.categoryId === category.id).map((asset) => asset.id) })) })
  ].join('\n');
}

export async function chatCompletion(provider, apiKey, prompt, fetchImpl = fetch) {
  const endpoint = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payload = { model: provider.model, messages: [{ role: 'system', content: 'Return valid JSON only.' }, { role: 'user', content: prompt }], temperature: 0.2, response_format: { type: 'json_object' } };
  let response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(payload) });
  if (response.status === 400 || response.status === 422) {
    const { response_format, ...fallback } = payload;
    response = await fetchImpl(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(fallback) });
  }
  if (!response.ok) throw new Error(`Provider 请求失败（${response.status}）。`);
  const responsePayload = await response.json();
  const content = responsePayload?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Provider 未返回可用内容。');
  return safeJson(content);
}

export function parseAssetResult(value) {
  const result = typeof value === 'string' ? safeJson(value) : value;
  return { title: typeof result?.title === 'string' ? result.title : null, categoryName: typeof result?.categoryName === 'string' ? result.categoryName : null };
}

export function parseGroups(value, eligibleIds) {
  const ids = new Set(eligibleIds);
  const used = new Set();
  return (value?.groups ?? []).map((group) => ({ name: String(group?.name ?? '').trim(), assetIds: (group?.assetIds ?? []).filter((id) => ids.has(id) && !used.has(id) && (used.add(id) || true)) })).filter((group) => group.name && group.assetIds.length);
}
