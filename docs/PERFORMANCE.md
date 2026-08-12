# NIGHTGLASS hardware performance protocol

The release profile must be captured on an RTX 3060-class desktop running a
headed Chromium window at 2560×1440 with the High quality profile. Build and
serve the production bundle, then run the built-in collector from another
terminal. Record the installed GPU driver version exactly as reported by the
operating system:

```bash
npm run build
npm run preview -- --host 127.0.0.1
PERF_DRIVER="replace-with-installed-driver-version" \
  PERF_CHROMIUM_EXECUTABLE="/path/to/chromium" \
  npm run qa:performance:capture
```

The collector refuses to start unless the authored route is active, the
procedural fallback is hidden, the viewport and High profile are exact, the
unmasked WebGL renderer identifies an RTX 3060-class device, and
`EXT_disjoint_timer_query_webgl2` has a usable counter. It warms for 60 seconds
and records for 601 seconds so the retained samples prove a complete
600-second interval. It refuses to overwrite an existing evidence directory.

Each frame in `artifacts/performance/high-1440p.samples.ndjson` uses this
schema:

```json
{"timestampMs":0,"frameMs":16.1,"gpuMs":10.2,"mainThreadMs":6.4,"drawCalls":420,"triangles":2100000,"gpuDisjoint":false}
```

The browser measures GPU time around the complete world and viewmodel render,
while main-thread time covers the full animation-frame callback. Draw calls
and triangles come from the same rendered frame. GPU asset bytes are estimated
from unique resident scene geometry buffers, skeleton textures, material
textures and mip payloads, excluding transient render targets.

The collector writes `high-1440p.json` itself, including the unmasked WebGL
vendor/device, CPU model, build hash, raw-evidence hash, exact runtime mode,
asset-memory estimate and recomputed summary. The
[report template](PERFORMANCE-REPORT.template.json) documents the generated
schema; it is not a substitute for running the collector.

`npm run qa:performance` re-hashes both artifacts, parses every raw frame,
recomputes duration, sustained FPS, p95/p99-derived timings, medians and peaks,
and compares them to the report. It also calculates compressed payload size
directly from required files in `public/assets/manifest.json`. Hand-entered
summary numbers without the matching raw evidence cannot pass.

```bash
npm run qa:performance
```

## How the procedural fallback is kept inside the draw budget

The fallback route is authored as deep hierarchies of small primitives, which
would otherwise submit one draw per piece. Nothing about that authoring changed;
what reaches the renderer is batched instead:

- The arena stages every static surface and bakes it into one mesh per
  material, shadow flag, render order and region, with distant lit windows and
  the street practicals' additive halos drawn as instanced batches.
- Hostiles and the first-person weapon are collapsed by
  `src/engine/StaticBatching.ts`, which merges everything hanging off an
  animated part into one mesh per render state. Untextured surfaces that differ
  only by colour, roughness and metalness are merged further: those three values
  are baked per vertex and read back in the shader, so one draw shades what used
  to be several materials.
- A hostile keeps one shadow caster per articulated part, leaves the shadow map
  entirely past 34 m, and drops its merged dressing past 26 m. Beyond the
  hostiles the player is engaging, the squad hands full dressing to the nearest
  few and renders the rest as silhouettes.

Draw calls in the schema above count the shadow pass as well as the colour pass,
so these are the numbers the 450 typical / 700 peak ceilings apply to.
`tests/qa/DrawBudget.test.ts` pins the per-hostile and per-weapon submission
counts so a regression back to one draw per piece fails the suite rather than
the capture.

`PERF_HEADLESS=1` is available for diagnostic runs, but a release run remains
valid only when Chromium exposes the real RTX renderer and timer query rather
than a software renderer. `PERF_CAPTURE_TEST_MODE=1` permits a short collector
smoke test; its duration cannot pass the release verifier.
