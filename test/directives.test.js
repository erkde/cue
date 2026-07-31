import test from 'node:test';
import assert from 'node:assert/strict';
import {
  directiveIdsBefore,
  isCueDirectiveLine,
  measureDirectiveFiring,
  nextDirectiveAtOrBefore,
  parseCueDirective,
} from '../js/directives.js';

test('parses cue:stop with no attributes', () => {
  assert.deepEqual(parseCueDirective('<!-- cue:stop -->'), {
    action: 'stop',
    attributes: {},
  });
});

test('parses a quoted stop message', () => {
  assert.deepEqual(parseCueDirective('  <!-- cue:stop message="Wait for applause" -->  '), {
    action: 'stop',
    attributes: { message: 'Wait for applause' },
  });
});

test('parses escaped characters in attribute values', () => {
  assert.deepEqual(parseCueDirective('<!-- cue:stop message="Speaker says \\"go\\"" -->'), {
    action: 'stop',
    attributes: { message: 'Speaker says "go"' },
  });
});

test('ignores ordinary Markdown and HTML comments', () => {
  assert.equal(isCueDirectiveLine('ordinary text'), false);
  assert.equal(parseCueDirective('<!-- editorial note -->'), null);
});

test('reports malformed, duplicate, and unsupported attributes', () => {
  assert.match(parseCueDirective('<!-- cue:stop message=nope -->').error, /Malformed attributes/);
  assert.match(
    parseCueDirective('<!-- cue:stop message="one" message="two" -->').error,
    /Duplicate attribute/,
  );
  assert.match(
    parseCueDirective('<!-- cue:stop level="warning" -->').error,
    /Unsupported attribute/,
  );
});

test('reports unsupported actions', () => {
  assert.match(parseCueDirective('<!-- cue:next -->').error, /Unsupported Cue action/);
});

const DIRECTIVES = [
  { id: 0, action: 'stop', attributes: {}, afterWordIndex: 5 },
  { id: 1, action: 'stop', attributes: {}, afterWordIndex: 12 },
  { id: 2, error: 'bad directive', afterWordIndex: 15 },
];

test('selects the earliest unfired directive crossed by the cursor', () => {
  assert.equal(nextDirectiveAtOrBefore(DIRECTIVES, new Set(), 4), undefined);
  assert.equal(nextDirectiveAtOrBefore(DIRECTIVES, new Set(), 20)?.id, 0);
  assert.equal(nextDirectiveAtOrBefore(DIRECTIVES, new Set([0]), 20)?.id, 1);
  assert.equal(nextDirectiveAtOrBefore(DIRECTIVES, new Set([0, 1]), 20), undefined);
});

test('seeking establishes fired directives strictly before the new cursor', () => {
  assert.deepEqual([...directiveIdsBefore(DIRECTIVES, 12)], [0]);
  assert.deepEqual([...directiveIdsBefore(DIRECTIVES, 13)], [0, 1]);
  assert.deepEqual([...directiveIdsBefore(DIRECTIVES, 0)], []);
});

test('measures directive timing without including authored content', () => {
  const measurement = measureDirectiveFiring(
    {
      afterWordIndex: 142,
      attributes: { message: 'private authored message' },
    },
    146,
    140,
    620,
  );

  assert.deepEqual(measurement, {
    markerWord: 142,
    matchedWord: 146,
    overshootWords: 4,
    cursorJumpWords: 6,
    scriptWords: 620,
    markerPct: 23,
    hasMessage: true,
  });
  assert.ok(!JSON.stringify(measurement).includes('private authored message'));
});
