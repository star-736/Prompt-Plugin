import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';
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
import { click, confirmOpenDialog, createChromeStub, createMemoryIndexedDB, flush, installDom, loadFreshEntry, popupHtml, seedDatabase, waitFor } from './helpers.mjs';

const skill = `---\nname: Email reviewer\ndescription: Review email drafts\n---\n\n# Instructions\nReview the email.`;

function withSites(database, sites) {
  const next = structuredClone(database);
  next.settings.inPlace.sites = sites;
  next.settings.inPlace.enabled = true;
  return next;
}

let window, document, indexedDb, stub, messages;
beforeEach(async (t) => {
({ window, document } = installDom(popupHtml(), { url: 'https://github.com/acme/demo/blob/main/skills/demo/SKILL.md' }));
indexedDb = createMemoryIndexedDB();
messages = [];
stub = createChromeStub({
  grantedOrigins: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*', 'https://chat.openai.com/*', 'https://github.com/*', 'https://api.github.com/*', 'https://api.openai.com/*'],
  tabs: [{ id: 7, url: 'https://chatgpt.com/c/1', active: true, windowId: 1 }],
  indexedDB: indexedDb,
  sendMessage: async (message) => {
    messages.push(message);
    if (message.type === 'read-notice') return { ok: true, result: { message: '刚才保存成功' } };
    if (message.type === 'sync-sites') return { ok: true, result: { sites: 1 } };
    if (message.type === 'schedule-ai') return { ok: true, result: { ok: true } };
    if (message.type === 'clear-ai-session') return { ok: true, result: { ok: true } };
    if (message.type === 'ai-session-status') return { ok: true, result: { unlocked: false, providerId: 'p1' } };
    if (message.type === 'unlock-ai') return { ok: true, result: { providerId: 'p1' } };
    if (message.type === 'test-provider') return { ok: true, result: { ok: true } };
    if (message.type === 'queue-existing') return { ok: true, result: { count: 2 } };
    if (message.type === 'save-provider') return { ok: true, result: { id: 'p1', label: message.provider.label } };
    if (message.type === 'delete-provider') {
      stub.local['futurecontext.v1'].ai.providers = stub.local['futurecontext.v1'].ai.providers.filter((p) => p.id !== message.id);
      return { ok: true, result: { ok: true } };
    }
    if (message.type === 'collect-github-skill') return { ok: true, result: { duplicate: false, asset: { id: 'skill-1', title: 'Email reviewer' }, hasToken: false } };
    if (message.type === 'update-github-skill') return { ok: true, result: { changed: false, hasToken: true } };
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
if (t.name.includes('read-only')) database.version = 999;
if (t.name.includes('activating another provider')) {
  database.ai.providers.push({ ...database.ai.providers[0], id: 'p2', label: 'Second provider' });
}
seedDatabase(stub.local, database);

await import('../package-store.js').then(({ putPackage }) => putPackage({
  id: 'pkg-1',
  files: [
    { path: 'SKILL.md', content: Buffer.from(skill).toString('base64'), size: 20, contentType: 'text/plain' },
    { path: 'agents/openai.yaml', content: Buffer.from('model: gpt-4').toString('base64'), size: 12, contentType: 'text/yaml' }
  ],
  fileCount: 2,
  totalSize: 32
}, indexedDb));

await loadFreshEntry('../popup.js');
await waitFor(() => document.querySelector('.tabs'));
});
afterEach(() => window.close());

function addProposal(db) {
  const next = structuredClone(db);
  next.ai.proposals = [{ id: 'prop-1', status: 'pending', scope: 'generic', summary: '合并分类', groups: [{ from: ['工作'], to: '沟通' }], createdAt: 1 }];
  return next;
}

function toastText() {
  return document.querySelector('#toast')?.textContent || '';
}

function holdRuntimeMessage(type) {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const original = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async (message) => {
    if (message.type === type) await gate;
    return original(message);
  };
  return () => release();
}

test('GitHub Token can be saved, replaced and removed without rendering its value', async () => {
  click('[data-action="settings"]');
  assert.match(document.querySelector('#app').textContent, /提高公开仓库的 GitHub API 额度/);
  assert.match(document.querySelector('#app').textContent, /明文只存在此浏览器配置文件中/);
  assert.match(document.querySelector('#app').textContent, /不写入备份/);
  assert.doesNotMatch(document.querySelector('#app').textContent, /私有仓库/);
  for (const token of ['ghp_example', 'github_pat_replacement']) {
    document.querySelector('#github-token').value = token;
    document.querySelector('#github-token-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => stub.local['futurecontext.github-token'] === token);
    await waitFor(() => document.querySelector('#github-token').value === '');
    assert.equal(document.querySelector('#app').innerHTML.includes(token), false);
    assert.match(document.querySelector('#app').textContent, /已配置/);
  }
  click('[data-action="remove-github-token"]');
  await waitFor(() => !stub.local['futurecontext.github-token']);
  await waitFor(() => /未配置/.test(document.querySelector('#app').textContent));
  assert.equal(JSON.stringify(createBackup(stub.local['futurecontext.v1'])).includes('github_pat_replacement'), false);
});

test('invalid GitHub Token reports a validation error without saving', async () => {
  click('[data-action="settings"]');
  document.querySelector('#github-token').value = 'Bearer example';
  document.querySelector('#github-token-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => /格式不正确/.test(document.querySelector('#github-token-status').textContent));
  assert.equal(stub.local['futurecontext.github-token'], undefined);
  assert.equal(document.querySelector('#github-token').value, '');
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
  await waitFor(() => /已置顶|已取消置顶/.test(toastText()));
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

test('terminal command tab: content-first create, categorize, list, and copy', async () => {
  click('[data-tab="command"]');
  await waitFor(() => document.querySelector('[data-tab="command"].is-active'));
  assert.match(document.querySelector('#app').innerHTML, /暂无终端指令/);

  click('[data-action="new-asset"]');
  await waitFor(() => document.querySelector('#editor-form'));
  // Terminal commands are content-first: no title field, just a category and the command body.
  assert.equal(document.querySelector('#editor-title-input'), null);
  assert.ok(document.querySelector('#editor-category'));
  assert.match(document.querySelector('.editor-form').innerHTML, /命令/);

  document.querySelector('#editor-content').value = 'codex --dangerously-bypass-approvals-and-sandbox';
  document.querySelector('#editor-content').dispatchEvent(new window.Event('input', { bubbles: true }));
  await flush(20);
  click('[data-action="new-category-from-editor"]');
  await waitFor(() => document.querySelector('#editor-new-category'));
  document.querySelector('#editor-new-category').value = 'AI Agent';
  click('[data-action="create-category-from-editor"]');
  await waitFor(() => /分类已新建/.test(toastText()));
  document.querySelector('#editor-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  await waitFor(() => document.querySelector('[data-action="open-asset"]'));
  // The command body is shown directly (content-first), with its category badge.
  assert.match(document.querySelector('.asset-command-content').textContent, /codex --dangerously-bypass-approvals-and-sandbox/);
  assert.match(document.querySelector('.asset-list').innerHTML, /AI Agent/);
  click('[data-action="copy-asset"]');
  await waitFor(() => /复制/.test(toastText()));
});

test('open GitHub skill package, update, and delete with confirm', async () => {
  click('[data-tab="skill"]');
  await waitFor(() => document.querySelector('[data-id="skill-gh"]'));
  click('[data-action="open-asset"][data-id="skill-gh"]');
  await waitFor(() => document.querySelector('[data-action="update-github-skill"]'));
  const fileLabels = [...document.querySelectorAll('.package-file > summary')].map((el) => el.childNodes[0].textContent.trim());
  assert.deepEqual(fileLabels, ['openai.yaml', 'SKILL.md']);
  assert.equal(document.querySelector('.package-folder > summary').textContent.trim(), 'agents/');
  assert.equal(document.querySelector('.package-folder').open, true);
  assert.equal(document.querySelector('.package-file[open] > summary').childNodes[0].textContent.trim(), 'SKILL.md');
  assert.equal(document.querySelector('.package-tree').textContent.includes('agents/openai.yaml'), false);
  const releaseUpdate = holdRuntimeMessage('update-github-skill');
  click('[data-action="update-github-skill"]');
  await waitFor(() => toastText() === '正在检查 GitHub 更新…');
  assert.equal(document.querySelector('[data-action="update-github-skill"]').disabled, true);
  releaseUpdate();
  await waitFor(() => toastText() === '已是当前保存版本（已使用 GitHub Token）');
  assert.equal(document.querySelector('[data-action="update-github-skill"]').disabled, false);
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
  const releaseCollect = holdRuntimeMessage('collect-github-skill');
  click('[data-action="collect-github-skill"]');
  await waitFor(() => toastText() === '正在从 GitHub 收集…');
  assert.equal(document.querySelector('[data-action="collect-github-skill"]').disabled, true);
  releaseCollect();
  await waitFor(() => messages.some((m) => m.type === 'collect-github-skill'));
  await waitFor(() => toastText() === 'GitHub Skill 已保存（当前为匿名额度）');
  assert.equal(document.querySelector('[data-action="collect-github-skill"]').disabled, false);
  assert.doesNotMatch(toastText(), /失败/);
});

test('locked private library requires the password form', async () => {
  click('[data-tab="aigc"]');
  await waitFor(() => document.querySelector('[data-privacy="private"]'));
  click('[data-privacy="private"]');
  await waitFor(() => document.querySelector('#private-gate-form'));
  assert.equal(document.querySelector('.asset-list'), null);
});

test('categories, open generic asset, discard editor, and import backup', async () => {
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
  await waitFor(() => /分类已重命名/.test(toastText()));
  click('[data-action="delete-category"]');
  confirmOpenDialog();
  await waitFor(() => /分类已删除/.test(toastText()));
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
  const importedDatabase = saveAsset(createEmptyDatabase(), { type: 'generic', title: 'Imported prompt', content: 'unique imported content' }, { id: 'imported' }).database;
  const backup = createBackup(importedDatabase, 9);
  const file = new window.File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' });
  const input = document.querySelector('#backup-input');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => /已导入 1 项/.test(toastText()));
  assert.equal(stub.local['futurecontext.v1'].assets.filter((asset) => asset.content === 'unique imported content').length, 1);
});

test('provider unlock, organize, delete, and apply proposal persist their results', async () => {
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="manage-providers"]'));
  click('[data-action="manage-providers"]');
  await waitFor(() => document.querySelector('[data-action="test-provider"], [data-action="new-provider"]'));
  const testBtn = document.querySelector('[data-action="test-provider"]');
  assert.ok(testBtn);
  {
    click(testBtn);
    await waitFor(() => document.querySelector('#ai-unlock-form') || /测试/.test(toastText()) || /连接/.test(toastText()));
    const unlock = document.querySelector('#ai-unlock-form');
    assert.ok(unlock);
    {
      document.querySelector('#ai-unlock-password').value = '123456';
      unlock.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(40);
      assert.ok(messages.some((m) => m.type === 'unlock-ai' && m.password === '123456'));
      assert.ok(messages.some((m) => m.type === 'test-provider' && m.id === 'p1'));
      assert.equal(toastText(), '连接测试成功');
    }
  }
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="organize-existing"]'));
  click('[data-action="organize-existing"]');
  await waitFor(() => document.querySelector('#ai-unlock-form'));
  document.querySelector('#ai-unlock-password').value = '123456';
  document.querySelector('#ai-unlock-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => toastText() === '已加入 2 项后台整理');
  assert.ok(messages.some((m) => m.type === 'queue-existing'));
  click('[data-action="view-proposals"]');
  await waitFor(() => document.querySelector('[data-action="apply-proposal"], .empty-state, .proposal-list'));
  const apply = document.querySelector('[data-action="apply-proposal"]');
  assert.ok(apply);
  {
    click(apply);
    await flush(20);
    assert.equal(stub.local['futurecontext.v1'].ai.proposals.find((p) => p.id === 'prop-1').status, 'applied');
  }
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="manage-providers"]'));
  click('[data-action="manage-providers"]');
  await waitFor(() => document.querySelector('[data-action="delete-provider"], [data-action="new-provider"]'));
  const del = document.querySelector('[data-action="delete-provider"]');
  assert.ok(del);
  {
    click(del);
    confirmOpenDialog();
    await flush(30);
    assert.ok(messages.some((m) => m.type === 'delete-provider' && m.id === 'p1'));
    assert.equal(document.querySelector('[data-action="delete-provider"]'), null);
  }
});

test('site enable, package category, aigc move, and click-away menu', async () => {
  click('[data-action="home"]');
  await waitFor(() => document.querySelector('[data-tab="generic"], [data-tab="aigc"]'));
  const enableCurrent = document.querySelector('[data-action="enable-current-site"]');
  assert.ok(enableCurrent);
  {
    click(enableCurrent);
    await flush(40);
    assert.ok(stub.local['futurecontext.v1'].settings.inPlace.sites.includes('https://chatgpt.com'));
  }
  click('[data-tab="aigc"]');
  await waitFor(() => document.querySelector('[data-privacy="normal"]'));
  click('[data-privacy="normal"]');
  await waitFor(() => document.querySelector('[data-action="open-asset"], .empty-state'));
  const aigcOpen = document.querySelector('[data-action="open-asset"]');
  assert.ok(aigcOpen);
  {
    click(aigcOpen);
    await waitFor(() => document.querySelector('[data-action="move-asset"]') || document.querySelector('#editor-form'));
    const move = document.querySelector('[data-action="move-asset"]');
    assert.ok(move);
    {
      click(move);
      confirmOpenDialog();
      await flush(30);
      assert.equal(stub.local['futurecontext.v1'].assets.find((a) => a.id === 'a1').privacy, 'private');
    }
  }
  click('[data-tab="skill"]');
  await waitFor(() => document.querySelector('[data-action="open-asset"], [data-action="collect-github-skill"]'));
  const skillOpen = document.querySelector('[data-action="open-asset"][data-id="skill-gh"]');
  assert.ok(skillOpen);
  {
    click(skillOpen);
    await waitFor(() => document.querySelector('#editor-form, [data-action="update-github-skill"]'));
    assert.ok(document.querySelector('[data-action="new-category-from-editor"]'));
    {
      click('[data-action="new-category-from-editor"]');
      await waitFor(() => document.querySelector('#editor-new-category'));
      document.querySelector('#editor-new-category').value = '邮件技能';
      click('[data-action="create-category-from-editor"]');
      await flush(30);
      assert.ok(stub.local['futurecontext.v1'].assets.find((a) => a.id === 'skill-gh').categoryId);
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
  assert.equal(document.querySelector('[data-action="manage-categories"]').closest('.category-menu').hidden, true);
});

test('ignore current site persists the choice and removes the hint', async () => {
  click('[data-action="ignore-current-site"]');
  await waitFor(() => !document.querySelector('[data-action="ignore-current-site"]'));
  assert.ok(stub.local['futurecontext.v1'].settings.inPlace.ignoredSites.includes('https://chatgpt.com'));
});

test('dismissing a proposal persists dismissed status', async () => {
  click('[data-action="settings"]');
  click('[data-action="view-proposals"]');
  click('[data-action="dismiss-proposal"]');
  await waitFor(() => toastText() === '已保留当前分类');
  assert.equal(stub.local['futurecontext.v1'].ai.proposals.find((p) => p.id === 'prop-1').status, 'dismissed');
});

test('activating another provider persists its ID', async () => {
  click('[data-action="settings"]');
  click('[data-action="manage-providers"]');
  click('[data-action="activate-provider"][data-id="p2"]');
  await waitFor(() => toastText() === '已设为当前 Provider');
  assert.equal(stub.local['futurecontext.v1'].ai.activeProviderId, 'p2');
});

test('read-only import refuses to overwrite the database', async () => {
  const before = structuredClone(stub.local['futurecontext.v1']);
  click('[data-action="settings"]');
  const input = document.querySelector('#backup-input');
  const backup = createBackup(saveAsset(createEmptyDatabase(), { type: 'generic', content: 'must not be saved' }).database);
  Object.defineProperty(input, 'files', { configurable: true, value: [new window.File([JSON.stringify(backup)], 'backup.json')] });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => /只读/.test(toastText()));
  assert.deepEqual(stub.local['futurecontext.v1'], before);
});

test('category picker is hidden on AIGC and shown on terminal commands', async () => {
  click('[data-tab="aigc"]');
  await waitFor(() => document.querySelector('[data-privacy="normal"]'));
  assert.equal(document.querySelector('[data-action="toggle-category-menu"]'), null);
  click('[data-tab="command"]');
  await waitFor(() => document.querySelector('[data-tab="command"].is-active'));
  assert.ok(document.querySelector('[data-action="toggle-category-menu"]'));
});

test('export skips unlock when there is no private content', async () => {
  click('[data-action="settings"]');
  await waitFor(() => document.querySelector('[data-action="export-backup"]'));
  click('[data-action="export-backup"]');
  await waitFor(() => document.querySelector('#confirm-title')?.textContent === '导出全部数据');
  assert.notEqual(document.querySelector('#confirm-title')?.textContent, '需要解锁私密库');
});

test('invalid backup reports an error and preserves existing data', async () => {
  const before = structuredClone(stub.local['futurecontext.v1']);
  click('[data-action="settings"]');
  const input = document.querySelector('#backup-input');
  Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['{}'], 'invalid.json')] });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => toastText() === '这不是 FutureContext 的有效备份文件。');
  assert.deepEqual(stub.local['futurecontext.v1'], before);
});
