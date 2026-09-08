// 就地取用的站点配置：只有用户明确启用的站点才会加载取用面板。
export const SITE_PRESETS = Object.freeze([
  { label: 'ChatGPT', origin: 'https://chatgpt.com' },
  { label: 'Claude', origin: 'https://claude.ai' },
  { label: 'Gemini', origin: 'https://gemini.google.com' },
  { label: 'DeepSeek', origin: 'https://chat.deepseek.com' },
  { label: 'Kimi', origin: 'https://www.kimi.com' },
  { label: 'Grok', origin: 'https://grok.com' }
]);

export const PALETTE_SCRIPT_ID = 'futurecontext-palette';
export const PALETTE_SCRIPT_FILE = 'content-palette.js';
export const SHORTCUT_LABEL = 'Alt+Shift+F';

/** 整域算同一产品的根域名；不含 google.com / microsoft.com。 */
const PROMPTABLE_ROOTS = Object.freeze(['chatgpt.com', 'claude.ai', 'deepseek.com', 'kimi.com', 'grok.com']);
/** 必须用完整主机名匹配，不能放到父公司根域。 */
const PROMPTABLE_HOSTS = Object.freeze(['gemini.google.com']);
/** ChatGPT 旧聊天域，单独列出以免放开整个 openai.com。 */
const PROMPTABLE_EXTRA_HOSTS = Object.freeze(['chat.openai.com']);

/** 光标前文本以 // 结尾则触发；只有紧跟在 : 后面的 //（URL 协议）才忽略，行首 // 不受影响。 */
export function shouldTrigger(before) {
  const text = String(before ?? '');
  if (!text.endsWith('//')) return false;
  if (text.endsWith('://')) return false;
  if (text.endsWith('///')) return false;
  return true;
}

/** 再输入一个 `/` 就会凑成触发符 `//`，且不是 URL 协议的一部分。 */
export function slashCompletesTrigger(before) {
  const text = String(before ?? '');
  if (!text.endsWith('/')) return false;
  if (text.endsWith('//')) return false;
  if (text.endsWith(':/')) return false;
  return true;
}

/** inline 面板关闭前用来确认锚点仍在的等待；过短会闪退，过长会拖住删除 `//` 后的关闭。 */
export const INLINE_DISMISS_MS = 80;

/**
 * inline 模式当前搜索词。
 * - 字符串（可为空）：锚点仍是 `//`
 * - false：锚点已失效，可在 debounce 后关闭
 * - null：暂时读不到光标，不能当成失效
 */
export function inlineAnchorQuery(before, pos, anchorOffset, caretUnknown = false) {
  if (caretUnknown) return null;
  if (!Number.isFinite(pos) || pos < anchorOffset + 2) return false;
  const text = String(before ?? '');
  if (text.slice(anchorOffset, anchorOffset + 2) !== '//') return false;
  const query = text.slice(anchorOffset + 2, pos);
  if (query.includes('\n')) return false;
  return query;
}

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

function hostnameOf(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : '';
  } catch {
    return '';
  }
}

function hostMatches(host, base) {
  return host === base || host.endsWith(`.${base}`);
}

function unique(items) {
  return [...new Set(items)];
}

/** 弹窗顶部启用条：仅常见 AI 站点及其同品牌兄弟域，不对任意 https 页显示。 */
export function isPromptableSite(origin) {
  const host = hostnameOf(origin);
  if (!host) return false;
  if (PROMPTABLE_HOSTS.some((base) => hostMatches(host, base))) return true;
  if (PROMPTABLE_EXTRA_HOSTS.some((base) => hostMatches(host, base))) return true;
  if (PROMPTABLE_ROOTS.some((root) => hostMatches(host, root))) return true;
  return SITE_PRESETS.some((preset) => preset.origin === origin);
}

/** 启用某站时一并请求的 match pattern：DeepSeek 覆盖 *.deepseek.com，避免 iframe / 兄弟域漏权。 */
export function relatedMatchPatterns(origin) {
  const host = hostnameOf(origin);
  if (!host) return origin ? [sitePattern(origin)] : [];
  if (hostMatches(host, 'gemini.google.com')) return ['https://gemini.google.com/*', 'https://*.gemini.google.com/*'];
  if (hostMatches(host, 'chatgpt.com') || hostMatches(host, 'chat.openai.com')) {
    return ['https://chatgpt.com/*', 'https://*.chatgpt.com/*', 'https://chat.openai.com/*'];
  }
  const root = PROMPTABLE_ROOTS.find((item) => hostMatches(host, item));
  if (root) return [`https://${root}/*`, `https://*.${root}/*`];
  return [sitePattern(origin)];
}

export function originCoveredBySites(origin, sites) {
  const list = Array.isArray(sites) ? sites : [];
  if (!origin) return false;
  if (list.includes(origin)) return true;
  const granted = new Set(list.flatMap((site) => relatedMatchPatterns(site)));
  return relatedMatchPatterns(origin).some((pattern) => granted.has(pattern));
}

export function patternsForSites(sites) {
  return unique((Array.isArray(sites) ? sites : []).flatMap((origin) => relatedMatchPatterns(origin)));
}

export const DEFAULT_PALETTE_TYPES = Object.freeze(['generic', 'skill']);
export const PALETTE_TYPES_AIGC_ONLY = Object.freeze(['aigc']);

/**
 * 取用面板按页面 URL 切换资产类型。默认只有 generic + skill；
 * 匹配 host（含子域 / www）且 pathname 为 pathPrefix 或其子路径时，改用该规则的 types。
 * 之后加「某站的绘画页」只需再加一条，不改匹配逻辑。
 */
export const PALETTE_TYPE_RULES = Object.freeze([
  { hosts: Object.freeze(['grok.com']), pathPrefix: '/imagine', types: PALETTE_TYPES_AIGC_ONLY }
]);

function pathHasPrefix(pathname, prefix) {
  const path = String(pathname || '');
  const base = prefix.endsWith('/') && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
  if (!base) return true;
  return path === base || path === `${base}/` || path.startsWith(`${base}/`);
}

/** 当前页可出现在取用面板的普通库类型。私密库过滤在 paletteAssets，不在这里。 */
export function paletteTypesForUrl(url) {
  try {
    const parsed = new URL(String(url ?? ''));
    if (parsed.protocol !== 'https:') return [...DEFAULT_PALETTE_TYPES];
    const host = parsed.hostname.toLowerCase();
    for (const rule of PALETTE_TYPE_RULES) {
      if (!rule.hosts.some((base) => hostMatches(host, base))) continue;
      if (!pathHasPrefix(parsed.pathname, rule.pathPrefix)) continue;
      return [...rule.types];
    }
  } catch { /* 无效 URL 用默认。 */ }
  return [...DEFAULT_PALETTE_TYPES];
}
