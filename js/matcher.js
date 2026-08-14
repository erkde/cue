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

  seek(idx) {
    if (!this.tokens.length) return null;
    this.cursor = Math.max(0, Math.min(this.tokens.length - 1, Math.round(idx)));
    return this.cursor;
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
    let finalCandidate = null;
    let prefixCandidate = null;

    for (let i = 1; i <= m; i++) {
      curr[0] = 0;
      let rowBest = 0,
        rowBestJ = -1;
      for (let j = 1; j <= n; j++) {
        const sim = similarity(spoken[i - 1], win[j - 1]);
        const diag = prev[j - 1] + (sim > 0 ? MATCH * sim : MISMATCH);
        curr[j] = Math.max(0, diag, prev[j] + GAP, curr[j - 1] + GAP);
        // Keep the earliest occurrence of the best score to avoid jumping
        // ahead when a short phrase repeats later in the script.
        if (curr[j] > rowBest) {
          rowBest = curr[j];
          rowBestJ = j;
        }
      }
      if (i === m - 1) prefixCandidate = { score: rowBest, j: rowBestJ, words: i };
      if (i === m) finalCandidate = { score: rowBest, j: rowBestJ, words: i };
      [prev, curr] = [curr, prev];
    }

    // Prefer the full transcript. If its final word is a bad partial or
    // homophone (for example, "Welcome to queue" for "Welcome to Cue"), keep
    // an otherwise-confident prefix rather than throwing the whole phrase away.
    // We drop at most one trailing word and still require at least two.
    const confident = (candidate) =>
      candidate?.words >= 2 &&
      candidate.j >= 0 &&
      candidate.score >= Math.min(5, 1.6 * candidate.words);
    const candidate = confident(finalCandidate)
      ? finalCandidate
      : confident(prefixCandidate)
        ? prefixCandidate
        : null;
    if (!candidate) return null;

    const idx = lo + candidate.j - 1;
    // suppress backward wobble from overlapping windows (worst early, when
    // there's little context); only large backward jumps count as re-reads
    if (idx < this.cursor && this.cursor - idx <= BACK_TOL) return this.cursor;
    this.cursor = idx;
    return idx;
  }
}
