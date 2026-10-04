import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderSkillMarkdown, resolveSkillLink, skillBody } from '../src/ui/popup/skill-reader.js';

test('Skill Markdown renders full structured content while removing active HTML', () => {
  const dom = new JSDOM('');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const source = '---\nname: demo\ndescription: test\n---\n# Read me\n\n| A | B |\n| - | - |\n| x | y |\n\n```js\nconst x = 1;\n```\n\n[Reference](references/guide.md)\n\n<script>alert(1)</script><a href="javascript:alert(1)" data-action="delete-asset">Bad</a><img src="https://example.com/track" onerror="alert(1)">\n\nLast paragraph.';
    const html = renderSkillMarkdown(skillBody(source));
    const host = document.createElement('div');
    host.innerHTML = html;
    assert.equal(host.querySelector('h1').textContent, 'Read me');
    assert.ok(host.querySelector('table'));
    assert.match(host.querySelector('pre').textContent, /const x/);
    assert.match(host.textContent, /Last paragraph/);
    assert.doesNotMatch(host.textContent, /name: demo/);
    assert.equal(host.querySelector('script,img,[data-action],[href^="javascript:"]'), null);
    assert.equal(host.querySelector('a').dataset.readerFile, 'references/guide.md');
  } finally { dom.window.close(); delete globalThis.window; delete globalThis.document; }
});

test('Skill links resolve relative to the current package file', () => {
  assert.deepEqual(resolveSkillLink('../SKILL.md#usage', 'references/guide.md'), { path: 'SKILL.md', hash: 'usage' });
  assert.equal(resolveSkillLink('https://example.com'), null);
  assert.equal(resolveSkillLink('javascript:alert(1)'), null);
  assert.equal(skillBody('No frontmatter'), 'No frontmatter');
});
