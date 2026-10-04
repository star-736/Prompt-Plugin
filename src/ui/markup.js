export function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

export function folderIcon() {
  return '<svg class="package-folder-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h6l2 2h10v9H3z"/><path d="M3 8V6h5l2 2"/></svg>';
}
