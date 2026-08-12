# NIGHTGLASS source-asset handoff

This directory intentionally contains no substitute commercial assets. Put the
licensed, browser-distributable source package here before producing a release:

- `environment/` — modular street/intersection/warehouse, cover, debris, lamps, vehicles and decals.
- `viewmodel/` — rigged arms/rifle plus fire, reload, ADS, sprint and melee clips.
- `characters/` — two hostile archetypes with complete locomotion, reaction, firing, reload, death and cover clips.
- `audio/` — weapons, footsteps, impacts, ambience, UI and indoor/outdoor tails.
- `references/` — 12 legal, matched captures and a JSON record containing FOV, output resolution, scene type, capture scenario and source crop rectangle.

For each runtime file, record the source and distribution license in
`public/assets/manifest.json`, including `metadata.sourceRecord` and
`metadata.licenseRecord`. Hero `.glb` files must be Meshopt-compressed; normal
and ORM maps must be KTX2/UASTC; albedo and emissive maps must be KTX2/ETC1S.
The decoder/transcoder files must be copied to `public/assets/decoders/`.

The strict list of runtime IDs and metadata examples lives in
`public/assets/manifest.template.json`. Every runtime entry needs its actual
compressed `bytes` value and `"required": true`; the verifier compares every
fixed runtime ID with the file on disk and enforces the 300 MiB slice budget.
Omitting or clearing `required` cannot exclude an asset from performance
payload accounting.

The release verifier reads the payloads instead of trusting manifest claims.
Every hero primitive must contain `POSITION`, UV0, UV1 and tangents, use an
authored metal/rough PBR material and carry real `EXT_meshopt_compression`
data. `route-props-lod0/1/2` must also contain node-level
`EXT_mesh_gpu_instancing` for nodes whose names identify lamps, windows and
debris (for example `LAMP_instances`). The viewmodel and character files must contain a
real skin and named clips for every declared role. The viewmodel additionally
needs a node named `ADS_RETICLE` (or `extras.adsReticle = true`) at the authored
sight alignment point.

Architecture uses UV1 for the three ETC1S baked-lightmap IDs:
`route-spawn-lightmap`, `route-intersection-lightmap` and
`route-warehouse-lightmap`. At least one authored material must preserve baked
AO and one must provide emissive-window evidence. KTX2 headers, compression
families, mip counts, audio signatures, and reference-image pixel dimensions
are checked from the actual files.

Authored LOD0 GLBs also carry the simulation annotations:

- collision meshes use a `COLLIDER_` name (or `userData.collision = true`),
  `userData.surface`, and contain actual indexed or non-indexed triangle
  geometry. LOD0 vertices are transformed into world space and installed as
  Rapier trimeshes; their AABBs are retained only for explicit fallback code;
- ground-positioned navigation nodes use `NAV_` names (or
  `userData.navigationNode`) and `userData.links` string arrays;
- ground-positioned reservable cover markers use `COVER_` names (or
  `userData.coverSlot`).

The asset route is rejected at runtime when these annotations are absent or
when Rapier capsule sweeps make the supplied navigation graph unreachable.
Reference images must already be legally cropped/exported to their declared
matched resolution; the crop rectangle records that preprocessing and the
blind-review script rejects either image when its real pixel dimensions differ.
