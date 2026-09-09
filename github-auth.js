const TOKEN_KEY = 'futurecontext.github-token';

export async function githubToken(storage = chrome.storage.local) {
  const stored = await storage.get(TOKEN_KEY);
  return typeof stored[TOKEN_KEY] === 'string' ? stored[TOKEN_KEY] : '';
}

export async function saveGitHubToken(value, storage = chrome.storage.local) {
  const token = String(value ?? '').trim();
  if (token && (!/^[A-Za-z0-9_]+$/.test(token) || token.length > 512)) {
    throw new Error('Token 格式不正确，请粘贴完整 Token，不要包含空格或 Bearer 前缀。');
  }
  if (!token) { await storage.remove(TOKEN_KEY); return; }
  // Content scripts do not need storage access; they use background messages.
  // Fail closed if the browser cannot restrict access to extension contexts.
  await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await storage.set({ [TOKEN_KEY]: token });
}

export async function githubFetch(fetchImpl = fetch, storage = chrome.storage.local) {
  const token = await githubToken(storage);
  return (url, options = {}) => {
    if (new URL(url).origin !== 'https://api.github.com') throw new Error('拒绝向非 GitHub API 地址发送请求。');
    return fetchImpl(url, {
      ...options,
      redirect: 'error',
      headers: { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    });
  };
}
