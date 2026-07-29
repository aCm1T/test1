# BLACKOPS: FRONTLINE

Browser-based dusk urban FPS built with **Three.js** + TypeScript + Vite.

A polished procedural tech demo: pointer-lock gunplay, hitscan weapons, enemy waves, VFX, HUD, and cinematic post-processing. It is **not** a shipping Call of Duty title — assets are procedural primitives — but it targets readable MW-style dusk combat in the browser.

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
| Mouse | Look |
| LMB | Fire |
| RMB | ADS |
| R | Reload |
| 1 / 2 / 3 | AR / Pistol / Knife |
| Scroll | Cycle weapons |
| Esc | Release pointer / pause menu |

## Stack

- `three` — WebGL renderer, PBR materials, shadows
- `postprocessing` — bloom, vignette, chromatic aberration, SMAA, film grain
- Procedural Web Audio — gunshots, footsteps, hitmarkers, ambient wind
- HTML HUD — compass, vitals, ammo, killfeed, crosshair

## Scripts

```bash
npm run dev       # Vite dev server
npm run build     # Typecheck + production bundle
npm run preview   # Serve dist/
```
