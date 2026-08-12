# NIGHTGLASS release review — 2026-07-30

## Result: BLOCKED — do not commit or publish

The implementation foundation builds, its deterministic automated suite
passes, and the production bundle survives Chromium quick/debug captures. It
is not a releasable NIGHTGLASS vertical slice because the user-supplied source
package and legal reference set are absent. Runtime therefore deliberately
shows the detectable procedural development fallback, which is an explicit
release blocker.

## Engineering progress since last review

Work since the 2026-07-30 review hardened systems and QA gates. It does not
clear the release blocker.

- Static draw-budget batching for the procedural fallback (see
  `docs/PERFORMANCE.md`); release figures still require a fresh reference-
  hardware recapture before quoting.
- Move-and-fire / sprint-cancel gunfeel coverage so firing and sprint
  cancellation stay consistent under fixed-tick input.
- Grenade kill accounting wired through combat/mission reporting.
- Deterministic RNG fork streams for presentation vs simulation isolation.
- Fail-closed `npm run qa:release` readiness gate; capture matrix and blind-
  review gates hardened against missing, fallback, or tampered evidence.
- Dev capture path: `npm run qa:capture:matrix:dev` for non-release matrix
  runs.

Still absent: authored assets in all five `assets/source/` groups, a contract-
valid `public/assets/manifest.json`, and the 12 legal matched references. No
superiority claim over Call of Duty is made or permitted.

## Engineering evidence

- `npm test -- --run`: 19 files, 74 passing tests after the final implementation
  audit.
- `npm run build`: TypeScript and the production Vite build pass.
- `git diff --check`: pass.
- Two fresh independent production Chromium quick captures at 640×360: menu,
  world-only spawn, and full-HUD spawn complete with no page, console, or
  request errors. All four corresponding PNG pairs have identical SHA-256
  hashes after deterministic SSAO noise and QA temporal freezing are applied.
- Production Chromium debug capture at 640×360: albedo, normals, ORM, depth,
  and shadow-cascade buffers complete with no page, console, or request
  errors.
- A production Chromium fixed-input smoke run advances exactly 30 ticks,
  applies the expected 0.043-radian sampled look delta, moves 3.396 m, consumes
  one grenade press exactly once across three ticks, and advances a nearby,
  unobstructed jammer interaction to defense with no page/console/request
  failures.
- A production Chromium checkpoint audit proves byte-for-byte equality after
  restoring the real player, inventory, weapon cooldown/reload/ADS/recoil/RNG,
  grenade count, mission, encounter and AI snapshot, followed by identical
  state after replaying the same 30-tick input sequence twice. This audit found
  and corrected a negative cooldown normalization mismatch before passing.
- The capture-state isolation audit proves extraction reaches `complete` and a
  following death scenario independently reaches `failed`; mission, player,
  weapon, grenade, enemy, RNG and HUD state no longer leak between captures.
- The dedicated 58° viewmodel camera dynamically measures 21.72% hip-fire
  frame occupancy and 0 px ADS reticle error at the 1080p reference scale.
  The measurement no longer trusts hard-coded values or the world camera.
- The capture report explicitly records `assetMode: "unloaded"` and
  `proceduralFallbackVisible: true`; it cannot be mistaken for a release pass.
  The fallback also records 2,345 draw calls in the sampled frame and a 3,549
  peak, far beyond the 700-call release ceiling. That sample predates the static
  batching pass described in `docs/PERFORMANCE.md`; the fallback has to be
  recaptured on the reference hardware before any new figure is quoted here.

The automated suite covers fixed-tick system ordering; ten deterministic
10-minute simulations and replays; full world/checkpoint restoration; seeded
weapon records; Rapier movement, shared static queries, character filtering,
world-transformed authored triangle colliders (including proof that empty
space inside their AABB is not falsely solid), correctly dimensioned
1.8 m/1.1 m stand/crouch capsules, blocked stand-up, muzzle obstruction,
grenade CCD and splash occlusion; capsule-validated navigation reachability;
exclusive/restorable cover reservations; mission encounter gates; authored
LOD/collision/navigation/cover extraction; authored viewmodel and hostile
animation replacement; enemy reload state; strict asset provenance,
compression/capability/payload validation; actual GLB Meshopt/skin/clip/UV/PBR,
node-level GPU-instancing and KTX2 DFD inspection; actual reference dimensions
and crop metadata; fixed-tick capture of pointer, held, and one-shot weapon,
movement, grenade, and interaction inputs; Rapier-owned interaction range and
occlusion; player stance/motion, weapon cooldown/recoil and bounded AI firing
slot restoration; fixed-tick death/checkpoint recovery without wall-clock
timers; and two-round three-reviewer blind score enforcement.

Release-evidence tests also prove that the capture gate binds all 117 PNGs and
three renderer reports to a native-resolution visual inspection and rejects a
post-review byte change; the performance gate recomputes every threshold from
36,001 hashed per-frame samples spanning 600 seconds and rejects a tampered
summary, fallback runtime, or non-required runtime asset. The browser profiler
test covers WebGL2 query lifecycle, asynchronous result draining, frame
association, nanosecond conversion and unmasked hardware identity. The
blind-review gate hashes every paired image, preserves
content-set identity across fresh random seeds, reevaluates both raw rounds,
and rejects modification of a prior-round pair.

## Asset-driven path implemented but not activatable

When a complete contract-valid manifest is supplied, the route switches as a
single transaction: all 12 environment LODs, three UV1 lightmaps, four hero
PBR textures, rifle/arms, two hostile archetypes, dusk HDR, street/warehouse
reflection probes, 11 audio roles, authored collision, navigation nodes, and
cover slots must load before the procedural world is hidden. Runtime evidence
also requires at least three instanced meshes/six instances, three lightmapped
materials, one genuinely emissive material, complete rigged clips and an
authored `ADS_RETICLE` marker. Authored presentation now also waits for Rapier
initialization, and release captures must prove that every extracted collision
marker is installed as a live trimesh. Authored collision-marker geometry is
transformed from GLB LOD0 meshes into Rapier trimeshes; stored bounds exist
only for the explicit procedural fallback. Any load, annotation, animation,
physics-query, or Rapier reachability failure rolls the whole presentation and
physics route back to that fallback.

The runtime also has separate world/viewmodel scenes and cameras, profile-owned
CSM cascades, High/Ultra SSAO, world-height fog, damage-only chromatic aberration,
quality-controlled render scale/anisotropy/particles/LOD, deterministic
presentation RNG streams, render interpolation, debug buffers, renderer
statistics, complete capture-matrix verification, an RTX 3060-class hardware
collector/report gate with per-frame WebGL2 timer queries and scene-asset byte
estimation, SHA-256-bound per-image visual inspection, and deterministic
blind-review tooling.

## Blocking gates

`npm run qa:assets` fails with concrete evidence:

- `assets/source/environment`, `viewmodel`, `characters`, `audio`, and
  `references` contain no supplied source files.
- `public/assets/manifest.json` contains none of the required route,
  viewmodel, character, HDR/probe/texture/lightmap, or audio runtime IDs and no matching
  provenance/license/capability records.
- There are 0 of the required 12 legal matched reference captures.

As a result:

- the authored no-fallback 1080p, 1440p, and 3440×1440 capture matrix cannot be
  produced or bound to the required 117-image native-resolution inspection for
  UV seams, close-range tiling, leaks,
  z-fighting, floating props, LOD pop, clipped highlights, crushed subjects,
  or alpha sorting;
- the High preset cannot be benchmarked for 10 minutes on an RTX 3060-class
  Chromium desktop, so FPS, p95, GPU/main-thread time, 1% low, draw/triangle
  budgets, and GPU memory have not passed. The local software renderer also
  correctly exposes no release timer-query support, so it cannot masquerade as
  target hardware;
- `npm run qa:review:prepare` correctly refuses to create randomized pairs,
  and no three-reviewer scores or two consecutive fresh review rounds exist.

No missing measurements, reviewer scores, visual approvals, or asset licenses
have been invented. No superiority claim over Call of Duty is made or
permitted.

## Required external handoff

1. Supply the licensed source files and provenance in all five
   `assets/source/` groups, every strict runtime ID described by
   `public/assets/manifest.template.json`, and 12 legal matched references with
   actual FOV/resolution/scenario/crop metadata.
2. Run `npm run qa:assets` until it passes, build the full capture matrix, then
   run `npm run qa:visual:prepare`. Inspect every generated image at native
   resolution, complete the bound checklist, and pass
   `npm run qa:capture:verify`.
3. On an RTX 3060-class system, run `npm run qa:performance:capture` against
   the production High/2560×1440 Chromium profile, then pass
   `npm run qa:performance` as described in `docs/PERFORMANCE.md`.
4. Conduct and pass two fresh blind rounds using `docs/BLIND-REVIEW.md`.

The user's instruction allows committing and pushing directly to `main` only
after that release review passes. It does not pass, so no commit or push is
performed.
