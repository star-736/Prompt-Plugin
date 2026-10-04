import { buildPackageFileTree, getPackage, isTextFile } from '../../platform/package-store.js';
import { renderSkillMarkdown, skillBody } from './skill-reader.js';
import { escapeHtml, folderIcon } from '../markup.js';
import { decodePackageText } from './package-text.js';

// Package requests and file navigation belong to this reader instance.
export function createSkillWorkspace({ selectedId = null, onChange, showToast, loadPackage = getPackage }) {
  let readerAssetId = selectedId;
  let readerPath = 'SKILL.md';
  let readerPackage = null;
  let readerPackageKey = null;
  let readerPackageError = false;
  let readerFilesOpen = window.innerWidth >= 1100;
  const readerFolderOpen = new Map();

  function renderWorkspace({ assets, categories }) {
    const categoryName = (id) => categories.find((category) => category.id === id)?.name ?? '未分类';
    const asset = assets.find((item) => item.id === readerAssetId) ?? assets[0];
    if (readerAssetId !== asset.id) { readerAssetId = asset.id; readerPath = 'SKILL.md'; readerFilesOpen = window.innerWidth >= 1100; readerFolderOpen.clear(); }
    const packageId = asset.skillPackage?.packageId;
    const key = packageId ? `${asset.id}:${packageId}:${asset.updatedAt}` : null;
    if (key !== readerPackageKey) {
      readerPackageKey = key;
      readerPackage = null;
      readerPackageError = false;
      if (packageId) void loadPackage(packageId).then((record) => {
        if (readerPackageKey !== key) return;
        readerPackage = record;
        readerPackageError = !record;
        onChange();
      }).catch(() => {
        if (readerPackageKey !== key) return;
        readerPackageError = true;
        onChange();
      });
    }
    const files = readerPackage?.files ?? [];
    const file = files.find((item) => item.path === readerPath);
    const text = readerPath === 'SKILL.md' ? (file ? decodePackageText(file) : asset.content) : file && isTextFile(file.path, file.contentType) ? decodePackageText(file) : null;
    const markdown = /\.md$/i.test(readerPath);
    const body = text === null ? '<p class="reader-note">此文件为二进制资源，暂不支持正文预览。</p>' : markdown ? renderSkillMarkdown(readerPath === 'SKILL.md' ? skillBody(text) : text, readerPath) : `<pre><code>${escapeHtml(text)}</code></pre>`;
    const navigation = assets.map((item) => `<button type="button" class="skill-list-item ${item.id === asset.id ? 'is-selected' : ''}" data-action="read-skill" data-id="${escapeHtml(item.id)}" aria-current="${item.id === asset.id ? 'true' : 'false'}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.skillDescription ?? '')}</span><small>${escapeHtml(categoryName(item.categoryId))}</small></button>`).join('');
    const fileButtons = renderReaderTree(buildPackageFileTree([{ path: 'SKILL.md' }, ...files.filter((item) => item.path !== 'SKILL.md')]));
    return `<div class="skill-workspace"><aside class="skill-navigation" aria-label="Skill 列表"><div class="skill-list-heading">Skill <span>${assets.length}</span></div>${navigation}<button class="button button-ghost" type="button" data-action="collect-github-skill">从当前 GitHub 页面收集</button></aside><div class="reader-layout"><section class="skill-reader" aria-label="Skill 阅读区"><header class="reader-header"><div class="reader-eyebrow">SKILL / ${escapeHtml(categoryName(asset.categoryId))}</div><h1>${escapeHtml(asset.title)}</h1><p class="reader-description">${escapeHtml(asset.skillDescription ?? '')}</p><div class="section-actions"><button class="button button-primary" type="button" data-action="copy-asset" data-id="${escapeHtml(asset.id)}">复制 SKILL.md</button><button class="button button-ghost" type="button" data-action="manage-reader-skill" data-id="${escapeHtml(asset.id)}">${packageId ? '管理 Skill' : '编辑 Skill'}</button><button class="button button-ghost" type="button" data-action="toggle-pin" data-id="${escapeHtml(asset.id)}">${asset.pinned ? '取消置顶' : '置顶'}</button></div></header><div class="reader-file-heading"><span>${escapeHtml(readerPath)}</span>${readerPath !== 'SKILL.md' ? '<button class="inline-action" type="button" data-action="read-skill-file" data-path="SKILL.md">返回 SKILL.md</button>' : ''}</div><article class="skill-markdown">${body}</article></section>${packageId ? `<details class="reader-files" ${readerFilesOpen ? 'open' : ''}><summary>文件目录 · ${asset.skillPackage.fileCount ?? files.length} 个文件</summary><nav aria-label="Skill 文件">${fileButtons}</nav>${readerPackageError ? '<p class="reader-note">辅助文件读取失败，仍可阅读已保存的 SKILL.md。</p>' : !readerPackage ? '<p class="reader-note">正在读取辅助文件…</p>' : ''}</details>` : ''}</div></div>`;
  }

  function renderReaderTree(nodes) {
    return nodes.map((node) => {
      if (node.type === 'dir') {
        const open = readerFolderOpen.get(node.path) ?? readerPath.startsWith(`${node.path}/`);
        return `<details class="reader-folder" data-reader-folder="${escapeHtml(node.path)}" ${open ? 'open' : ''}><summary>${folderIcon()}<span>${escapeHtml(node.name)}</span></summary><div class="reader-tree-children">${renderReaderTree(node.children)}</div></details>`;
      }
      return `<button type="button" class="reader-file ${readerPath === node.path ? 'is-selected' : ''}" data-action="read-skill-file" data-path="${escapeHtml(node.path)}" aria-current="${readerPath === node.path ? 'true' : 'false'}" title="${escapeHtml(node.path)}"><span class="reader-file-icon" aria-hidden="true">≡</span><span>${escapeHtml(node.name)}</span></button>`;
    }).join('');
  }

  function readSkillFile(path, hash = '') {
    if (path !== 'SKILL.md' && !readerPackage?.files.some((file) => file.path === path)) { showToast('该文件不在已保存的 Skill 包中。'); return; }
    readerFilesOpen = document.querySelector('.reader-files')?.open ?? false;
    document.querySelectorAll('[data-reader-folder]').forEach((folder) => readerFolderOpen.set(folder.dataset.readerFolder, folder.open));
    readerPath = path;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) readerFolderOpen.set(parts.slice(0, i).join('/'), true);
    onChange();
    if (hash) scrollSkillHeading(hash);
    else document.querySelector('.reader-file-heading')?.scrollIntoView?.({ block: 'start' });
  }

  function scrollSkillHeading(hash) {
    try { document.getElementById(`skill-heading-${decodeURIComponent(hash)}`)?.scrollIntoView?.({ block: 'start' }); } catch { /* Ignore malformed anchors. */ }
  }

  return {
    get selectedId() { return readerAssetId; },
    open(id) {
      readerAssetId = id;
      readerPath = 'SKILL.md';
      readerFilesOpen = window.innerWidth >= 1100;
      readerFolderOpen.clear();
    },
    render: renderWorkspace,
    readFile: readSkillFile,
    scrollHeading: scrollSkillHeading
  };
}
