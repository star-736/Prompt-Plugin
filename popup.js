import { createVault, loadStoredVault, saveStoredVault, sealVault, unlockVault } from './vault.js';

const $ = (selector) => document.querySelector(selector);
const views = { setup: $('#setup-view'), unlock: $('#unlock-view'), vault: $('#vault-view') };
let vault;
let unlocked;

function show(name) { Object.entries(views).forEach(([key, element]) => { element.hidden = key !== name; }); }
function setStatus(message = '') { $('#status').textContent = message; }
function normalizedTags(value) { return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))].slice(0, 12); }
function escapeText(value) { const fragment = document.createElement('span'); fragment.textContent = value; return fragment.innerHTML; }

function matchingPrompts() {
  const query = $('#search').value.trim().toLowerCase();
  return [...unlocked.data.prompts].filter((prompt) => !query || [prompt.title, prompt.body, prompt.tags.join(' ')].join(' ').toLowerCase().includes(query)).sort((a, b) => b.updatedAt - a.updatedAt);
}

function render() {
  const prompts = matchingPrompts();
  const list = $('#prompt-list');
  list.textContent = '';
  $('#empty-state').hidden = prompts.length !== 0;
  prompts.forEach((prompt) => {
    const item = document.createElement('li'); item.className = 'prompt-card';
    item.innerHTML = `<h3>${escapeText(prompt.title)}</h3><p class="prompt-preview">${escapeText(prompt.body)}</p><div>${prompt.tags.map((tag) => `<span class="tag">${escapeText(tag)}</span>`).join('')}</div><div class="card-actions"><button type="button" class="secondary" data-copy="${prompt.id}">复制</button><button type="button" class="secondary" data-edit="${prompt.id}">编辑</button></div>`;
    list.append(item);
  });
}

async function persist() { vault = await sealVault(unlocked.data, unlocked.key, vault); await saveStoredVault(vault); }
function openEditor(prompt) {
  $('#editor-title').textContent = prompt ? '编辑提示词' : '新建提示词'; $('#prompt-id').value = prompt?.id ?? ''; $('#prompt-title').value = prompt?.title ?? ''; $('#prompt-body').value = prompt?.body ?? ''; $('#prompt-tags').value = prompt?.tags?.join(', ') ?? ''; $('#delete-prompt').hidden = !prompt; $('#editor-dialog').showModal(); $('#prompt-title').focus();
}
function closeEditor() { $('#editor-dialog').close(); $('#editor-form').reset(); }
function lock() { vault = undefined; unlocked = undefined; $('#unlock-password').value = ''; $('#search').value = ''; show('unlock'); }

async function initialize() {
  try { vault = await loadStoredVault(); show(vault ? 'unlock' : 'setup'); } catch { setStatus('无法读取本地保险箱。请检查扩展存储权限。'); }
}

$('#setup-form').addEventListener('submit', async (event) => {
  event.preventDefault(); setStatus('');
  const password = $('#setup-password').value;
  if (password !== $('#setup-confirm').value) return setStatus('两次输入的密码不一致。');
  try { const created = await createVault(password); vault = created.vault; unlocked = { key: created.key, data: { prompts: [] } }; await saveStoredVault(vault); $('#setup-form').reset(); show('vault'); render(); } catch { setStatus('创建保险箱失败，请重试。'); }
});

$('#unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault(); setStatus('');
  try { unlocked = await unlockVault(vault, $('#unlock-password').value); $('#unlock-form').reset(); show('vault'); render(); } catch { setStatus('密码错误，或保险箱数据已损坏。'); }
});

$('#new-prompt').addEventListener('click', () => openEditor()); $('#close-editor').addEventListener('click', closeEditor); $('#cancel-editor').addEventListener('click', closeEditor); $('#lock').addEventListener('click', lock); $('#search').addEventListener('input', render);
$('#editor-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const id = $('#prompt-id').value; const now = Date.now(); const prompt = { id: id || crypto.randomUUID(), title: $('#prompt-title').value.trim(), body: $('#prompt-body').value.trim(), tags: normalizedTags($('#prompt-tags').value), updatedAt: now };
  if (!prompt.title || !prompt.body) return;
  if (id) { const index = unlocked.data.prompts.findIndex((item) => item.id === id); unlocked.data.prompts[index] = { ...unlocked.data.prompts[index], ...prompt }; } else { unlocked.data.prompts.push({ ...prompt, createdAt: now }); }
  try { await persist(); closeEditor(); render(); } catch { setStatus('保存失败，请重试。'); }
});
$('#delete-prompt').addEventListener('click', async () => { const id = $('#prompt-id').value; unlocked.data.prompts = unlocked.data.prompts.filter((prompt) => prompt.id !== id); try { await persist(); closeEditor(); render(); } catch { setStatus('删除失败，请重试。'); } });
$('#prompt-list').addEventListener('click', async (event) => { const button = event.target.closest('button'); if (!button) return; const id = button.dataset.copy || button.dataset.edit; const prompt = unlocked.data.prompts.find((item) => item.id === id); if (button.dataset.edit) return openEditor(prompt); if (button.dataset.copy) { try { await navigator.clipboard.writeText(prompt.body); setStatus('已复制到剪贴板。'); } catch { setStatus('复制失败，请手动从编辑器复制。'); } } });

initialize();

