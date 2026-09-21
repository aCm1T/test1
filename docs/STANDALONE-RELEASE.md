# Standalone browser release

The standalone profile is the distributable version of the current procedural NIGHTGLASS mission. It is separate from the stricter authored-asset profile in `RELEASE-REVIEW.md`.

## Approval command

```bash
npm ci
npm run release:standalone
```

The command fails closed when a required asset is missing, a manifest byte count is stale, source code contains a deployment-base-unsafe `/assets/` URL, tests fail, a production resource returns an error, a runtime exception occurs, the QA mutation API is present, either `/` or `/test1/` is untested, or the evidence source hash is stale. Each subprocess has a finite twelve-minute limit and browser stages print progress.

The smoke run covers menu readiness, the keyboard listbox, normal Play, simultaneous forward/sprint input, ADS, weapon switching, reload, grenade input, Escape pause and Resume at 1280×720, 1920×1080 and a 3440×1440 CSS viewport. The ultrawide CI check uses device scale factor 0.5 because SwiftShader raster cost is not hardware performance evidence.

## Known evidence boundary

Automated smoke evidence does not claim a human full-mission playthrough or target-hardware FPS result. The mission state machine, checkpoint restoration, deterministic replay, death flow and completion are covered by the automated integration suite. Before describing a public build as manually playtested, complete the five mission beats with ordinary controls, die and recover before and after the checkpoint, return to the menu, and start a second fresh run.

Optional software-renderer screenshots can be requested with `SMOKE_CAPTURE=1 npm run qa:standalone:smoke` while a production preview is running. They are visual diagnostics only.
