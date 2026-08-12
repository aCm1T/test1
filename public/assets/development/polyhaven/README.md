# Poly Haven development material provenance

These files are CC0 development inputs for the procedural fallback scene only.
They are deliberately outside `public/assets/manifest.json`, are not part of the
NIGHTGLASS authored-asset contract, and must never be used to satisfy a release
capture or asset-quality gate.

Downloaded 2026-08-02 from Poly Haven under the [CC0 license](https://polyhaven.com/license):

- [Asphalt 01](https://polyhaven.com/a/asphalt_01): `asphalt_01_diff_1k.jpg`,
  `asphalt_01_nor_gl_1k.jpg`, and `asphalt_01_arm_1k.jpg`.
- [Concrete Floor](https://polyhaven.com/a/concrete_floor): `concrete_floor_diff_1k.jpg`,
  `concrete_floor_nor_gl_1k.jpg`, and `concrete_floor_arm_1k.jpg`.
- [Yellow Plaster](https://polyhaven.com/a/yellow_plaster): `yellow_plaster_diff_1k.jpg`,
  `yellow_plaster_nor_gl_1k.jpg`, and `yellow_plaster_arm_1k.jpg`.
- [Sunset JHBcentral](https://polyhaven.com/a/sunset_jhbcentral):
  `sunset_jhbcentral_2k.hdr` (development lighting source; not loaded by this
  fallback material integration).

`*_diff_*` is sRGB albedo. `*_nor_gl_*` and `*_arm_*` are linear data textures;
the runtime configures repeat, mipmapping, and device-limited anisotropy before
assigning them to the fallback materials. Poly Haven's ARM encoding stores
occlusion, roughness, and metallic values in RGB respectively.
