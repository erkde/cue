// Renders the script, wraps words in spans, and runs the scroll controller:
// a proportional loop that keeps the currently-spoken word at the reading
// line. The further the narrator gets ahead, the faster it scrolls.

import { normalizeWord } from './matcher.js';

const LENS_RATIO = 0.38; // reading line, fraction of viewport height
const KP = 2.2; // proportional gain (px/s per px of error)
const MAX_DOWN = 900; // px/s scrolling forward
const MAX_UP = 160; // px/s scrolling back (gentler)
const DEADBAND = 6; // px of error we ignore
const OVERRIDE_MS = 2500; // pause after the user scrolls manually

export class Prompter {
  constructor(stage, article) {
    this.stage = stage;
    this.article = article;
    this.words = []; // span elements
    this.tokens = []; // normalized words, same indices
    this.targetIdx = -1;
    this.markedIdx = -1;
    this.targetScroll = 0; // cached scroll position for the target word (see recomputeTarget)
    this.overrideUntil = 0;
    this.running = false;

    const bump = () => {
      this.overrideUntil = performance.now() + OVERRIDE_MS;
    };
    stage.addEventListener('wheel', bump, { passive: true });
    stage.addEventListener('touchmove', bump, { passive: true });
    // the word's document position only changes on layout — recache it then,
    // not every animation frame
    window.addEventListener('resize', () => this.recomputeTarget());
  }

  // Resolve the target word's position to a stage.scrollTop, forcing one layout
  // read. Called on cursor moves and layout changes — kept OUT of the rAF loop.
  recomputeTarget() {
    const el = this.words[this.targetIdx];
    if (!el) return;
    this.targetScroll = el.offsetTop + el.offsetHeight / 2 - this.stage.clientHeight * LENS_RATIO;
  }

  jumpToTarget() {
    this.stage.scrollTop = Math.max(0, this.targetScroll);
  }

  setContent(html) {
    this.article.innerHTML = html;
    this.words = [];
    this.tokens = [];
    this.targetIdx = -1;
    this.markedIdx = -1;

    const walker = document.createTreeWalker(this.article, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement.closest('pre') || !n.textContent.trim()
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      const frag = document.createDocumentFragment();
      for (const part of node.textContent.split(/(\s+)/)) {
        const norm = normalizeWord(part);
        if (!norm) {
          frag.appendChild(document.createTextNode(part));
          continue;
        }
        const span = document.createElement('span');
        span.className = 'w';
        span.dataset.wordIndex = String(this.words.length);
        span.textContent = part;
        frag.appendChild(span);
        this.words.push(span);
        this.tokens.push(norm);
      }
      node.parentNode.replaceChild(frag, node);
    }

    // start with the first line at the reading line — the large top padding
    // otherwise leaves the initial viewport looking empty
    const first = this.words[0] ?? this.article.firstElementChild;
    if (first) {
      this.stage.scrollTop = Math.max(0, first.offsetTop - this.stage.clientHeight * LENS_RATIO);
    }
    return this.tokens;
  }

  setTarget(idx) {
    if (idx < 0 || idx >= this.words.length) return;
    this.targetIdx = idx;

    // move the highlight incrementally
    if (this.markedIdx >= 0) this.words[this.markedIdx].classList.remove('now');
    const from = Math.min(this.markedIdx + 1, idx);
    for (let i = from; i < idx; i++) this.words[i].classList.add('past');
    for (let i = idx; i <= this.markedIdx; i++) this.words[i].classList.remove('past');
    this.words[idx].classList.add('now');
    this.words[idx].classList.remove('past');
    this.markedIdx = idx;

    // cache the scroll target now (after the highlight classes are applied so
    // the measured layout is final) rather than re-reading it every frame
    this.recomputeTarget();
  }

  reset() {
    for (const w of this.words) w.classList.remove('past', 'now');
    this.targetIdx = -1;
    this.markedIdx = -1;
  }

  start() {
    if (this.running) return;
    this.running = true;
    let last = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (this.targetIdx >= 0 && now > this.overrideUntil) {
        // targetScroll is cached in setTarget/recomputeTarget — no layout read here
        const err = this.targetScroll - this.stage.scrollTop;
        if (Math.abs(err) > DEADBAND) {
          const v = Math.max(-MAX_UP, Math.min(MAX_DOWN, KP * err));
          this.stage.scrollTop += v * dt;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
  }
}
