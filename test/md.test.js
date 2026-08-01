import test from 'node:test';
import assert from 'node:assert/strict';
import { mdToHtml } from '../js/md.js';

test('renders headings', () => {
  assert.equal(mdToHtml('# Hello'), '<h1>Hello</h1>');
  assert.equal(mdToHtml('### Three'), '<h3>Three</h3>');
});

test('renders a paragraph', () => {
  assert.equal(mdToHtml('just some text'), '<p>just some text</p>');
});

test('emphasis and inline code', () => {
  assert.match(mdToHtml('**bold**'), /<strong>bold<\/strong>/);
  assert.match(mdToHtml('*italic*'), /<em>italic<\/em>/);
  assert.match(mdToHtml('`code`'), /<code>code<\/code>/);
});

test('escapes raw HTML — no tag injection', () => {
  const html = mdToHtml('<script>alert(1)</script>');
  assert.ok(!/<script/i.test(html), 'raw <script> must be escaped');
  assert.match(html, /&lt;script&gt;/);
});

test('images degrade to emphasis, never an <img> tag', () => {
  const html = mdToHtml('![alt text](https://evil.example/x.png)');
  assert.ok(!/<img/i.test(html), 'no <img> tag');
  assert.match(html, /<em>alt text<\/em>/);
});

test('ignores standalone HTML comments', () => {
  const html = mdToHtml('Before\n\n<!-- an author note -->\n\nAfter');
  assert.ok(!html.includes('author note'));
  assert.match(html, /<p>Before<\/p>[\s\S]*<p>After<\/p>/);
});

test('former Cue directives remain inert and invisible', () => {
  const html = mdToHtml('Before\n<!-- cue:stop -->\nAfter');
  assert.ok(!html.includes('cue:stop'));
  assert.equal(html, '<p>Before</p>\n<p>After</p>');
});

// ---- link scheme allowlist (XSS regression guards) ----

test('allows safe link schemes', () => {
  assert.match(mdToHtml('[x](https://a.com)'), /<a href="https:\/\/a\.com"/);
  assert.match(mdToHtml('[x](mailto:a@b.com)'), /<a href="mailto:a@b\.com"/);
  assert.match(mdToHtml('[x](./rel.md)'), /<a href="\.\/rel\.md"/);
  assert.match(mdToHtml('[x](#anchor)'), /<a href="#anchor"/);
});

for (const url of [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,<b>x</b>',
  'vbscript:msgbox',
]) {
  test(`blocks dangerous scheme and keeps text: ${url}`, () => {
    const html = mdToHtml(`[click](${url})`);
    assert.ok(!/<a\b/i.test(html), 'must not render an anchor');
    assert.ok(!/javascript:|data:|vbscript:/i.test(html), 'no dangerous scheme in output');
    assert.match(html, /click/, 'link text is preserved as plain text');
  });
}
