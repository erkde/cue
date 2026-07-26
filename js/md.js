// Minimal markdown -> HTML renderer. Covers the common subset a script needs
// (headings, lists, quotes, fenced/indented code, emphasis, links); anything
// exotic degrades to plain paragraphs.

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`);
  out = out.replace(/\*([^*\s][^*]*)\*|(?<![\w\\])_([^_]+)_(?!\w)/g, (_, a, b) => `<em>${a ?? b}</em>`);
  out = out.replace(/\\([`*_{}[\]()#+\-.!])/g, '$1');
  return out;
}

export function mdToHtml(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const isBlank = (l) => l === undefined || /^\s*$/.test(l);

  while (i < lines.length) {
    let line = lines[i];

    if (isBlank(line)) { i++; continue; }

    // fenced code
    const fence = line.match(/^(```|~~~)\s*(\S*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence[1])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // indented code (only when the previous line was blank, so list
    // continuations don't get swallowed)
    if (/^ {4,}\S/.test(line) && isBlank(lines[i - 1])) {
      const buf = [];
      while (i < lines.length && (/^ {4,}/.test(lines[i]) || isBlank(lines[i]))) {
        buf.push(lines[i].slice(4));
        i++;
      }
      while (buf.length && isBlank(buf[buf.length - 1])) buf.pop();
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // ATX headings
    const atx = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (atx) {
      out.push(`<h${atx[1].length}>${inline(atx[2])}</h${atx[1].length}>`);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push('<hr>'); i++; continue; }

    // blockquote
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && (/^\s*>/.test(lines[i]) || (!isBlank(lines[i]) && buf.length))) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // lists (single level; indented children are folded into the item)
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m) {
          items.push([m[3]]);
          i++;
        } else if (!isBlank(lines[i]) && /^\s/.test(lines[i]) && items.length) {
          items[items.length - 1].push(lines[i].trim());
          i++;
        } else if (isBlank(lines[i]) && lines[i + 1] !== undefined &&
                   /^(\s*)([-*+]|\d+[.)])\s+|^\s{2,}\S/.test(lines[i + 1])) {
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((it) => `<li>${inline(it.join(' '))}</li>`).join('') + `</${tag}>`);
      continue;
    }

    // paragraph (with setext heading lookahead)
    const buf = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) &&
           !/^(#{1,6}\s|```|~~~|\s*>|(\s*)([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
           !/^(=+|-+)\s*$/.test(lines[i])) {
      buf.push(lines[i].trim());
      i++;
    }
    const setext = lines[i]?.match(/^(=+|-+)\s*$/);
    if (setext && buf.length >= 1) {
      const tag = setext[1][0] === '=' ? 'h1' : 'h2';
      out.push(`<${tag}>${inline(buf.join(' '))}</${tag}>`);
      i++;
    } else {
      out.push(`<p>${inline(buf.join(' '))}</p>`);
    }
  }

  return out.join('\n');
}
