const VAULT_KEY = 'prompt-vault.v1';
const ITERATIONS = 310_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function base64ToBytes(text) {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

export async function deriveKey(password, salt, cryptoApi = globalThis.crypto) {
  const material = await cryptoApi.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return cryptoApi.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encrypt(value, key, cryptoApi = globalThis.crypto) {
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const encrypted = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

async function decrypt(payload, key, cryptoApi = globalThis.crypto) {
  const plaintext = await cryptoApi.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.ciphertext)
  );
  return JSON.parse(decoder.decode(plaintext));
}

export async function createVault(password, cryptoApi = globalThis.crypto) {
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, cryptoApi);
  const payload = await encrypt({ prompts: [] }, key, cryptoApi);
  return { vault: { version: 1, kdf: 'PBKDF2-SHA-256', iterations: ITERATIONS, salt: bytesToBase64(salt), ...payload }, key };
}

export async function unlockVault(vault, password, cryptoApi = globalThis.crypto) {
  if (!vault || vault.version !== 1 || vault.kdf !== 'PBKDF2-SHA-256') throw new Error('不支持的保险箱格式。');
  const key = await deriveKey(password, base64ToBytes(vault.salt), cryptoApi);
  const data = await decrypt(vault, key, cryptoApi);
  if (!Array.isArray(data.prompts)) throw new Error('保险箱数据无效。');
  return { key, data };
}

export async function sealVault(data, key, vault, cryptoApi = globalThis.crypto) {
  const payload = await encrypt(data, key, cryptoApi);
  return { ...vault, ...payload };
}

export async function loadStoredVault(storage = chrome.storage.local) {
  const result = await storage.get(VAULT_KEY);
  return result[VAULT_KEY] ?? null;
}

export async function saveStoredVault(vault, storage = chrome.storage.local) {
  await storage.set({ [VAULT_KEY]: vault });
}

