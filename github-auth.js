const TOKEN_KEY = 'futurecontext.github-token';
export const GITHUB_FETCH_LOG_KEY = 'futurecontext.github-fetch-log';
export const GITHUB_FETCH_LOG_LIMIT = 20;

export async function githubToken(storage = chrome.storage.local) {
  const stored = await storage.get(TOKEN_KEY);
  return typeof stored[TOKEN_KEY] === 'string' ? stored[TOKEN_KEY] : '';
}

export async function restrictLocalStorage(storage = chrome.storage.local) {
  await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function saveGitHubToken(value, storage = chrome.storage.local) {
  const token = String(value ?? '').trim();
  if (token && (!/^[A-Za-z0-9_]+$/.test(token) || token.length > 512)) {
    throw new Error('Token 格式不正确，请粘贴完整 Token，不要包含空格或 Bearer 前缀。');
  }
  if (!token) { await storage.remove(TOKEN_KEY); return; }
  // Content scripts do not need storage access; they use background messages.
  // Fail closed if the browser cannot restrict access to extension contexts.
  await restrictLocalStorage(storage);
  await storage.set({ [TOKEN_KEY]: token });
}

export function redactGitHubHeaders(headers = {}) {
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === 'authorization') next[key] = '[redacted]';
  }
  return next;
}

export function formatGitHubFetchLogLine({ authenticated, status, limit, remaining, path }) {
  return `[futurecontext github] authenticated=${authenticated} status=${status} limit=${limit} remaining=${remaining} path=${path}`;
}

export function appendGitHubFetchLog(entries, entry) {
  return [...(Array.isArray(entries) ? entries : []), entry].slice(-GITHUB_FETCH_LOG_LIMIT);
}

function rateLimitHeader(response, name) {
  return response?.headers?.get?.(name) ?? '';
}

async function recordGitHubFetch(response, url, authenticated, storage) {
  let path = '';
  try { path = new URL(url).pathname; } catch { /* keep empty path */ }
  const entry = {
    at: Date.now(),
    authenticated: Boolean(authenticated),
    status: Number(response?.status) || 0,
    limit: rateLimitHeader(response, 'x-ratelimit-limit'),
    remaining: rateLimitHeader(response, 'x-ratelimit-remaining'),
    path
  };
  console.info(formatGitHubFetchLogLine(entry));
  try {
    const stored = await storage.get(GITHUB_FETCH_LOG_KEY);
    await storage.set({ [GITHUB_FETCH_LOG_KEY]: appendGitHubFetchLog(stored[GITHUB_FETCH_LOG_KEY], entry) });
  } catch { /* Debug log must never break GitHub requests. */ }
}

export async function githubFetch(fetchImpl = fetch, storage = chrome.storage.local) {
  const token = await githubToken(storage);
  const authenticated = Boolean(token);
  const request = (url, options = {}) => {
    if (new URL(url).origin !== 'https://api.github.com') throw new Error('拒绝向非 GitHub API 地址发送请求。');
    return Promise.resolve(fetchImpl(url, {
      ...options,
      redirect: 'error',
      headers: { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    })).then(async (response) => {
      await recordGitHubFetch(response, url, authenticated, storage);
      return response;
    });
  };
  request.hasToken = authenticated;
  return request;
}
