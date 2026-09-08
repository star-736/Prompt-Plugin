// 就地取用的站点配置：只有用户明确启用的站点才会加载取用面板。
export const SITE_PRESETS = Object.freeze([
  { label: 'ChatGPT', origin: 'https://chatgpt.com' },
  { label: 'Claude', origin: 'https://claude.ai' },
  { label: 'Gemini', origin: 'https://gemini.google.com' },
  { label: 'DeepSeek', origin: 'https://chat.deepseek.com' },
  { label: 'Kimi', origin: 'https://www.kimi.com' },
  { label: '通义', origin: 'https://www.tongyi.com' },
  { label: '豆包', origin: 'https://www.doubao.com' },
  { label: 'Perplexity', origin: 'https://www.perplexity.ai' },
  { label: 'Grok', origin: 'https://grok.com' },
  { label: 'Copilot', origin: 'https://copilot.microsoft.com' }
]);

export const PALETTE_SCRIPT_ID = 'futurecontext-palette';
export const PALETTE_SCRIPT_FILE = 'content-palette.js';
export const SHORTCUT_LABEL = 'Alt+Shift+P';

export function normalizeSiteOrigin(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('请输入网站域名。');
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw new Error('这不是有效的网站地址。'); }
  if (url.protocol !== 'https:') throw new Error('就地取用只支持 HTTPS 网站。');
  if (!url.hostname || !url.hostname.includes('.') && url.hostname !== 'localhost') throw new Error('这不是有效的网站域名。');
  return url.origin;
}

export function sitePattern(origin) { return `${origin}/*`; }
export function siteHost(origin) { try { return new URL(origin).host; } catch { return origin; } }
export function originOfUrl(url) { try { const parsed = new URL(url); return parsed.protocol === 'https:' ? parsed.origin : null; } catch { return null; } }
export function presetFor(origin) { return SITE_PRESETS.find((preset) => preset.origin === origin) ?? null; }
