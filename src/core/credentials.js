import { clone, newId, normalizedName, normalizeAi, normalizeDatabase } from './model.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
function base64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}
function fromBase64(value) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'));
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function randomBytes(length, cryptoApi = globalThis.crypto) { const value = new Uint8Array(length); cryptoApi.getRandomValues(value); return value; }

export async function digestPassword(password, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw new Error('浏览器不支持密码校验所需的加密能力。');
  const digest = await cryptoApi.subtle.digest('SHA-256', encoder.encode(password));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function setPrivacyPassword(database, password, cryptoApi = globalThis.crypto) {
  if (String(password).length < 6) throw new Error('密码至少需要 6 位。');
  const next = normalizeDatabase(clone(database));
  next.lock.passwordDigest = await digestPassword(password, cryptoApi);
  next.ai = normalizeAi({ ...next.ai, providers: [], activeProviderId: null, queue: [], status: { state: 'idle', message: '' } });
  return next;
}
export function hasPrivacyLock(database) { return Boolean(database.lock?.passwordDigest); }
export async function verifyPrivacyPassword(database, password, cryptoApi = globalThis.crypto) { return hasPrivacyLock(database) && (await digestPassword(password, cryptoApi)) === database.lock.passwordDigest; }

async function encryptionKey(password, salt, cryptoApi = globalThis.crypto) {
  const material = await cryptoApi.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return cryptoApi.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptProviderKey(password, apiKey, cryptoApi = globalThis.crypto) {
  if (!String(apiKey ?? '').trim()) throw new Error('请输入 API Key。');
  const salt = randomBytes(16, cryptoApi); const iv = randomBytes(12, cryptoApi);
  const key = await encryptionKey(password, salt, cryptoApi);
  const cipher = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(apiKey));
  return { algorithm: 'AES-GCM/PBKDF2-SHA-256', salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(cipher)) };
}
export async function decryptProviderKey(password, secret, cryptoApi = globalThis.crypto) {
  if (!secret?.salt || !secret?.iv || !secret?.ciphertext) throw new Error('找不到加密的 API Key。');
  try {
    const key = await encryptionKey(password, fromBase64(secret.salt), cryptoApi);
    const plain = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(secret.iv) }, key, fromBase64(secret.ciphertext));
    return decoder.decode(plain);
  } catch { throw new Error('无法解锁 API Key，请检查隐私锁密码。'); }
}
export async function saveProviderConfig(database, providerInput, password, cryptoApi = globalThis.crypto) {
  if (!await verifyPrivacyPassword(database, password, cryptoApi)) throw new Error('隐私锁密码不正确。');
  const next = normalizeDatabase(clone(database));
  const input = { ...providerInput };
  if (!input.id) input.id = newId();
  if (!String(input.baseUrl ?? '').startsWith('https://')) throw new Error('Provider Base URL 必须是 HTTPS 地址。');
  if (!String(input.model ?? '').trim()) throw new Error('请输入 Model ID。');
  const existing = next.ai.providers.find((item) => item.id === input.id);
  const secret = String(input.apiKey ?? '').trim() ? await encryptProviderKey(password, input.apiKey, cryptoApi) : (input.secret ?? existing?.secret);
  if (!secret) throw new Error('请输入 API Key。');
  const provider = { id: input.id, kind: input.kind ?? 'custom', label: normalizedName(input.label) || 'Provider', baseUrl: String(input.baseUrl).replace(/\/+$/, ''), model: String(input.model).trim(), secret, createdAt: input.createdAt ?? Date.now(), updatedAt: Date.now() };
  const index = next.ai.providers.findIndex((item) => item.id === provider.id);
  if (index >= 0) next.ai.providers[index] = provider; else next.ai.providers.push(provider);
  if (!next.ai.activeProviderId) next.ai.activeProviderId = provider.id;
  return { database: next, provider: { ...provider, secret: undefined } };
}
export function removeProviderConfig(database, id) { const next = normalizeDatabase(clone(database)); next.ai.providers = next.ai.providers.filter((provider) => provider.id !== id); if (next.ai.activeProviderId === id) next.ai.activeProviderId = next.ai.providers[0]?.id ?? null; return next; }
export function activeProvider(database) { const next = normalizeDatabase(database); return next.ai.providers.find((provider) => provider.id === next.ai.activeProviderId) ?? null; }
