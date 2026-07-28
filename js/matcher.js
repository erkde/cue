// Aligns the tail of the live transcript against the script tokens with a
// local (Smith-Waterman style) alignment, biased to a window around the
// current cursor so the prompter can't teleport across the document.

export const normalizeWord = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

function editDistanceAtMost1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0,
    j = 0,
    edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4) {
    if (editDistanceAtMost1(a, b)) return 0.8;
    if (a.startsWith(b) || b.startsWith(a)) return 0.7;
  }
  return 0;
}

const MATCH = 2,
  GAP = -0.7,
  MISMATCH = -1;

// Reading is forward-biased: backward cursor moves up to this many words are
// treated as jitter and ignored (they'd scroll the text the wrong way). Larger
// backward jumps are honored as genuine re-reads.
const BACK_TOL = 8;

export class Matcher {
  constructor(tokens) {
    this.tokens = tokens; // normalized script words
    this.cursor = 0; // index of the word we believe was just spoken
  }

  // Returns the new cursor index, or null if the transcript didn't match
  // confidently enough to move.
  feed(text) {
    const spoken = text.split(/\s+/).map(normalizeWord).filter(Boolean).slice(-14);
    if (spoken.length < 2) return null;

    const lo = Math.max(0, this.cursor - 25);
    const hi = Math.min(this.tokens.length, this.cursor + 90);
    const win = this.tokens.slice(lo, hi);
    if (!win.length) return null;

    const m = spoken.length,
      n = win.length;
    let prev = new Float32Array(n + 1);
    let curr = new Float32Array(n + 1);
    let best = 0,
      bestJ = -1;

    for (let i = 1; i <= m; i++) {
      curr[0] = 0;
      for (let j = 1; j <= n; j++) {
        const sim = similarity(spoken[i - 1], win[j - 1]);
        const diag = prev[j - 1] + (sim > 0 ? MATCH * sim : MISMATCH);
        curr[j] = Math.max(0, diag, prev[j] + GAP, curr[j - 1] + GAP);
        // Keep the earliest occurrence of the best score to avoid jumping
        // ahead when a short phrase repeats later in the script.
        if (i === m && curr[j] > best) {
          best = curr[j];
          bestJ = j;
        }
      }
      [prev, curr] = [curr, prev];
    }

    // require roughly 3 solid word matches before trusting a move
    const threshold = Math.min(5, 1.6 * spoken.length);
    if (best < threshold || bestJ < 0) return null;

    const idx = lo + bestJ - 1;
    // suppress backward wobble from overlapping windows (worst early, when
    // there's little context); only large backward jumps count as re-reads
    if (idx < this.cursor && this.cursor - idx <= BACK_TOL) return this.cursor;
    this.cursor = idx;
    return idx;
  }
}
