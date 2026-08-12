import crypto from 'node:crypto';
import fs from 'node:fs';

export const REVIEW_CATEGORIES = Object.freeze([
  'materials',
  'silhouette',
  'lighting',
  'composition',
  'animationVfx',
  'ui',
]);

export const INDEPENDENT_REVIEW_ATTESTATION =
  'I independently scored this blinded session without access to the answer key.';

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function digestJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function captureSetDigest(answerKey) {
  return digestJson(answerKey.map((answer) => ({
    targetAsset: answer.targetAsset,
    targetSha256: answer.targetSha256,
    matched: answer.matched,
  })).sort(compareRecords));
}

export function referenceSetDigest(answerKey) {
  return digestJson(answerKey.map((answer) => ({
    referenceId: answer.referenceId,
    referenceSha256: answer.referenceSha256,
    matched: answer.matched,
  })).sort(compareRecords));
}

export function validIsoTimestamp(value) {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function compareRecords(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
