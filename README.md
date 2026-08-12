# FRONTLINE: NIGHTGLASS

Browser-based grounded-modern dusk FPS vertical slice built with **Three.js**, TypeScript, and Vite.

The playable mission moves from first contact through an intersection assault, jammer shutdown, timed defense, and extraction. It includes deterministic fixed-step simulation, seeded perception-aware AI, pointer-lock gunplay, AR/pistol/knife combat, frag grenades, mantle/slide movement, checkpoint recovery, VFX, HUD, adaptive quality infrastructure, and cinematic post-processing. Pointer deltas, held controls, and one-shot actions are sampled into replayable fixed-tick `InputFrame`s; no weapon, grenade, or mission interaction mutates combat state directly from a DOM event.

The project is an original browser vertical slice, not a Call of Duty product. Current character, environment, and weapon geometry remains procedural and therefore below commercial AAA asset fidelity; it is an explicit development fallback only. The authored route loader, Meshopt/Draco/KTX2 pipeline, Rapier query adapter, `GameSession`, navigation graph, cover reservations, and deterministic checkpoint state are ready for the supplied asset package.

## Authored asset handoff and release gate

Place the licensed source package in `assets/source/{environment,viewmodel,characters,audio,references}` and record each distribution asset's source and license in `public/assets/manifest.json`. Hero GLBs must use real Meshopt bufferView payloads and node-level GPU instancing for named lamp/window/debris sets. Hero normal/ORM textures must use KTX2/UASTC; albedo/emissive and three UV1 architecture lightmaps must use KTX2/ETC1S. Rigged clips and the viewmodel `ADS_RETICLE` marker are inspected from the GLBs. Legal references must include FOV, resolution, scenario and crop metadata, and their real pixel dimensions are checked. The runtime route uses the authored modules when the contract passes and otherwise keeps the detectable procedural fallback.

```bash
npm run qa:assets
```

This command is expected to fail until all five source groups and 12 legally obtained matched reference captures are supplied. Do not publish while it fails; see [the release review](docs/RELEASE-REVIEW.md).

## Run

```bash
npm install
npm run dev
```

Open the local URL, click **PLAY**, then click the canvas for pointer lock.

## Controls

| Input | Action |
|-------|--------|
| WASD | Move |
| Shift | Sprint |
| Ctrl / C | Crouch |
| Space | Jump |
| Space at low ledge | Mantle |
| Ctrl / C while sprinting | Slide |
| Mouse | Look |
| LMB | Fire |
| RMB | ADS |
| R | Reload |
| G | Frag grenade |
| E / F | Interact / disable jammer |
| 1 / 2 / 3 | AR / Pistol / Knife |
| Scroll | Cycle weapons |
| Esc | Release pointer / pause menu |

## Stack

- `three` — WebGL renderer, PBR materials, shadows
- `postprocessing` — bloom, damage-only chromatic response, SSAO, SMAA, film grain
- `@dimforge/rapier3d-compat` — capsule movement, shared hitscan/LOS/surface/interaction queries, grenade bodies
- Supplied layered audio when the asset contract passes, with deterministic
  procedural Web Audio retained only as a development fallback
- HTML HUD — compass, vitals, ammo, killfeed, crosshair

## Scripts

```bash
npm run dev       # Vite dev server
npm run build     # Typecheck + production bundle
npm test          # Deterministic engine and mission tests
npm run preview   # Serve dist/
npm run qa:assets # Blocks release until the licensed asset handoff is complete
npm run qa:capture # Deterministic quick capture and renderer statistics
npm run qa:capture:matrix # Full resolution/scenario/debug capture matrix (release)
npm run qa:capture:matrix:dev # Full capture matrix without release-mode gates
npm run qa:visual:prepare # Bind a native-resolution visual checklist to exact capture bytes
npm run qa:capture:verify # Reject missing/fallback/over-budget/unreviewed capture sets
npm run qa:performance:capture # Generate hashed raw evidence on the target RTX/Chromium desktop
npm run qa:performance # Recompute the High/1440p gate from hashed raw hardware samples
npm run qa:review:prepare # Randomize matched legal A/B review pairs
npm run qa:review:score # Enforce three-reviewer and two-round score gates
npm run qa:release # Fail-closed release-readiness gate (assets, capture, performance, blind review)
```

Visual QA captures default to `artifacts/screenshots` and can be regenerated against the preview server with `node scripts/capture-screens.mjs`. Asset provenance is recorded in `public/assets/ASSET-LICENSES.md`.
The required ten-minute hardware evidence format is documented in
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).
