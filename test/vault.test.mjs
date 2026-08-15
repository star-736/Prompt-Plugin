import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { createVault, sealVault, unlockVault } from '../vault.js';

test('a vault encrypts prompt text and unlocks with the correct password', async () => {
  const { vault, key } = await createVault('a long unique test passphrase', webcrypto);
  const sealed = await sealVault({ prompts: [{ id: '1', title: 'secret title', body: 'secret prompt body', tags: ['image'] }] }, key, vault, webcrypto);
  const serialized = JSON.stringify(sealed);
  assert.equal(serialized.includes('secret title'), false);
  assert.equal(serialized.includes('secret prompt body'), false);
  const unlocked = await unlockVault(sealed, 'a long unique test passphrase', webcrypto);
  assert.equal(unlocked.data.prompts[0].body, 'secret prompt body');
});

test('a wrong password cannot decrypt a vault', async () => {
  const { vault } = await createVault('a long unique test passphrase', webcrypto);
  await assert.rejects(() => unlockVault(vault, 'wrong password', webcrypto));
});
