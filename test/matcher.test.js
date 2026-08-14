import test from 'node:test';
import assert from 'node:assert/strict';
import { Matcher, normalizeWord } from '../js/matcher.js';

test('normalizeWord lowercases, strips punctuation, keeps apostrophes/unicode', () => {
  assert.equal(normalizeWord('Hello,'), 'hello');
  assert.equal(normalizeWord('WORLD!'), 'world');
  assert.equal(normalizeWord("don't"), "don't");
  assert.equal(normalizeWord('café'), 'café');
  assert.equal(normalizeWord('...'), '');
});

// Unique (NATO) words so alignment is unambiguous — index N is the Nth word.
const SCRIPT =
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(
    ' ',
  );
const fresh = () => new Matcher([...SCRIPT]);

test('seek re-anchors and clamps the cursor', () => {
  const m = fresh();
  assert.equal(m.seek(12), 12);
  assert.equal(m.seek(-10), 0);
  assert.equal(m.seek(999), SCRIPT.length - 1);
});

test('feed needs at least two spoken words', () => {
  const m = fresh();
  assert.equal(m.feed('alpha'), null);
  assert.equal(m.cursor, 0);
});

test('feed advances the cursor to the end of a forward match', () => {
  const m = fresh();
  assert.equal(m.feed('alpha bravo charlie'), 2); // cursor lands on "charlie"
  assert.equal(m.cursor, 2);
});

test('a wrong trailing ASR word does not invalidate a confident phrase', () => {
  const m = new Matcher(['welcome', 'to', 'cue', 'good', 'evening']);

  assert.equal(m.feed('welcome to queue'), 1);
  assert.equal(m.cursor, 1);
});

test('reading forward tracks monotonically', () => {
  const m = fresh();
  m.feed('alpha bravo charlie');
  const first = m.cursor;
  m.feed('delta echo foxtrot');
  assert.ok(m.cursor > first, `cursor should advance (${first} -> ${m.cursor})`);
  m.feed('golf hotel india');
  assert.ok(m.cursor >= 8);
});

test('small backward wobble (<= BACK_TOL) is ignored', () => {
  const m = fresh();
  m.feed('lima mike november'); // ~index 13
  const held = m.cursor;
  assert.ok(held >= 12);
  const idx = m.feed('kilo lima mike'); // aligns a word or two back
  assert.equal(idx, held, 'should hold, not scroll backward');
  assert.equal(m.cursor, held);
});

test('large backward jump (> BACK_TOL) is honored as a re-read', () => {
  const m = fresh();
  m.feed('oscar papa quebec'); // ~index 16
  assert.ok(m.cursor >= 15);
  m.feed('alpha bravo charlie'); // genuine jump back to the top
  assert.ok(m.cursor <= 3, `should jump back (cursor ${m.cursor})`);
});

test('gibberish does not move the cursor', () => {
  const m = fresh();
  m.feed('alpha bravo charlie');
  const held = m.cursor;
  assert.equal(m.feed('xyzzy plugh frobnitz'), null);
  assert.equal(m.cursor, held);
});
