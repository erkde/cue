import { pathToFileURL } from 'node:url';
import { ASR_MODEL_ID, ASR_MODEL_REVISION } from '../js/constants.js';

const revisionPattern = /^[a-f\d]{40}$/;
const ansi = {
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  heading: '\u001b[1;33m',
  reset: '\u001b[0m',
  yellow: '\u001b[33m',
};

const paint = (text, code, enabled) => (enabled && code ? `${code}${text}${ansi.reset}` : text);

export function shouldUseColor({ env = process.env, isTTY = process.stdout.isTTY } = {}) {
  if (Object.hasOwn(env, 'NO_COLOR')) return false;
  if (Object.hasOwn(env, 'FORCE_COLOR')) return env.FORCE_COLOR !== '0';
  return Boolean(isTTY);
}

export function modelInfoUrl(modelId) {
  const path = modelId.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/api/models/${path}`;
}

export function formatModelCheck(
  { modelId, pinnedRevision, latestRevision, lastModified },
  { color = false } = {},
) {
  const current = pinnedRevision === latestRevision;
  const field = (label, value, valueColor) =>
    `${paint(label.padEnd(15), ansi.cyan, color)}${paint(value, valueColor, color)}`;
  return [
    paint('Cue speech model', ansi.heading, color),
    '',
    field('Model:', modelId),
    field('Pinned:', pinnedRevision, current ? null : ansi.yellow),
    field('Latest main:', latestRevision, ansi.green),
    field('Last modified:', lastModified ?? 'unknown'),
    field('Status:', current ? 'current' : 'update available', current ? ansi.green : ansi.yellow),
    '',
    current
      ? 'The pinned model matches the latest upstream revision.'
      : 'The pinned model remains active. Review and test before updating.',
    field('History:', `https://huggingface.co/${modelId}/commits/main`),
  ].join('\n');
}

export async function checkModel({
  fetchImpl = fetch,
  write = console.log,
  timeoutMs = 10_000,
  color = false,
} = {}) {
  const response = await fetchImpl(modelInfoUrl(ASR_MODEL_ID), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Hugging Face returned ${response.status} ${response.statusText}`.trim());
  }

  const info = await response.json();
  if (!revisionPattern.test(info.sha ?? '')) {
    throw new Error('Hugging Face did not return a valid model revision');
  }

  const result = {
    modelId: ASR_MODEL_ID,
    pinnedRevision: ASR_MODEL_REVISION,
    latestRevision: info.sha,
    lastModified: info.lastModified,
  };
  write(formatModelCheck(result, { color }));
  return { ...result, current: ASR_MODEL_REVISION === info.sha };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  checkModel({ color: shouldUseColor() }).catch((error) => {
    console.error(`Model check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
