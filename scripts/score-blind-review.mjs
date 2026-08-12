import fs from 'node:fs';
import path from 'node:path';
import {
  INDEPENDENT_REVIEW_ATTESTATION,
  REVIEW_CATEGORIES,
  captureSetDigest,
  referenceSetDigest,
  sha256File,
  validIsoTimestamp,
} from './lib/nightglass-review-integrity.mjs';

const ROUND_DIR = path.resolve(process.env.REVIEW_OUTPUT ?? 'artifacts/blind-review/round-1');
const PREVIOUS_DIR = process.env.PREVIOUS_REVIEW_OUTPUT
  ? path.resolve(process.env.PREVIOUS_REVIEW_OUTPUT)
  : null;
const REQUIRED_PAIRS = 12;
const CATEGORIES = REVIEW_CATEGORIES;
const WEIGHTS = {
  materials: 0.2,
  silhouette: 0.15,
  lighting: 0.2,
  composition: 0.15,
  animationVfx: 0.2,
  ui: 0.1,
};

const current = evaluateRound(ROUND_DIR);
const previous = PREVIOUS_DIR ? evaluateRound(PREVIOUS_DIR) : null;
const consecutiveFreshRounds = Boolean(
  current.roundPass
  && previous?.roundPass
  && previous.sessionId !== current.sessionId
  && previous.round !== current.round
  && previous.seed !== current.seed
  && previous.captureSetDigest === current.captureSetDigest
  && previous.referenceSetDigest === current.referenceSetDigest
  && Date.parse(current.sessionCreatedAt) > Date.parse(previous.reviewCompletedAt),
);
const summary = {
  ...current,
  previousSessionId: previous?.sessionId ?? null,
  previousRound: previous?.round ?? null,
  consecutiveFreshRounds,
  releasePass: current.roundPass && consecutiveFreshRounds,
};
writeJson(path.join(ROUND_DIR, 'summary.json'), summary);
if (!summary.releasePass) {
  console.error('blind review release gate: BLOCKED');
  console.error(JSON.stringify(summary, null, 2));
  process.exit(1);
}
console.log(
  `blind review release gate: PASS (${current.sessionId}, weighted mean ${current.weightedMean.toFixed(3)})`,
);

function evaluateRound(roundDir) {
  const session = readJson(path.join(roundDir, 'review-session.json'));
  const key = readJson(path.join(roundDir, 'answer-key.json'));
  for (const field of [
    'sessionId', 'round', 'seed', 'createdAt', 'pairCount',
    'captureSetDigest', 'referenceSetDigest',
  ]) {
    if (session[field] !== key[field]) fail(`${roundDir}: session/key ${field} mismatch`);
  }
  if (!String(session.round ?? '').trim()) fail(`${roundDir}: round is required`);
  if (!Number.isSafeInteger(session.seed) || session.seed < 0 || session.seed > 0xffffffff) {
    fail(`${roundDir}: seed must be an unsigned 32-bit integer`);
  }
  if (!validIsoTimestamp(session.createdAt)) fail(`${roundDir}: invalid session createdAt`);
  if (!sameValues(session.categories, CATEGORIES)) fail(`${roundDir}: category contract mismatch`);
  if (
    session.pairCount !== REQUIRED_PAIRS
    || !Array.isArray(session.pairs)
    || session.pairs.length !== REQUIRED_PAIRS
    || !Array.isArray(key.answerKey)
    || key.answerKey.length !== REQUIRED_PAIRS
  ) fail(`${roundDir}: requires exactly ${REQUIRED_PAIRS} matched pairs`);
  const expectedSessionId = [
    session.round,
    session.seed.toString(16).padStart(8, '0'),
    session.captureSetDigest.slice(0, 12),
    session.referenceSetDigest.slice(0, 12),
  ].join('-');
  if (session.sessionId !== expectedSessionId) fail(`${roundDir}: sessionId is not bound to round/seed/content`);

  const pairByToken = new Map();
  for (const pair of session.pairs) {
    const token = String(pair?.token ?? '');
    if (!token || pairByToken.has(token)) fail(`${roundDir}: pair tokens must be unique and non-empty`);
    pairByToken.set(token, pair);
  }
  const answerTokens = new Set();
  const referenceIds = new Set();
  for (const answer of key.answerKey) {
    if (answerTokens.has(answer.token)) fail(`${roundDir}: duplicate answer token ${answer.token}`);
    if (!String(answer.referenceId ?? '').trim() || referenceIds.has(answer.referenceId)) {
      fail(`${roundDir}: reference IDs must be unique and non-empty`);
    }
    answerTokens.add(answer.token);
    referenceIds.add(answer.referenceId);
    if (
      !['A', 'B'].includes(answer.targetLabel)
      || !['A', 'B'].includes(answer.referenceLabel)
      || answer.targetLabel === answer.referenceLabel
    ) fail(`${roundDir}/${answer.token}: invalid hidden labels`);
    const pair = pairByToken.get(answer.token);
    if (!pair) fail(`${roundDir}: session is missing ${answer.token}`);
    if (JSON.stringify(pair.matched) !== JSON.stringify(answer.matched)) {
      fail(`${roundDir}/${answer.token}: matched metadata differs from the answer key`);
    }
    for (const label of ['A', 'B']) {
      const image = resolveRoundFile(roundDir, pair.images?.[label]);
      if (!fs.existsSync(image) || !fs.statSync(image).isFile()) {
        fail(`${roundDir}/${answer.token}/${label}: paired image is missing`);
      }
      const digest = sha256File(image);
      if (pair.digests?.[label] !== digest) {
        fail(`${roundDir}/${answer.token}/${label}: paired image digest changed after preparation`);
      }
      const hiddenDigest = label === answer.targetLabel
        ? answer.targetSha256
        : answer.referenceSha256;
      if (hiddenDigest !== digest) fail(`${roundDir}/${answer.token}/${label}: hidden content mapping mismatch`);
    }
  }
  if (pairByToken.size !== answerTokens.size) fail(`${roundDir}: session and answer tokens differ`);
  if (captureSetDigest(key.answerKey) !== session.captureSetDigest) {
    fail(`${roundDir}: target capture-set digest mismatch`);
  }
  if (referenceSetDigest(key.answerKey) !== session.referenceSetDigest) {
    fail(`${roundDir}: legal reference-set digest mismatch`);
  }

  const scoresDir = path.join(roundDir, 'scores');
  const scoreFiles = fs.existsSync(scoresDir)
    ? fs.readdirSync(scoresDir).filter((file) => file.endsWith('.json')).sort()
    : [];
  if (scoreFiles.length !== 3) fail(`${roundDir}: requires exactly three independent score files; found ${scoreFiles.length}`);
  const reviews = scoreFiles.map((file) => readJson(path.join(scoresDir, file)));
  const reviewerIds = new Set();
  const completionTimes = [];
  const totals = Object.fromEntries(CATEGORIES.map((category) => [category, []]));
  const blockers = [];
  const expectedTokens = [...answerTokens].sort();
  const now = Date.now() + 5 * 60 * 1000;
  for (const review of reviews) {
    const reviewerId = String(review.reviewerId ?? '').trim();
    if (!reviewerId || reviewerIds.has(reviewerId)) fail(`${roundDir}: reviewer IDs must be unique and non-empty`);
    reviewerIds.add(reviewerId);
    if (review.sessionId !== session.sessionId) fail(`${reviewerId}: score file belongs to another session`);
    if (review.independentReviewAttestation !== INDEPENDENT_REVIEW_ATTESTATION) {
      fail(`${reviewerId}: independent-review attestation is missing`);
    }
    if (!validIsoTimestamp(review.completedAt)) fail(`${reviewerId}: completedAt must be an ISO-8601 UTC timestamp`);
    const completedAt = Date.parse(review.completedAt);
    if (completedAt < Date.parse(session.createdAt) || completedAt > now) {
      fail(`${reviewerId}: completedAt is outside this session's valid review window`);
    }
    completionTimes.push(completedAt);
    if (!sameValues(Object.keys(review.pairs ?? {}).sort(), expectedTokens)) {
      fail(`${reviewerId}: score file pair set does not match the blinded session`);
    }
    for (const answer of key.answerKey) {
      const pair = review.pairs[answer.token];
      for (const label of ['A', 'B']) {
        if (!sameValues(Object.keys(pair?.[label] ?? {}).sort(), [...CATEGORIES].sort())) {
          fail(`${reviewerId}/${answer.token}/${label}: category set is incomplete`);
        }
        for (const category of CATEGORIES) {
          const score = pair[label][category];
          if (!Number.isFinite(score) || score < 1 || score > 5) {
            fail(`${reviewerId}/${answer.token}/${label}/${category}: score must be 1–5`);
          }
          if (label === answer.targetLabel) totals[category].push(score);
        }
      }
      if (!Array.isArray(pair.blockers)) fail(`${reviewerId}/${answer.token}: blockers must be an array`);
      for (const blocker of pair.blockers) {
        if (String(blocker).trim()) blockers.push({ reviewerId, pair: answer.token, blocker });
      }
    }
  }

  const categories = Object.fromEntries(CATEGORIES.map((category) => [
    category,
    average(totals[category]),
  ]));
  const weightedMean = CATEGORIES.reduce((sum, category) => (
    sum + categories[category] * WEIGHTS[category]
  ), 0);
  const roundPass = blockers.length === 0
    && CATEGORIES.every((category) => categories[category] >= 4)
    && weightedMean >= 4.3;
  return {
    sessionId: session.sessionId,
    round: session.round,
    seed: session.seed,
    sessionCreatedAt: session.createdAt,
    reviewCompletedAt: new Date(Math.max(...completionTimes)).toISOString(),
    reviewers: [...reviewerIds].sort(),
    pairCount: key.answerKey.length,
    captureSetDigest: session.captureSetDigest,
    referenceSetDigest: session.referenceSetDigest,
    categories,
    weights: WEIGHTS,
    weightedMean,
    blockers,
    roundPass,
  };
}

function resolveRoundFile(roundDir, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) fail(`${roundDir}: invalid pair image path`);
  const file = path.resolve(roundDir, relative);
  if (!file.startsWith(`${roundDir}${path.sep}`)) fail(`${roundDir}: pair image path escapes the round`);
  return file;
}

function sameValues(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function readJson(file) {
  if (!fs.existsSync(file)) fail(`missing ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`invalid JSON ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  console.error(`blind review release gate: BLOCKED — ${message}`);
  process.exit(1);
}
