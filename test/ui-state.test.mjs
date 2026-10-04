import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssetEditor } from '../src/ui/popup/asset-editor.js';
import { createSkillWorkspace } from '../src/ui/popup/skill-workspace.js';
import { createEmptyDatabase } from '../src/core/store.js';
import { installDom, flush } from './helpers.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

test('leaving an editor while category setup waits does not write into a newer session', async () => {
  const { window, document } = installDom('<div id="app"><form id="editor-form"><input id="editor-title-input"><textarea id="editor-content">old input</textarea></form></div>');
  const gate = deferred();
  let database = createEmptyDatabase();
  let renders = 0;
  const editor = createAssetEditor({
    getDatabase: () => database,
    commit: async (mutator) => { await gate.promise; database = mutator(database) ?? database; },
    onChange: () => { renders += 1; },
    onExit() {},
    showConfirm() {},
    showToast() {},
    scheduleAi() {}
  });
  try {
    editor.open({ type: 'generic', privacy: 'normal' });
    const setup = editor.beginCategoryCreate();
    editor.clear();
    editor.open({ type: 'command', privacy: 'normal' });
    document.querySelector('#editor-content').value = 'new command';
    gate.resolve();
    await setup;
    assert.equal(renders, 0);
    assert.equal(editor.current.type, 'command');
    assert.equal(editor.current.categoryCreating, undefined);
    assert.deepEqual(database.drafts, {});
  } finally { window.close(); }
});

test('late Skill package loads cannot replace the currently selected document', async () => {
  const { window, document } = installDom('<div id="app"></div>');
  const first = deferred();
  const second = deferred();
  const assets = ['first', 'second'].map((id) => ({ id, type: 'skill', title: id, content: `# ${id}`, updatedAt: 1, skillPackage: { packageId: id } }));
  let updates = 0;
  const reader = createSkillWorkspace({
    selectedId: 'first',
    loadPackage: (id) => id === 'first' ? first.promise : second.promise,
    onChange: () => { updates += 1; document.querySelector('#app').innerHTML = reader.render({ assets, categories: [] }); },
    showToast() {}
  });
  try {
    document.querySelector('#app').innerHTML = reader.render({ assets, categories: [] });
    reader.open('second');
    document.querySelector('#app').innerHTML = reader.render({ assets, categories: [] });
    first.resolve({ files: [{ path: 'old.md', content: Buffer.from('old').toString('base64') }] });
    await flush();
    assert.equal(updates, 0);
    assert.equal(document.querySelector('.reader-header h1').textContent, 'second');
    assert.equal(document.querySelector('[data-path="old.md"]'), null);
    second.resolve({ files: [{ path: 'new.md', content: Buffer.from('new').toString('base64') }] });
    await flush();
    assert.equal(updates, 1);
    assert.ok(document.querySelector('[data-path="new.md"]'));
  } finally { window.close(); }
});


test('a completed save preserves a newer editor session and only saves its captured input', async () => {
  const { window, document } = installDom('<div id="app"><form id="editor-form"><input id="editor-title-input"><textarea id="editor-content">original saved input</textarea><p id="editor-error"></p><p id="editor-progress"></p><button type="submit">保存</button></form></div>');
  const gate = deferred();
  let database = createEmptyDatabase();
  let exits = 0;
  const editor = createAssetEditor({
    getDatabase: () => database,
    commit: async (mutator) => { await gate.promise; database = mutator(database) ?? database; },
    onChange() {},
    onExit: () => { exits += 1; },
    showConfirm() {},
    showToast() {},
    scheduleAi() {}
  });
  try {
    editor.open({ type: 'generic', privacy: 'normal' });
    const saving = editor.save();
    editor.clear();
    editor.open({ type: 'command', privacy: 'normal' });
    document.querySelector('#editor-content').value = 'new editor input';
    gate.resolve();
    await saving;
    assert.equal(exits, 0);
    assert.equal(editor.current.type, 'command');
    assert.equal(editor.current.saving, undefined);
    assert.equal(database.assets.length, 1);
    assert.equal(database.assets[0].content, 'original saved input');
    assert.equal(database.assets[0].type, 'generic');
  } finally { window.close(); }
});
