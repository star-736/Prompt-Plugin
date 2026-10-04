export function decodePackageText(file) {
  try { return decodeURIComponent(Array.from(atob(String(file.content ?? '').replace(/\n/g, '')), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')); } catch { return ''; }
}
