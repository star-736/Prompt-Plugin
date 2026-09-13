import { marked } from './vendor/marked.js';
import createDOMPurify from './vendor/dompurify.js';

export function skillBody(content) {
  return String(content ?? '').replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');
}

export function resolveSkillLink(href, currentPath = 'SKILL.md') {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return null;
  try {
    const base = new URL(currentPath, 'https://skill.invalid/');
    const url = new URL(href, base);
    return { path: decodeURIComponent(url.pathname.slice(1)), hash: decodeURIComponent(url.hash.slice(1)) };
  } catch { return null; }
}

export function renderSkillMarkdown(content, currentPath = 'SKILL.md') {
  const purifier = createDOMPurify(window);
  const html = purifier.sanitize(marked.parse(content, { gfm: true }), {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'details', 'summary'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'align'],
    ALLOW_DATA_ATTR: false,
  });
  const template = document.createElement('template');
  template.innerHTML = html;
  const headings = new Map();
  for (const heading of template.content.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const slug = heading.textContent.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = headings.get(slug) ?? 0;
    headings.set(slug, count + 1);
    heading.id = `skill-heading-${slug}${count ? `-${count}` : ''}`;
  }
  for (const link of template.content.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    const local = resolveSkillLink(href, currentPath);
    if (local) {
      link.dataset.readerFile = local.path;
      link.dataset.readerHash = local.hash;
      link.setAttribute('href', '#');
    } else if (href.startsWith('#')) {
      link.dataset.readerHash = href.slice(1);
    } else if (/^https?:\/\//i.test(href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else link.removeAttribute('href');
  }
  return template.innerHTML;
}
