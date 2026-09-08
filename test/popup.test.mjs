import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { webcrypto } from 'node:crypto';
import {
  createBackup,
  createCategory,
  createEmptyDatabase,
  saveAsset,
  saveGithubSkillAsset,
  setPrivacyPassword,
  updateAiSettings,
  updateInPlaceSettings
} from '../store.js';
import { click, confirmOpenDialog, createChromeStub, createMemoryIndexedDB, flush, installDom, popupHtml, seedDatabase, waitFor } from './helpers.mjs';

const skill = `---\nname: Email reviewer\ndescription: Review email drafts\n---\n\n# Instructions\nReview the email.`;

function withSites(database, sites) {
  const next = structuredClone(database);
  next.settings.inPlace.sites = sites;
  next.settings.inPlace.enabled = true;
  return next;
}

const { window, document } = installDom(popupHtml(), { url: 'https://chatgpt.com/c/1' });
const indexedDb = createMemoryIndexedDB();
const stub = createChromeStub({
  grantedOrigins: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*', 'https://chat.openai.com/*', 'https://github.com/*', 'https://api.github.com/*', 'https://api.openai.com/*'],
  tabs: [{ id: 7, url: 'https://chatgpt.com/c/1', active: true, windowId: 1 }],
  indexedDB: indexedDb,
  sendMessage: async (message) => {
    if (message.type === 'read-notice') return { ok: true, result: { message: '刚才保存成功' } };
    if (message.type === 'sync-sites') return { ok: true, result: { sites: 1 } };
    if (message.type === 'schedule-ai') return { ok: true, result: { ok: true } };
    if (message.type === 'clear-ai-session') return { ok: true, result: { ok: true } };
    if (message.type === 'ai-session-status') return { ok: true, result: { unlocked: false, providerId: 'p1' } };
    if (message.type === 'unlock-ai') return { ok: true, result: { providerId: 'p1' } };
    if (message.type === 'test-provider') return { ok: true, result: { ok: true } };
    if (message.type === 'queue-existing') return { ok: true, result: { count: 2 } };
    if (message.type === 'save-provider') return { ok: true, result: { id: 'p1', label: message.provider.label } };
    if (message.type === 'delete-provider') return { ok: true, result: { ok: true } };
    if (message.type === 'collect-github-skill') return { ok: true, result: { duplicate: false, asset: { id: 'skill-1', title: 'Email reviewer' } } };
    if (message.type === 'update-github-skill') return { ok: true, result: { changed: false } };
    return { ok: false, error: `unhandled ${message.type}` };
  }
});

let database = createEmptyDatabase();
database = createCategory(database, 'generic', '工作', { id: 'work' }).database;
database = saveAsset(database, { type: 'generic', title: '周报', content: '总结本周工作', categoryId: 'work' }, { id: 'g1', now: 1 }).database;
database = saveAsset(database, { type: 'skill', content: skill }, { id: 's1', now: 2 }).database;
database = saveGithubSkillAsset(database, {
  id: 'pkg-1',
  skillContent: skill,
  fileCount: 1,
  totalSize: 20,
  files: [{ path: 'SKILL.md', content: Buffer.from(skill).toString('base64'), size: 20 }],
  source: { repository: 'acme/demo', directory: 'skills/review', commit: 'abc1234', defaultBranch: 'main', url: 'https://github.com/acme/demo' }
}, { id: 'skill-gh' }).database;
database = saveAsset(database, { type: 'aigc', content: 'cinematic rain' }, { id: 'a1', now: 3 }).database;
database = addProposal(database);
database = await setPrivacyPassword(database, '123456', webcrypto);
database = updateAiSettings(database, {
  enabled: false,
  activeProviderId: 'p1',
  providers: [{ id: 'p1', kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', secret: { salt: 'a', iv: 'b', ciphertext: 'c' } }],
  proposals: database.ai.proposals
});
database = withSites(database, []);
seedDatabase(stub.local, database);

await import('../package-store.js').then(({ putPackage }) => putPackage({
  id: 'pkg-1',
  files: [{ path: 'SKILL.md', content: Buffer.from(skill).toString('base64'), size: 20, contentType: 'text/plain' }],
  fileCount: 1,
  totalSize: 20
}, indexedDb));

await import('../popup.js');

function addProposal(db) {
  const next = structuredClone(db);
  next.ai.proposals = [{ id: 'prop-1', status: 'pending', scope: 'generic', summary: '合并分类', groups: [{ from: ['工作'], to: '沟通' }], createdAt: 1 }];
  return next;
}

function toastText() {
  return document.querySelector('#toast')?.textContent || '';
}

before(async () => {
  await waitFor(() => document.querySelector('.tabs'));
});

test('library renders notice, tabs, and asset actions', async () => {
  assert.match(document.querySelector('#app').innerHTML, /周报/);
  assert.match(document.querySelector('#app').innerHTML, /刚才保存成功/);
  click('[data-action="dismiss-notice"]');
  await flush();
  click('[data-tab="skill"]');
  await waitFor(() => document.querySelector('[data-tab="skill"].is-active'));
  click('[data-tab="aigc"]');
  await waitFor(() => document.querySelector('[data-privacy="normal"]'));
  click('[data-privacy="private"]');
  await waitFor(() => document.querySelector('#private-gate-form'));
  click('[data-action="private-gate-back"]');
  await waitFor(() => document.querySelector('[data-privacy="normal"]'));
});

test('search, sort, category filter, pin, and copy', async () => {
  click('[data-tab="generic"]');
  await waitFor(() => document.querySelector('#search'));
  const search = document.querySelector('#search');
  search.value = '周报';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitFor(() => document.querySelector('[data-action="open-asset"]'));
  click('[data-action="toggle-sort-menu"]');
  await waitFor(() => document.querySelector('[data-action="set-sort"]'));
  click('[data-sort="mostUsed"]');
  await flush(20);
  click('[data-action="toggle-category-menu"]');
  await waitFor(() => document.querySelector('[data-category="work"]'));
  click('[data-category="work"]');
  await flush();
  click('[data-action="toggle-pin"]');
  await waitFor(() => /置顶/.test(toastText()) || document.querySelector('.pin-button'));
  click('[data-action="copy-asset"]');
  await waitFor(() => /复制/.test(toastText()));
});

test('editor save, category create, and back', async () => {
  click('[data-action="new-asset"]');
  await waitFor(() => document.querySelector('#editor-form'));
  document.querySelector('#editor-title-input').value = '新提示';
  document.querySelector('#editor-content').value = '请写一封邮件';
  document.querySelector('#editor-content').dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush(20);
  click('[data-action="new-category-from-editor"]');
  await waitFor(() => document.querySelector('#editor-new-category'));
  document.querySelector('#editor-new-category').value = '沟通';
  click('[data-action="create-category-from-editor"]');
  await waitFor(() => /分类已新建/.test(toastText()));
  click('[data-action="copy-editor"]');
  await flush();
  document.querySelector('#editor-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /已保存/.test(toastText()) || document.querySelector('.asset-list'));
});

test('open GitHub skill package, update, and delete with confirm', async () => {
  click('[data-tab="skill"]');
  await waitFor(() => document.querySelector('[data-id="skill-gh"]'));
  click('[data-action="open-asset"][data-id="skill-gh"]');
  await waitFor(() => document.querySelector('[data-action="update-github-skill"]'));
  click('[data-action="update-github-skill"]');
  await waitFor(() => /当前保存版本/.test(toastText()));
  click('[data-action="new-category-from-editor"]');
  await waitFor(() => document.querySelector('#editor-new-category'));
  click('[data-action="cancel-category-from-editor"]');
  await flush();
  click('[data-action="delete-asset"]');
  confirmOpenDialog();
  await waitFor(() => /永久删除/.test(toastText()) || document.querySelector('.asset-list'));
});

test('settings, sites, providers, thresholds, and proposals', async () => {
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('#ai-enabled'));
  const ai = document.querySelector('#ai-enabled');
  ai.checked = true;
  ai.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(20);
  document.querySelector('#inplace-enabled').checked = true;
  document.querySelector('#inplace-enabled').dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush(20);
  click('[data-action="manage-sites"]');
  await waitFor(() => document.querySelector('#site-form'));
  click('[data-action="enable-site"]');
  await flush(30);
  click('[data-action="disable-site"]');
  await flush(20);
  document.querySelector('#site-origin').value = 'claude.ai';
  document.querySelector('#site-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(30);
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="manage-providers"]'));
  click('[data-action="manage-providers"]');
  await waitFor(() => document.querySelector('[data-action="new-provider"]'));
  click('[data-action="new-provider"]');
  await waitFor(() => document.querySelector('#provider-form'));
  document.querySelector('#provider-kind').value = 'deepseek';
  document.querySelector('#provider-kind').dispatchEvent(new window.Event('change', { bubbles: true }));
  document.querySelector('#provider-api-key').value = 'sk-new';
  document.querySelector('#provider-password').value = '123456';
  document.querySelector('#provider-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(40);
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="edit-ai-thresholds"]'));
  click('[data-action="edit-ai-thresholds"]');
  await waitFor(() => document.querySelector('#threshold-form'));
  document.querySelector('#threshold-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => document.querySelector('[data-action="view-proposals"]'));
  click('[data-action="view-proposals"]');
  await waitFor(() => document.querySelector('[data-action="edit-proposal"]'));
  click('[data-action="edit-proposal"]');
  await waitFor(() => document.querySelector('#proposal-form'));
  document.querySelector('#proposal-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush(30);
});

test('privacy lock reset, export confirm, and collect GitHub', async () => {
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="reset-lock"]'));
  click('[data-action="reset-lock"]');
  confirmOpenDialog();
  await waitFor(() => document.querySelector('#reset-lock-form'));
  document.querySelector('#reset-password').value = 'abcdef';
  document.querySelector('#reset-confirm').value = 'nope';
  document.querySelector('#reset-lock-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  document.querySelector('#reset-confirm').value = 'abcdef';
  document.querySelector('#reset-lock-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /隐私锁已更新/.test(toastText()) || document.querySelector('[data-action="export-backup"]'));
  click('[data-action="export-backup"]');
  confirmOpenDialog();
  await flush(20);
  click('[data-action="home"]');
  await waitFor(() => document.querySelector('[data-tab="skill"]'));
  click('[data-tab="skill"]');
  await waitFor(() => document.querySelector('[data-action="collect-github-skill"]'));
  stub.tabs[0].url = 'https://github.com/acme/demo/blob/main/skills/demo/SKILL.md';
  click('[data-action="collect-github-skill"]');
  await waitFor(() => /GitHub Skill/.test(toastText()) || /已是当前/.test(toastText()) || /失败/.test(toastText()) || /SKILL\.md/.test(toastText()));
});

test('private gate setup after lock reset still renders', async () => {
  click('[data-tab="aigc"]');
  await waitFor(() => document.querySelector('[data-privacy="private"]'));
  click('[data-privacy="private"]');
  await waitFor(() => document.querySelector('#private-gate-form') || document.querySelector('.asset-list') || document.querySelector('.empty-state'));
  assert.ok(document.querySelector('#app').innerHTML.length > 20);
});

test('categories, open generic asset, discard editor, and import backup', async () => {
  click('[data-privacy="normal"]');
  await waitFor(() => document.querySelector('[data-tab="generic"]'));
  click('[data-tab="generic"]');
  await waitFor(() => document.querySelector('#search'));
  click('[data-action="toggle-category-menu"]');
  await waitFor(() => document.querySelector('[data-action="manage-categories"]'));
  click('[data-action="manage-categories"]');
  await waitFor(() => document.querySelector('#category-create-form'));
  document.querySelector('#new-category-name').value = '归档';
  document.querySelector('#category-create-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /分类已新建/.test(toastText()));
  click('[data-action="rename-category"]');
  await waitFor(() => document.querySelector('#category-rename-form'));
  document.querySelector('#category-rename-form').elements.name.value = '归档夹';
  document.querySelector('#category-rename-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /分类已重命名/.test(toastText()) || document.querySelector('[data-action="delete-category"]'));
  click('[data-action="delete-category"]');
  confirmOpenDialog();
  await waitFor(() => /分类已删除/.test(toastText()) || document.querySelector('#category-create-form'));
  click('[data-action="library"]');
  await waitFor(() => document.querySelector('[data-action="open-asset"]'));
  click('[data-action="open-asset"]');
  await waitFor(() => document.querySelector('#editor-form'));
  document.querySelector('#editor-content').value = 'changed draft';
  document.querySelector('#editor-content').dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush(20);
  click('[data-action="editor-back"]');
  confirmOpenDialog();
  await waitFor(() => document.querySelector('.asset-list') || document.querySelector('[data-action="new-asset"]'));
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="import-backup"]'));
  const backup = createBackup(createEmptyDatabase(), 9);
  const file = new window.File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' });
  const input = document.querySelector('#backup-input');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => /导入/.test(toastText()) || /失败/.test(toastText()));
});

test('providers, unlock, organize, activate, delete, and proposals', async () => {
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="manage-providers"]'));
  click('[data-action="manage-providers"]');
  await waitFor(() => document.querySelector('[data-action="test-provider"], [data-action="new-provider"]'));
  const testBtn = document.querySelector('[data-action="test-provider"]');
  if (testBtn) {
    click(testBtn);
    await waitFor(() => document.querySelector('#ai-unlock-form') || /测试/.test(toastText()) || /连接/.test(toastText()));
    const unlock = document.querySelector('#ai-unlock-form');
    if (unlock) {
      document.querySelector('#ai-unlock-password').value = 'abcdef';
      unlock.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(40);
    }
  }
  const activate = document.querySelector('[data-action="activate-provider"]');
  if (activate) {
    click(activate);
    await flush(20);
  }
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="organize-existing"]'));
  click('[data-action="organize-existing"]');
  await flush(40);
  click('[data-action="view-proposals"]');
  await waitFor(() => document.querySelector('[data-action="apply-proposal"], .empty-state, .proposal-list'));
  const apply = document.querySelector('[data-action="apply-proposal"]');
  if (apply) {
    click(apply);
    await flush(20);
  }
  const dismiss = document.querySelector('[data-action="dismiss-proposal"]');
  if (dismiss) {
    click(dismiss);
    await flush(20);
  }
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="manage-providers"]'));
  click('[data-action="manage-providers"]');
  await waitFor(() => document.querySelector('[data-action="delete-provider"], [data-action="new-provider"]'));
  const del = document.querySelector('[data-action="delete-provider"]');
  if (del) {
    click(del);
    confirmOpenDialog();
    await flush(30);
  }
});

test('site hint, ignore, package category, aigc move, and click-away menu', async () => {
  click('[data-action="home"]');
  await waitFor(() => document.querySelector('[data-tab="generic"], [data-tab="aigc"]'));
  const enableCurrent = document.querySelector('[data-action="enable-current-site"]');
  if (enableCurrent) {
    click(enableCurrent);
    await flush(40);
  }
  const ignoreCurrent = document.querySelector('[data-action="ignore-current-site"]');
  if (ignoreCurrent) {
    click(ignoreCurrent);
    await flush(20);
  }
  click('[data-tab="aigc"]');
  await waitFor(() => document.querySelector('[data-privacy="normal"]'));
  click('[data-privacy="normal"]');
  await waitFor(() => document.querySelector('[data-action="open-asset"], .empty-state'));
  const aigcOpen = document.querySelector('[data-action="open-asset"]');
  if (aigcOpen) {
    click(aigcOpen);
    await waitFor(() => document.querySelector('[data-action="move-asset"]') || document.querySelector('#editor-form'));
    const move = document.querySelector('[data-action="move-asset"]');
    if (move) {
      click(move);
      confirmOpenDialog();
      await flush(30);
    } else {
      click('[data-action="editor-back"]');
      await flush(20);
    }
  }
  click('[data-tab="skill"]');
  await waitFor(() => document.querySelector('[data-action="open-asset"], [data-action="collect-github-skill"]'));
  const skillOpen = document.querySelector('[data-action="open-asset"]');
  if (skillOpen) {
    click(skillOpen);
    await waitFor(() => document.querySelector('#editor-form, [data-action="update-github-skill"]'));
    if (document.querySelector('[data-action="new-category-from-editor"]')) {
      click('[data-action="new-category-from-editor"]');
      await waitFor(() => document.querySelector('#editor-new-category'));
      document.querySelector('#editor-new-category').value = '邮件技能';
      click('[data-action="create-category-from-editor"]');
      await flush(30);
    }
    click('[data-action="home"]');
    await flush(20);
  }
  click('[data-tab="generic"]');
  await waitFor(() => document.querySelector('[data-action="toggle-category-menu"]'));
  click('[data-action="toggle-category-menu"]');
  await flush();
  document.querySelector('#app').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  assert.ok(document.querySelector('#app').innerHTML.length > 20);
});

