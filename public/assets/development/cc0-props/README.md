# Poly Haven CC0 development prop provenance

These glTF packages are development-only dressing for the procedural fallback
scene. They are deliberately outside `public/assets/manifest.json`; they are
not part of the NIGHTGLASS authored-asset contract and cannot satisfy a release
capture or visual-quality gate.

Downloaded 2026-08-04 from Poly Haven. Poly Haven publishes its assets under
[CC0](https://polyhaven.com/license). The original files are structured glTF
2.0 packages, not standalone GLB files: keep each descriptor, `.bin`, and
`textures/` directory together so its relative URIs resolve.

## Barrel 01

- Asset page: <https://polyhaven.com/a/Barrel_01>
- Official API metadata/package index: <https://api.polyhaven.com/files/Barrel_01>
- Source descriptor: <https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/Barrel_01/Barrel_01_1k.gltf>
- Source binary: <https://dl.polyhaven.org/file/ph-assets/Models/gltf/4k/Barrel_01/Barrel_01.bin>
- Source textures: <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/Barrel_01/Barrel_01_explosive_diff_1k.jpg>, <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/Barrel_01/Barrel_01_explosive_nor_gl_1k.jpg>, and <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/Barrel_01/Barrel_01_explosive_arm_1k.jpg>
- Asset page metadata: Jorge Camacho; 0.9 m tall; 3K triangles; 48 px/cm.
- Runtime entry point: `Barrel_01_1k.gltf`.

## Plastic Crate 02

- Asset page: <https://polyhaven.com/a/plastic_crate_02>
- Official API metadata/package index: <https://api.polyhaven.com/files/plastic_crate_02>
- Source descriptor: <https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/plastic_crate_02/plastic_crate_02_1k.gltf>
- Source binary: <https://dl.polyhaven.org/file/ph-assets/Models/gltf/4k/plastic_crate_02/plastic_crate_02.bin>
- Source textures: <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/plastic_crate_02/plastic_crate_02_diff_1k.jpg>, <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/plastic_crate_02/plastic_crate_02_nor_gl_1k.jpg>, and <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/plastic_crate_02/plastic_crate_02_arm_1k.jpg>
- API metadata: 5,840 triangles; 505.5 x 405.5 x 254.1 mm (X x Y x Z).
- Runtime entry point: `plastic_crate_02/plastic_crate_02_1k.gltf`.

## Utility Box 01

- Asset page: <https://polyhaven.com/a/utility_box_01>
- Official API metadata/package index: <https://api.polyhaven.com/files/utility_box_01>
- Source descriptor: <https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/utility_box_01/utility_box_01_1k.gltf>
- Source binary: <https://dl.polyhaven.org/file/ph-assets/Models/gltf/8k/utility_box_01/utility_box_01.bin>
- Source textures: <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/utility_box_01/utility_box_01_diff_1k.jpg>, <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/utility_box_01/utility_box_01_nor_gl_1k.jpg>, and <https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/utility_box_01/utility_box_01_arm_1k.jpg>
- API metadata: 4,404 triangles; 520.0 x 432.0 x 1,120.3 mm (X x Y x Z).
- Runtime entry point: `utility_box_01/utility_box_01_1k.gltf`.

## Exterior Aircon Unit

- Asset page: <https://polyhaven.com/a/exterior_aircon_unit>
- Official API metadata/package index: <https://api.polyhaven.com/files/exterior_aircon_unit>
- Source descriptor: <https://dl.polyhaven.org/file/ph-assets/Models/gltf/1k/exterior_aircon_unit/exterior_aircon_unit_1k.gltf>
- Source binary: <https://dl.polyhaven.org/file/ph-assets/Models/gltf/4k/exterior_aircon_unit/exterior_aircon_unit.bin>
- Source textures: the twelve `.jpg` maps listed in the 1K `gltf.include` package index above. They are retained unchanged in `exterior_aircon_unit/textures/`, because the descriptor references clean and weathered material variants, including alpha-blended grille maps.
- Asset page metadata: Monsta3D; 1.8 m wide; 19K triangles; 28.1 px/cm.
- Runtime entry point: `exterior_aircon_unit/exterior_aircon_unit_1k.gltf`.

The unit is staged once as a paired clean/weathered roof-service assembly on
the fallback South Shop only. Its scene instances are marked visual-only by
`DevelopmentPropLayer`; they own no collision, cover, navigation, or authored
asset-contract data.

The `*_diff_*` maps are sRGB albedo. `*_nor_gl_*` and `*_arm_*` are linear
data maps; the latter uses ambient occlusion, roughness, and metallic values in
RGB respectively.
