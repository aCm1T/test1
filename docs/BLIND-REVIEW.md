# NIGHTGLASS blind-review protocol

References are legal gap-scoring tools only. Reviewers must not be told which
image is the NIGHTGLASS target, must not identify products, and must not make a
superiority claim.

After the complete 1080p/1440p/ultrawide matrix exists and every reference
manifest entry names its matching `captureScenario`, prepare a round with:

```bash
REVIEW_ROUND=round-1 REVIEW_SEED=714 npm run qa:review:prepare
```

Each reference entry must also record the legally prepared source crop as
`reference.crop = { x, y, width, height }`. The supplied reference file must
already be exported at the declared matched resolution. Preparation reads both
PNG/JPEG headers and rejects a reference or target whose actual dimensions do
not match; it does not silently stretch or crop review images.

Preparation refuses to reuse a non-empty round directory and binds the session
ID to SHA-256 digests of every target/reference pair. Keep `answer-key.json`
away from reviewers. Give three independent reviewers `review-session.json`,
the randomized pair directories, and separate copies of the embedded score
template. Each reviewer must preserve the session ID, add a real ISO UTC
completion time, and retain the independent-review attestation. Put the
completed files in the round's `scores/` directory. Each reviewer scores both
A and B from 1–5 for materials,
silhouette, lighting, composition, animation/VFX, and UI, plus concrete visual
blockers.

Validate the first round, then repeat with a fresh seed and untouched captures:

```bash
REVIEW_OUTPUT=artifacts/blind-review/round-1 npm run qa:review:score
REVIEW_ROUND=round-2 REVIEW_SEED=8921 npm run qa:review:prepare
REVIEW_OUTPUT=artifacts/blind-review/round-2 \
PREVIOUS_REVIEW_OUTPUT=artifacts/blind-review/round-1 \
npm run qa:review:score
```

A single round needs zero blockers, every target category at least 4.0, and a
weighted mean at least 4.3. The second round re-hashes every pair and re-scores
the previous round from its original session, answer key and three score files;
it does not trust a previous `summary.json`. The release gate passes only when
two sequential sessions use distinct seeds, the same untouched capture and
reference sets, and independently satisfy all three thresholds.
