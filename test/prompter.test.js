import test from 'node:test';
import assert from 'node:assert/strict';
import { firstWordIndexAtOrBelow } from '../js/prompter.js';

const word = (offsetTop, offsetHeight = 20) => ({
  offsetTop,
  offsetHeight,
  getBoundingClientRect: () => ({ top: offsetTop, height: offsetHeight }),
});

test('selects the first word on the first line below the reading line', () => {
  const words = [word(100), word(100), word(140), word(140), word(180)];

  assert.equal(firstWordIndexAtOrBelow(words, 120), 2);
});

test('includes a word line centred exactly on the reading line', () => {
  const words = [word(100), word(100), word(140)];

  assert.equal(firstWordIndexAtOrBelow(words, 110), 0);
});

test('tolerates fractional layout differences at the reading line', () => {
  const words = [word(100), word(100), word(140)];

  assert.equal(firstWordIndexAtOrBelow(words, 110.5), 0);
});

test('uses the first word of the final line below the document', () => {
  const words = [word(100), word(140), word(140)];

  assert.equal(firstWordIndexAtOrBelow(words, 200), 1);
});

test('returns no reading-line anchor for an empty script', () => {
  assert.equal(firstWordIndexAtOrBelow([], 100), null);
});
