import test from 'node:test';
import assert from 'node:assert/strict';
import { ASR_MODEL_ID, ASR_MODEL_REVISION } from '../js/constants.js';
import {
  checkModel,
  formatModelCheck,
  modelInfoUrl,
  shouldUseColor,
} from '../scripts/check-model.js';

test('builds the Hugging Face model information URL', () => {
  assert.equal(
    modelInfoUrl('owner/model name'),
    'https://huggingface.co/api/models/owner/model%20name',
  );
});

test('reports when the pinned model is current', async () => {
  let output = '';
  const result = await checkModel({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ sha: ASR_MODEL_REVISION, lastModified: '2025-01-17T00:00:00Z' }),
      ),
    write: (text) => {
      output = text;
    },
  });

  assert.equal(result.current, true);
  assert.match(output, new RegExp(`Model:\\s+${ASR_MODEL_ID}`));
  assert.match(output, /Status:\s+current/);
});

test('reports an available model update without changing the pin', async () => {
  const latestRevision = 'b'.repeat(40);
  const output = formatModelCheck({
    modelId: ASR_MODEL_ID,
    pinnedRevision: ASR_MODEL_REVISION,
    latestRevision,
    lastModified: '2026-08-02T00:00:00Z',
  });

  assert.match(output, new RegExp(`Pinned:\\s+${ASR_MODEL_REVISION}`));
  assert.match(output, new RegExp(`Latest main:\\s+${latestRevision}`));
  assert.match(output, /Status:\s+update available/);
  assert.match(output, /Review and test before updating/);
});

test('uses terminal colours only when supported', () => {
  const model = {
    modelId: ASR_MODEL_ID,
    pinnedRevision: ASR_MODEL_REVISION,
    latestRevision: ASR_MODEL_REVISION,
    lastModified: '2026-08-02T00:00:00Z',
  };

  assert.doesNotMatch(formatModelCheck(model), /\u001b\[/);
  assert.match(formatModelCheck(model, { color: true }), /\u001b\[/);
  assert.equal(shouldUseColor({ env: {}, isTTY: true }), true);
  assert.equal(shouldUseColor({ env: { NO_COLOR: '' }, isTTY: true }), false);
  assert.equal(shouldUseColor({ env: { FORCE_COLOR: '1' }, isTTY: false }), true);
});

test('rejects an invalid upstream response', async () => {
  await assert.rejects(
    checkModel({
      fetchImpl: async () => new Response(JSON.stringify({ sha: 'main' })),
      write: () => {},
    }),
    /valid model revision/,
  );
});
