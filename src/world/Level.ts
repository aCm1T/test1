import * as THREE from 'three';
import { LevelTextureKit } from './Textures';

export type AABB = { min: THREE.Vector3; max: THREE.Vector3 };

const ARENA = 70;
const HALF = ARENA * 0.5;

/**
 * Dense original urban combat arena (~70u).
 * Cross-street layout with enterable structures, alleys, cover props,
 * rooftop access, and dusk-readable silhouettes on the perimeter.
 */
export class Level {
  readonly group = new THREE.Group();
  readonly colliders: AABB[] = [];
  readonly playerSpawn = new THREE.Vector3(0, 0, 28);
  readonly enemySpawns: THREE.Vector3[] = [];
  readonly coverNodes: THREE.Vector3[] = [];

  private readonly kit: LevelTextureKit;
  private readonly disposables: THREE.BufferGeometry[] = [];

  constructor(scene: THREE.Scene) {
    this.group.name = 'UrbanCombatLevel';
    this.kit = new LevelTextureKit();
    scene.add(this.group);

    this.buildGround();
    this.buildRoadMarkings();
    this.buildCurbsAndStreetFurniture();
    this.buildPerimeterWalls();
    this.buildBuildings();
    this.buildAlleysAndCover();
    this.buildVehicles();
    this.buildCratesAndDebris();
    this.buildStairsAndRooftop();
    this.buildPerimeterSilhouettes();
    this.placeSpawnsAndCover();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        const geo = mesh.geometry;
        if (geo && !this.disposables.includes(geo)) geo.dispose();
      }
    });
    for (const g of this.disposables) g.dispose();
    this.kit.dispose();
    this.colliders.length = 0;
    this.enemySpawns.length = 0;
    this.coverNodes.length = 0;
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private box(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    opts: { collide?: boolean; cast?: boolean; receive?: boolean; rotY?: number } = {},
  ): THREE.Mesh {
    const geo = new THREE.BoxGeometry(w, h, d);
    this.disposables.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    if (opts.rotY) mesh.rotation.y = opts.rotY;
    mesh.castShadow = opts.cast !== false;
    mesh.receiveShadow = opts.receive !== false;
    this.group.add(mesh);

    if (opts.collide !== false) {
      this.addCollider(w, h, d, x, y, z, opts.rotY ?? 0);
    }
    return mesh;
  }

  private addCollider(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rotY = 0,
  ): void {
    // Approximate rotated boxes with axis-aligned bounds (props are mostly axis-aligned).
    const c = Math.abs(Math.cos(rotY));
    const s = Math.abs(Math.sin(rotY));
    const hw = (w * c + d * s) * 0.5;
    const hd = (w * s + d * c) * 0.5;
    const hh = h * 0.5;
    this.colliders.push({
      min: new THREE.Vector3(x - hw, y - hh, z - hd),
      max: new THREE.Vector3(x + hw, y + hh, z + hd),
    });
  }

  private coverAt(x: number, y: number, z: number): void {
    this.coverNodes.push(new THREE.Vector3(x, y, z));
  }

  // ── ground / streets ─────────────────────────────────────────────────

  private buildGround(): void {
    const asphalt = this.kit.matAsphalt;
    const concrete = this.kit.matConcrete;
    const dirt = this.kit.matDirt;

    // Main asphalt plane
    const ground = this.box(ARENA, 0.2, ARENA, 0, -0.1, 0, asphalt, {
      collide: true,
      cast: false,
    });
    ground.name = 'GroundAsphalt';

    // Sidewalk strips along N-S street (X corridors)
    const swH = 0.18;
    this.box(3.2, swH, 52, -7.6, swH * 0.5, 0, concrete, { cast: false });
    this.box(3.2, swH, 52, 7.6, swH * 0.5, 0, concrete, { cast: false });

    // E-W street sidewalks
    this.box(40, swH, 3.2, 0, swH * 0.5, -7.6, concrete, { cast: false });
    this.box(40, swH, 3.2, 0, swH * 0.5, 7.6, concrete, { cast: false });

    // Corner plaza pads at intersection
    this.box(3.5, swH, 3.5, -7.6, swH * 0.5, -7.6, concrete, { cast: false });
    this.box(3.5, swH, 3.5, 7.6, swH * 0.5, -7.6, concrete, { cast: false });
    this.box(3.5, swH, 3.5, -7.6, swH * 0.5, 7.6, concrete, { cast: false });
    this.box(3.5, swH, 3.5, 7.6, swH * 0.5, 7.6, concrete, { cast: false });

    // Dirt patches in alleys / broken curb
    this.box(4, 0.12, 8, -18, 0.06, 18, dirt, { collide: false, cast: false });
    this.box(6, 0.12, 4, 20, 0.06, -16, dirt, { collide: false, cast: false });
    this.box(5, 0.12, 5, -22, 0.06, -20, dirt, { collide: false, cast: false });
    this.box(3.5, 0.1, 3.5, 16, 0.05, 16, dirt, { collide: false, cast: false });
    this.box(4, 0.1, 3, -8, 0.05, -22, dirt, { collide: false, cast: false });
  }

  private buildRoadMarkings(): void {
    const m = this.kit.matRoadMark;
    // Center dashed line N-S — skip intersection for clean crosswalk
    for (let z = -24; z <= 24; z += 4) {
      if (Math.abs(z) < 4) continue;
      this.box(0.28, 0.03, 1.7, 0, 0.02, z, m, { collide: false, cast: false });
    }
    // Center dashed line E-W
    for (let x = -20; x <= 20; x += 4) {
      if (Math.abs(x) < 5) continue;
      this.box(1.7, 0.03, 0.28, x, 0.02, 0, m, { collide: false, cast: false });
    }
    // Crosswalk at intersection (N-S bars)
    for (let i = -3; i <= 3; i++) {
      this.box(0.48, 0.035, 4.6, i * 1.1, 0.025, 0, m, {
        collide: false,
        cast: false,
      });
    }
    // Secondary crosswalk bars on N/S approaches
    for (const zSign of [-1, 1]) {
      for (let i = -2; i <= 2; i++) {
        this.box(4.2, 0.032, 0.4, 0, 0.022, zSign * (3.4 + i * 0.55), m, {
          collide: false,
          cast: false,
        });
      }
    }
    // Stop lines
    this.box(3.5, 0.03, 0.35, 0, 0.021, 5.4, m, { collide: false, cast: false });
    this.box(3.5, 0.03, 0.35, 0, 0.021, -5.4, m, { collide: false, cast: false });
  }

  private buildCurbsAndStreetFurniture(): void {
    const curb = this.kit.matConcreteDark;
    const trim = this.kit.matTrim;

    // Raised curb lips along sidewalks
    const curbH = 0.28;
    this.box(0.35, curbH, 48, -5.9, curbH * 0.5, 0, curb, { cast: false });
    this.box(0.35, curbH, 48, 5.9, curbH * 0.5, 0, curb, { cast: false });
    this.box(36, curbH, 0.35, 0, curbH * 0.5, -5.9, curb, { cast: false });
    this.box(36, curbH, 0.35, 0, curbH * 0.5, 5.9, curb, { cast: false });

    // Bollards near intersection corners
    const bollards: Array<[number, number]> = [
      [-5.2, -5.2],
      [5.2, -5.2],
      [-5.2, 5.2],
      [5.2, 5.2],
      [-5.2, 12],
      [5.2, -12],
      [-12, -5.2],
      [12, 5.2],
    ];
    for (const [x, z] of bollards) {
      this.box(0.28, 0.95, 0.28, x, 0.48, z, trim);
    }

    // Street light poles (visual cover + collision)
    const poles: Array<[number, number]> = [
      [-6.5, -16],
      [6.5, -16],
      [-6.5, 16],
      [6.5, 16],
      [-16, -6.5],
      [16, -6.5],
      [-16, 6.5],
      [18, 10],
    ];
    for (const [x, z] of poles) {
      this.box(0.22, 5.2, 0.22, x, 2.6, z, trim);
      this.box(1.4, 0.12, 0.35, x + 0.55, 5.1, z, this.kit.matMetal, {
        collide: false,
      });
      this.box(0.5, 0.2, 0.5, x + 1.1, 5.0, z, this.kit.matMetalRust, {
        collide: false,
      });
    }

    // Manhole covers on asphalt
    const covers: Array<[number, number]> = [
      [2.5, 10],
      [-3, -14],
      [12, 1],
      [-10, -2],
      [1, 22],
    ];
    for (const [x, z] of covers) {
      this.box(1.1, 0.06, 1.1, x, 0.04, z, this.kit.matMetal, {
        collide: false,
        cast: false,
        rotY: 0.3,
      });
    }
  }

  private buildPerimeterWalls(): void {
    const mat = this.kit.matConcreteDark;
    const t = 1.2;
    const h = 4.5;
    this.box(ARENA + 2, h, t, 0, h * 0.5, -HALF - 0.2, mat);
    this.box(ARENA + 2, h, t, 0, h * 0.5, HALF + 0.2, mat);
    this.box(t, h, ARENA + 2, -HALF - 0.2, h * 0.5, 0, mat);
    this.box(t, h, ARENA + 2, HALF + 0.2, h * 0.5, 0, mat);

    // Cap / coping on perimeter for silhouette edge
    const cap = this.kit.matConcrete;
    this.box(ARENA + 2.4, 0.25, t + 0.3, 0, h + 0.1, -HALF - 0.2, cap, {
      cast: false,
    });
    this.box(ARENA + 2.4, 0.25, t + 0.3, 0, h + 0.1, HALF + 0.2, cap, {
      cast: false,
    });
    this.box(t + 0.3, 0.25, ARENA + 2.4, -HALF - 0.2, h + 0.1, 0, cap, {
      cast: false,
    });
    this.box(t + 0.3, 0.25, ARENA + 2.4, HALF + 0.2, h + 0.1, 0, cap, {
      cast: false,
    });
  }

  // ── five buildings ───────────────────────────────────────────────────

  private buildBuildings(): void {
    this.buildNorthApartment();
    this.buildEastWarehouse();
    this.buildSouthShop();
    this.buildWestOffice();
    this.buildRuinedCorner();
  }

  /** Hollow shell: exterior walls with door gap; optional interior divider. */
  private hollowBuilding(opts: {
    cx: number;
    cz: number;
    w: number;
    d: number;
    floors: number;
    floorH: number;
    wall: number;
    mat: THREE.Material;
    roofMat?: THREE.Material;
    doorFace: 'n' | 's' | 'e' | 'w';
    doorW?: number;
    doorH?: number;
    windows?: boolean;
  }): void {
    const {
      cx,
      cz,
      w,
      d,
      floors,
      floorH,
      wall,
      mat,
      doorFace,
      doorW = 1.6,
      doorH = 2.2,
    } = opts;
    const roofMat = opts.roofMat ?? this.kit.matConcreteDark;
    const totalH = floors * floorH;
    const hw = w * 0.5;
    const hd = d * 0.5;

    // Floor slab
    this.box(w - 0.2, 0.25, d - 0.2, cx, 0.12, cz, this.kit.matConcrete, {
      cast: false,
    });

    // Roof
    this.box(w + 0.4, 0.35, d + 0.4, cx, totalH + 0.15, cz, roofMat);

    // Intermediate floors (ceilings)
    for (let f = 1; f < floors; f++) {
      this.box(w - wall * 2, 0.2, d - wall * 2, cx, f * floorH, cz, this.kit.matConcrete, {
        cast: false,
      });
    }

    const makeWallSeg = (
      ww: number,
      wh: number,
      wd: number,
      x: number,
      y: number,
      z: number,
    ) => this.box(ww, wh, wd, x, y, z, mat);

    // North wall
    {
      const z = cz - hd + wall * 0.5;
      if (doorFace === 'n') {
        const side = (w - doorW) * 0.5;
        makeWallSeg(side, totalH, wall, cx - (doorW * 0.5 + side * 0.5), totalH * 0.5, z);
        makeWallSeg(side, totalH, wall, cx + (doorW * 0.5 + side * 0.5), totalH * 0.5, z);
        makeWallSeg(doorW, totalH - doorH, wall, cx, doorH + (totalH - doorH) * 0.5, z);
        this.doorFrame(cx, z, doorW, doorH, 'n');
      } else {
        makeWallSeg(w, totalH, wall, cx, totalH * 0.5, z);
      }
    }
    // South wall
    {
      const z = cz + hd - wall * 0.5;
      if (doorFace === 's') {
        const side = (w - doorW) * 0.5;
        makeWallSeg(side, totalH, wall, cx - (doorW * 0.5 + side * 0.5), totalH * 0.5, z);
        makeWallSeg(side, totalH, wall, cx + (doorW * 0.5 + side * 0.5), totalH * 0.5, z);
        makeWallSeg(doorW, totalH - doorH, wall, cx, doorH + (totalH - doorH) * 0.5, z);
        this.doorFrame(cx, z, doorW, doorH, 's');
      } else {
        makeWallSeg(w, totalH, wall, cx, totalH * 0.5, z);
      }
    }
    // West wall
    {
      const x = cx - hw + wall * 0.5;
      if (doorFace === 'w') {
        const side = (d - doorW) * 0.5;
        makeWallSeg(wall, totalH, side, x, totalH * 0.5, cz - (doorW * 0.5 + side * 0.5));
        makeWallSeg(wall, totalH, side, x, totalH * 0.5, cz + (doorW * 0.5 + side * 0.5));
        makeWallSeg(wall, totalH - doorH, doorW, x, doorH + (totalH - doorH) * 0.5, cz);
        this.doorFrame(x, cz, doorW, doorH, 'w');
      } else {
        makeWallSeg(wall, totalH, d, x, totalH * 0.5, cz);
      }
    }
    // East wall
    {
      const x = cx + hw - wall * 0.5;
      if (doorFace === 'e') {
        const side = (d - doorW) * 0.5;
        makeWallSeg(wall, totalH, side, x, totalH * 0.5, cz - (doorW * 0.5 + side * 0.5));
        makeWallSeg(wall, totalH, side, x, totalH * 0.5, cz + (doorW * 0.5 + side * 0.5));
        makeWallSeg(wall, totalH - doorH, doorW, x, doorH + (totalH - doorH) * 0.5, cz);
        this.doorFrame(x, cz, doorW, doorH, 'e');
      } else {
        makeWallSeg(wall, totalH, d, x, totalH * 0.5, cz);
      }
    }

    if (opts.windows) {
      this.addWindowRow(cx, cz, w, d, floors, floorH, wall);
    }
  }

  private doorFrame(
    a: number,
    b: number,
    doorW: number,
    doorH: number,
    face: 'n' | 's' | 'e' | 'w',
  ): void {
    const trim = this.kit.matTrim;
    const t = 0.12;
    if (face === 'n' || face === 's') {
      const z = b + (face === 's' ? 0.08 : -0.08);
      this.box(doorW + 0.25, t, t, a, doorH + 0.05, z, trim, { collide: false });
      this.box(t, doorH, t, a - doorW * 0.5 - 0.05, doorH * 0.5, z, trim, {
        collide: false,
      });
      this.box(t, doorH, t, a + doorW * 0.5 + 0.05, doorH * 0.5, z, trim, {
        collide: false,
      });
    } else {
      const x = a + (face === 'e' ? 0.08 : -0.08);
      this.box(t, t, doorW + 0.25, x, doorH + 0.05, b, trim, { collide: false });
      this.box(t, doorH, t, x, doorH * 0.5, b - doorW * 0.5 - 0.05, trim, {
        collide: false,
      });
      this.box(t, doorH, t, x, doorH * 0.5, b + doorW * 0.5 + 0.05, trim, {
        collide: false,
      });
    }
  }

  private addWindowRow(
    cx: number,
    cz: number,
    _w: number,
    d: number,
    floors: number,
    floorH: number,
    wall: number,
  ): void {
    const glass = this.kit.matGlassBroken;
    const trim = this.kit.matTrim;
    for (let f = 0; f < floors; f++) {
      const y = f * floorH + floorH * 0.55;
      for (let i = -1; i <= 1; i++) {
        if (i === 0 && f === 0) continue; // door clearance on south
        const wx = cx + i * 2.4;
        const zs = cz + d * 0.5 - wall * 0.2;
        this.box(1.15, 1.25, 0.08, wx, y, zs, glass, {
          collide: false,
          cast: false,
        });
        // Frame
        this.box(1.3, 0.08, 0.1, wx, y + 0.65, zs, trim, { collide: false, cast: false });
        this.box(1.3, 0.08, 0.1, wx, y - 0.65, zs, trim, { collide: false, cast: false });
        this.box(0.08, 1.3, 0.1, wx - 0.6, y, zs, trim, { collide: false, cast: false });
        this.box(0.08, 1.3, 0.1, wx + 0.6, y, zs, trim, { collide: false, cast: false });
        this.box(0.06, 1.25, 0.06, wx, y, zs + 0.02, trim, { collide: false, cast: false });
      }
      for (let i = -1; i <= 1; i++) {
        const wx = cx + i * 2.4;
        const zn = cz - d * 0.5 + wall * 0.2;
        this.box(1.15, 1.25, 0.08, wx, y, zn, glass, {
          collide: false,
          cast: false,
        });
        this.box(1.3, 0.08, 0.1, wx, y + 0.65, zn, trim, { collide: false, cast: false });
        this.box(1.3, 0.08, 0.1, wx, y - 0.65, zn, trim, { collide: false, cast: false });
        this.box(0.08, 1.3, 0.1, wx - 0.6, y, zn, trim, { collide: false, cast: false });
        this.box(0.08, 1.3, 0.1, wx + 0.6, y, zn, trim, { collide: false, cast: false });
      }
    }
  }

  private buildNorthApartment(): void {
    this.hollowBuilding({
      cx: -4,
      cz: -20,
      w: 14,
      d: 10,
      floors: 2,
      floorH: 3.2,
      wall: 0.45,
      mat: this.kit.matBrick,
      doorFace: 's',
      doorW: 2.0,
      windows: true,
    });
    // Interior cover pillar + clutter
    this.box(1.2, 3.0, 1.2, -4, 1.5, -20, this.kit.matConcrete);
    this.box(0.9, 1.1, 0.9, -1.5, 0.55, -21, this.kit.matWood, { rotY: 0.4 });
    this.box(1.6, 0.9, 0.7, -7, 0.45, -18.5, this.kit.matMetalRust);
    this.coverAt(-1, 0, -16.5);
    this.coverAt(-7, 0, -16.5);
    // Balcony ledge on south face floor 2
    this.box(10, 0.25, 1.4, -4, 3.3, -14.4, this.kit.matConcrete);
    this.box(10, 1.0, 0.15, -4, 3.9, -13.75, this.kit.matMetal);
    // AC units on balcony
    this.box(1.2, 0.7, 0.8, -7, 3.75, -14.2, this.kit.matMetal, { collide: false });
    this.box(1.2, 0.7, 0.8, -1, 3.75, -14.2, this.kit.matMetalRust, { collide: false });
    // Facade drainpipe
    this.box(0.18, 6.2, 0.18, 2.6, 3.1, -14.7, this.kit.matMetalRust, {
      collide: false,
    });
    // Signboard
    this.box(3.5, 1.0, 0.12, -4, 4.8, -14.5, this.kit.matTrim, { collide: false });
  }

  private buildEastWarehouse(): void {
    this.hollowBuilding({
      cx: 20,
      cz: 2,
      w: 16,
      d: 14,
      floors: 1,
      floorH: 5.5,
      wall: 0.5,
      mat: this.kit.matConcreteDark,
      roofMat: this.kit.matMetalRust,
      doorFace: 'w',
      doorW: 4.5,
      doorH: 3.8,
      windows: false,
    });
    // Loading dock ramp lip
    this.box(3, 0.4, 5, 11.2, 0.2, 2, this.kit.matConcrete);
    // Interior racking / cover
    this.box(1.5, 2.2, 6, 24, 1.1, 0, this.kit.matMetal);
    this.box(1.5, 2.2, 4, 24, 1.1, 5, this.kit.matMetalRust);
    this.box(1.2, 1.8, 3, 17, 0.9, -3, this.kit.matMetal);
    this.box(2.2, 1.4, 1.2, 22, 0.7, -4, this.kit.matWood, { rotY: 0.2 });
    // Exterior corrugated lean-to
    this.box(4, 0.15, 6, 27.5, 3.2, 2, this.kit.matMetalRust, { collide: false });
    this.box(0.3, 3.0, 0.3, 27.5, 1.5, -0.5, this.kit.matMetal, { collide: false });
    this.box(0.3, 3.0, 0.3, 27.5, 1.5, 4.5, this.kit.matMetal, { collide: false });
    // Pallet stack outside
    this.box(1.6, 0.2, 1.2, 12, 0.15, -4, this.kit.matWood, { collide: false });
    this.box(1.6, 0.2, 1.2, 12, 0.35, -4, this.kit.matWood, {
      collide: false,
      rotY: 0.15,
    });
    this.coverAt(13, 0, 2);
    this.coverAt(18, 0, -3);
    this.coverAt(22, 0, 5);
  }

  private buildSouthShop(): void {
    this.hollowBuilding({
      cx: 3,
      cz: 20,
      w: 12,
      d: 9,
      floors: 1,
      floorH: 3.4,
      wall: 0.4,
      mat: this.kit.matPlaster,
      doorFace: 'n',
      doorW: 2.2,
      windows: true,
    });
    // Shop counter interior
    this.box(6, 1.1, 1.0, 3, 0.55, 22, this.kit.matWood);
    this.box(1.0, 1.6, 0.8, 6, 0.8, 23, this.kit.matMetal);
    this.coverAt(3, 0, 16.2);
    this.coverAt(-1, 0, 18);
    // Awning + supports
    this.box(10, 0.12, 2.2, 3, 2.6, 14.8, this.kit.matMetalRust, { collide: false });
    this.box(0.12, 2.4, 0.12, -1.5, 1.2, 14.2, this.kit.matMetal, { collide: false });
    this.box(0.12, 2.4, 0.12, 7.5, 1.2, 14.2, this.kit.matMetal, { collide: false });
    // Storefront display ledge
    this.box(8, 0.35, 0.6, 3, 0.9, 15.2, this.kit.matConcrete, { collide: false });
  }

  private buildWestOffice(): void {
    this.hollowBuilding({
      cx: -22,
      cz: -2,
      w: 12,
      d: 16,
      floors: 3,
      floorH: 3.0,
      wall: 0.45,
      mat: this.kit.matConcrete,
      doorFace: 'e',
      doorW: 2.0,
      windows: true,
    });
    // Lobby desk
    this.box(1.2, 1.0, 3.5, -18, 0.5, -2, this.kit.matWood);
    this.box(0.8, 1.2, 0.8, -17, 0.6, 1, this.kit.matMetal);
    this.coverAt(-15.5, 0, -2);
    this.coverAt(-17, 0, 4);
    // Exterior HVAC / pipe runs
    this.box(2.4, 1.5, 1.8, -22, 9.6, -2, this.kit.matMetal, { collide: false });
    this.box(0.25, 0.25, 8, -16.2, 5.5, -2, this.kit.matMetalRust, {
      collide: false,
    });
    this.box(0.25, 0.25, 6, -16.2, 7.2, 1, this.kit.matMetal, { collide: false });
    // Planter / low wall cover near entrance
    this.box(1.4, 0.7, 3.0, -15.2, 0.35, -6, this.kit.matConcreteDark);
  }

  private buildRuinedCorner(): void {
    const mat = this.kit.matBrick;
    const cx = -20;
    const cz = 20;
    this.box(10, 4.5, 0.5, cx, 2.25, cz - 5, mat);
    this.box(0.5, 5.5, 9, cx - 5, 2.75, cz, mat);
    this.box(8, 2.2, 0.5, cx + 1, 1.1, cz + 4.5, mat);
    // Jagged upper ruin teeth
    this.box(2.5, 1.8, 0.45, cx - 2, 5.2, cz - 5, mat);
    this.box(1.8, 2.4, 0.45, cx + 3, 5.5, cz - 5, mat);
    // Collapsed slab
    this.box(5, 0.4, 4, cx + 1, 1.8, cz - 1, this.kit.matConcrete, {
      rotY: 0.35,
    });
    this.box(3, 0.35, 3, cx - 2, 0.4, cz + 1, this.kit.matConcreteDark, {
      rotY: -0.5,
    });
    this.box(2.2, 0.3, 2.5, cx + 2, 0.55, cz + 2.5, this.kit.matConcrete, {
      rotY: 0.8,
    });
    // Standing rebar-ish metal posts
    this.box(0.2, 3.5, 0.2, cx + 3, 1.75, cz - 3, this.kit.matMetalRust);
    this.box(0.2, 2.8, 0.2, cx - 1, 1.4, cz - 2, this.kit.matMetal);
    this.box(0.18, 4.0, 0.18, cx - 3, 2.0, cz - 1, this.kit.matMetalRust);
    this.box(0.18, 2.2, 0.18, cx + 4, 1.1, cz + 1, this.kit.matMetal);
    // Scaffold remnant
    this.box(0.15, 4.5, 0.15, cx + 4.5, 2.25, cz - 4, this.kit.matMetal, {
      collide: false,
    });
    this.box(0.15, 4.5, 0.15, cx + 4.5, 2.25, cz - 1, this.kit.matMetal, {
      collide: false,
    });
    this.box(0.15, 0.15, 3.2, cx + 4.5, 4.4, cz - 2.5, this.kit.matMetal, {
      collide: false,
    });
    this.coverAt(cx, 0, cz);
    this.coverAt(cx + 3, 0, cz - 3);
  }

  // ── alleys, sandbags, barriers ───────────────────────────────────────

  private buildAlleysAndCover(): void {
    this.sandbagWall(-5, 6, 5, 0);
    this.sandbagWall(5, 5.5, 4, Math.PI * 0.5);
    this.sandbagWall(-6, -8, 4.5, 0.2);
    this.sandbagWall(8, -6, 3.5, -0.4);
    this.sandbagWall(14, 12, 4, 0.1);
    this.sandbagWall(-14, 12, 5, -0.15);
    this.sandbagWall(-10, -10, 3.5, 0.6);
    this.sandbagWall(10, 8, 3.2, -0.7);

    // Concrete jersey barriers
    this.barrier(2, 0, 10, 0);
    this.barrier(-2.5, 0, -11, 0.1);
    this.barrier(10, 0, -12, Math.PI * 0.5);
    this.barrier(-11, 0, 8, Math.PI * 0.48);
    this.barrier(16, 0, -4, 0.3);
    this.barrier(-8, 0, 4, Math.PI * 0.5);
    this.barrier(6, 0, -18, 0.15);
    this.barrier(-18, 0, -6, Math.PI * 0.52);

    // Metal dumpsters
    this.dumpster(-10, 14, 0.2);
    this.dumpster(11, -14, -0.3);
    this.dumpster(-15, -16, 0.5);
    this.dumpster(15, 16, -0.2);
    this.dumpster(24, -6, 0.1);

    // Alley fence panels
    this.box(0.12, 2.2, 6, -14.5, 1.1, -14, this.kit.matMetal);
    this.box(6, 2.2, 0.12, 14, 1.1, 14.5, this.kit.matMetalRust);
    this.box(0.12, 2.0, 4, 26, 1.0, -12, this.kit.matMetalRust);
    this.box(5, 2.0, 0.12, -24, 1.0, 12, this.kit.matMetal);

    // Oil drums
    this.barrel(-12, 8, 0);
    this.barrel(-12.7, 8.5, 0.4);
    this.barrel(8, 14, 0.2);
    this.barrel(19, 6, -0.3);
    this.barrel(-20, 10, 0.5);
    this.barrel(4, -16, 0.1);
    this.barrelStack(13, -8);

    // Camo tarp cover lean
    this.box(3.5, 0.08, 2.2, -7, 1.6, 10, this.kit.matCamo, {
      collide: false,
      rotY: 0.25,
    });
    this.box(0.15, 1.5, 0.15, -8.2, 0.75, 10.5, this.kit.matMetal, {
      collide: false,
    });
    this.box(0.15, 1.5, 0.15, -5.8, 0.75, 9.5, this.kit.matMetal, {
      collide: false,
    });
  }

  private dumpster(x: number, z: number, rotY: number): void {
    this.box(1.9, 1.45, 1.25, x, 0.72, z, this.kit.matMetalRust, { rotY });
    this.box(1.85, 0.12, 1.2, x, 1.5, z, this.kit.matMetal, {
      rotY: rotY + 0.08,
      collide: false,
    });
    this.coverAt(x, 0, z - Math.cos(rotY) * 1.4);
  }

  private barrel(x: number, z: number, rotY: number): void {
    this.box(0.65, 1.05, 0.65, x, 0.52, z, this.kit.matBarrel, { rotY });
    this.coverAt(x, 0, z);
  }

  private barrelStack(x: number, z: number): void {
    this.box(0.65, 1.05, 0.65, x, 0.52, z, this.kit.matBarrel);
    this.box(0.65, 1.05, 0.65, x + 0.7, 0.52, z + 0.15, this.kit.matMetalRust, {
      rotY: 0.3,
    });
    this.box(0.65, 1.05, 0.65, x + 0.35, 1.55, z, this.kit.matBarrel, {
      rotY: 0.5,
    });
    this.coverAt(x + 0.3, 0, z);
  }

  private sandbagWall(x: number, z: number, length: number, rotY: number): void {
    const mat = this.kit.matSandbag;
    const rows = 2;
    const bagW = 0.9;
    const bagH = 0.45;
    const bagD = 0.55;
    const count = Math.max(2, Math.floor(length / bagW));
    for (let row = 0; row < rows; row++) {
      for (let i = 0; i < count; i++) {
        const offset = (i - (count - 1) * 0.5) * bagW;
        const lx = Math.cos(rotY) * offset;
        const lz = Math.sin(rotY) * offset;
        // Slight stagger on top row for less grid-like look
        const jitter = row === 1 ? bagW * 0.12 : 0;
        this.box(
          bagW * 0.95,
          bagH,
          bagD,
          x + lx + Math.cos(rotY) * jitter,
          bagH * 0.5 + row * bagH,
          z + lz + Math.sin(rotY) * jitter,
          mat,
          { rotY: rotY + (i % 2) * 0.04 },
        );
      }
    }
    this.coverAt(x, 0, z);
  }

  private barrier(x: number, y: number, z: number, rotY: number): void {
    this.box(2.4, 1.05, 0.55, x, y + 0.52, z, this.kit.matConcrete, { rotY });
    // Top chamfer lip for read
    this.box(2.35, 0.12, 0.35, x, y + 1.1, z, this.kit.matConcreteDark, {
      rotY,
      collide: false,
    });
    this.coverAt(x, 0, z);
  }

  // ── wrecked cars ─────────────────────────────────────────────────────

  private buildVehicles(): void {
    this.wreckedCar(4, 12, 0.4);
    this.wreckedCar(-8, -4, -0.9);
    this.wreckedCar(18, -10, 1.2);
    this.wreckedCar(-16, 6, 0.25);
    this.wreckedCar(8, -20, -0.5);
  }

  private wreckedCar(x: number, z: number, rotY: number): void {
    const body = this.kit.matMetalRust;
    const dark = this.kit.matMetal;
    this.box(4.2, 0.7, 1.9, x, 0.55, z, body, { rotY });
    this.box(2.0, 0.85, 1.75, x + Math.cos(rotY) * 0.2, 1.25, z + Math.sin(rotY) * 0.2, dark, {
      rotY,
    });
    this.box(1.3, 0.35, 1.7, x + Math.cos(rotY) * 1.4, 0.85, z + Math.sin(rotY) * 1.4, body, {
      rotY: rotY + 0.15,
    });
    // Broken windshield
    this.box(
      1.6,
      0.55,
      0.08,
      x + Math.cos(rotY) * 0.1,
      1.45,
      z + Math.sin(rotY) * 0.1,
      this.kit.matGlassBroken,
      { rotY, collide: false, cast: false },
    );
    const wx = Math.cos(rotY + Math.PI * 0.5) * 0.95;
    const wz = Math.sin(rotY + Math.PI * 0.5) * 0.95;
    for (const along of [-1.3, 1.2]) {
      const ax = Math.cos(rotY) * along;
      const az = Math.sin(rotY) * along;
      this.box(0.55, 0.55, 0.35, x + ax + wx, 0.28, z + az + wz, dark, {
        collide: false,
        rotY,
      });
      this.box(0.55, 0.55, 0.35, x + ax - wx, 0.28, z + az - wz, dark, {
        collide: false,
        rotY,
      });
    }
    this.coverAt(x, 0, z);
  }

  // ── crates / debris ──────────────────────────────────────────────────

  private buildCratesAndDebris(): void {
    const wood = this.kit.matWood;
    const positions: Array<[number, number, number, number]> = [
      [6, 9, 0.9, 0],
      [7.1, 9.2, 0.7, 0.4],
      [-9, 10, 0.9, -0.2],
      [15, 4, 0.9, 0.1],
      [15.9, 4.3, 0.7, 0.6],
      [-18, -8, 0.9, 0],
      [22, 8, 0.9, 0.3],
      [-3, 17, 0.9, -0.5],
      [9, -18, 0.9, 0.2],
      [-12, -18, 0.8, 0.7],
      [2, 14, 0.75, 0.3],
      [-17, 14, 0.85, -0.4],
      [25, 0, 0.9, 0.15],
      [-6, -14, 0.7, 0.9],
      [17, 12, 0.8, -0.25],
      [-22, 4, 0.75, 0.55],
    ];
    for (const [x, z, s, r] of positions) {
      this.box(s, s, s, x, s * 0.5, z, wood, { rotY: r });
      this.coverAt(x, 0, z);
    }
    // Stacked crate tower
    this.box(1.0, 1.0, 1.0, -6, 0.5, 11, wood);
    this.box(0.9, 0.9, 0.9, -6, 1.4, 11, wood, { rotY: 0.3 });
    this.box(0.8, 0.8, 0.8, -6, 2.2, 11, wood, { rotY: -0.2 });
    this.coverAt(-6, 0, 11);

    // Second stack near warehouse
    this.box(1.0, 1.0, 1.0, 14, 0.5, -2, wood);
    this.box(0.85, 0.85, 0.85, 14, 1.35, -2, wood, { rotY: -0.4 });
    this.coverAt(14, 0, -2);

    // Debris scatter
    const rubble = this.kit.matConcreteDark;
    const brick = this.kit.matBrick;
    for (let i = 0; i < 42; i++) {
      const ang = i * 2.15;
      const rad = 7 + (i % 9) * 2.8;
      const x = Math.cos(ang) * rad + ((i * 17) % 5) - 2;
      const z = Math.sin(ang) * rad + ((i * 13) % 5) - 2;
      // Keep clear of player spawn pocket (~0, 28)
      if (z > 24 && Math.abs(x) < 4) continue;
      const s = 0.22 + (i % 5) * 0.11;
      const mat = i % 5 === 0 ? brick : rubble;
      this.box(s, s * 0.5, s * 0.85, x, s * 0.25, z, mat, {
        collide: i % 3 === 0,
        cast: false,
        rotY: i * 0.7,
      });
    }

    // Concentrated rubble near ruined SW
    for (let i = 0; i < 12; i++) {
      const x = -20 + (i % 4) * 1.4 - 1;
      const z = 18 + Math.floor(i / 4) * 1.5;
      const s = 0.35 + (i % 3) * 0.15;
      this.box(s, s * 0.4, s * 0.7, x, s * 0.2, z, i % 2 ? brick : rubble, {
        collide: false,
        cast: false,
        rotY: i * 0.9,
      });
    }

    // Tire stacks
    this.tireStack(12, 8);
    this.tireStack(-14, -8);
    this.tireStack(20, 14);
  }

  private tireStack(x: number, z: number): void {
    const dark = this.kit.matMetal;
    this.box(0.72, 0.32, 0.72, x, 0.16, z, dark, { collide: false });
    this.box(0.72, 0.32, 0.72, x, 0.48, z, dark, { collide: false, rotY: 0.2 });
    this.box(0.72, 0.32, 0.72, x, 0.8, z, dark, { rotY: -0.15 });
    this.coverAt(x, 0, z);
  }

  // ── stairs to north apartment roof ───────────────────────────────────

  private buildStairsAndRooftop(): void {
    const mat = this.kit.matConcrete;
    const baseX = -12.2;
    const baseZ = -20;
    const steps = 14;
    const stepH = 0.46;
    const stepD = 0.55;
    for (let i = 0; i < steps; i++) {
      this.box(2.2, stepH, stepD, baseX, stepH * 0.5 + i * stepH, baseZ + 4.5 - i * stepD, mat);
    }
    // Stair rail
    this.box(0.1, 0.9, steps * stepD, baseX - 1.15, 1.2, baseZ + 4.5 - (steps * stepD) * 0.5, this.kit.matMetal, {
      collide: false,
    });
    // Landing
    this.box(3.2, 0.3, 3.2, baseX, steps * stepH + 0.1, baseZ - 3.2, mat);
    // Roof parapet access walkway onto apartment roof (roof at ~6.55)
    this.box(4, 0.3, 2, -8, 6.55, -20, mat);
    // Parapet walls on roof
    this.box(14.5, 0.9, 0.25, -4, 7.1, -15.1, this.kit.matBrick);
    this.box(14.5, 0.9, 0.25, -4, 7.1, -24.9, this.kit.matBrick);
    this.box(0.25, 0.9, 10, 2.9, 7.1, -20, this.kit.matBrick);
    this.box(0.25, 0.9, 6, -10.9, 7.1, -22, this.kit.matBrick);

    // Rooftop AC / vents / sandbags
    this.box(2.5, 1.4, 1.8, -2, 7.3, -19, this.kit.matMetal);
    this.box(1.2, 0.9, 1.2, 0.5, 7.15, -22, this.kit.matMetalRust, {
      collide: false,
    });
    this.box(0.8, 1.1, 0.8, -7, 7.25, -21, this.kit.matMetal, { collide: false });
    const roofY = 6.7;
    const bagMat = this.kit.matSandbag;
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 4; i++) {
        this.box(
          0.85,
          0.45,
          0.5,
          -6.4 + (i - 1.5) * 0.9,
          roofY + 0.22 + row * 0.45,
          -18,
          bagMat,
        );
      }
    }
    this.coverNodes.push(new THREE.Vector3(-6, roofY, -18));
    this.coverNodes.push(new THREE.Vector3(-2, roofY, -19));
    this.enemySpawns.push(new THREE.Vector3(-4, roofY, -21));
  }

  // ── distant skyline silhouettes ──────────────────────────────────────

  private buildPerimeterSilhouettes(): void {
    const mat = this.kit.matSilhouette;
    const ring = HALF + 18;

    type SilSpec = {
      x: number;
      z: number;
      w: number;
      h: number;
      d: number;
      tiers?: number;
      antenna?: boolean;
      waterTower?: boolean;
    };

    const specs: SilSpec[] = [
      { x: -ring, z: -10, w: 9, h: 24, d: 7, tiers: 3, antenna: true },
      { x: -ring, z: 12, w: 11, h: 17, d: 8, tiers: 2 },
      { x: -ring, z: 28, w: 7, h: 30, d: 6, tiers: 4, antenna: true },
      { x: -ring - 6, z: -28, w: 6, h: 14, d: 5, tiers: 2 },
      { x: ring, z: -8, w: 10, h: 22, d: 7, tiers: 3, antenna: true },
      { x: ring, z: 15, w: 8, h: 28, d: 6, tiers: 3, antenna: true },
      { x: ring, z: -25, w: 12, h: 15, d: 9, tiers: 2, waterTower: true },
      { x: ring + 5, z: 30, w: 6, h: 20, d: 5, tiers: 2 },
      { x: -15, z: -ring, w: 13, h: 19, d: 8, tiers: 3 },
      { x: 8, z: -ring, w: 9, h: 26, d: 7, tiers: 4, antenna: true },
      { x: 25, z: -ring, w: 11, h: 16, d: 8, tiers: 2 },
      { x: -28, z: -ring - 4, w: 7, h: 12, d: 6 },
      { x: -20, z: ring, w: 10, h: 20, d: 7, tiers: 3 },
      { x: 5, z: ring, w: 15, h: 13, d: 9, tiers: 2, waterTower: true },
      { x: 22, z: ring, w: 8, h: 29, d: 6, tiers: 4, antenna: true },
      { x: -30, z: -30, w: 7, h: 18, d: 7, tiers: 2 },
      { x: 32, z: 32, w: 9, h: 23, d: 7, tiers: 3, antenna: true },
      { x: -32, z: 32, w: 8, h: 15, d: 6, tiers: 2 },
      { x: 32, z: -32, w: 6, h: 21, d: 5, tiers: 3 },
    ];

    for (const s of specs) {
      const tiers = s.tiers ?? 1;
      // Stepped massing for readable dusk skyline
      for (let t = 0; t < tiers; t++) {
        const shrink = t * 0.12;
        const tw = s.w * (1 - shrink);
        const td = s.d * (1 - shrink * 0.8);
        const th = s.h / tiers;
        const yBase = t * th;
        this.box(tw, th, td, s.x, yBase + th * 0.5 - 0.5, s.z, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
        // Side wing on mid tiers for irregular silhouette
        if (t === 1 && tiers >= 3) {
          this.box(tw * 0.45, th * 0.85, td * 1.25, s.x + tw * 0.4, yBase + th * 0.4, s.z, mat, {
            collide: false,
            cast: false,
            receive: false,
          });
        }
      }
      if (s.antenna) {
        this.box(0.35, 5.5, 0.35, s.x, s.h + 2, s.z, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
        this.box(1.8, 0.2, 0.2, s.x, s.h + 4.2, s.z, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
      }
      if (s.waterTower) {
        this.box(2.2, 1.8, 2.2, s.x, s.h + 1.2, s.z, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
        this.box(0.25, 2.2, 0.25, s.x - 0.7, s.h - 0.2, s.z - 0.7, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
        this.box(0.25, 2.2, 0.25, s.x + 0.7, s.h - 0.2, s.z + 0.7, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
      }
    }
  }

  private placeSpawnsAndCover(): void {
    // Player already at south street — keep enemy spawn positions unchanged
    const spawns: Array<[number, number, number]> = [
      [-4, 0, -18],
      [20, 0, 2],
      [3, 0, 18],
      [-20, 0, -2],
      [-18, 0, 18],
      [8, 0, -8],
      [-10, 0, 8],
      [14, 0, 10],
      [-14, 0, -12],
      [0, 0, -6],
      [22, 0, -8],
      [-8, 0, 20],
    ];
    for (const [x, y, z] of spawns) {
      this.enemySpawns.push(new THREE.Vector3(x, y, z));
    }

    const extras: Array<[number, number]> = [
      [0, 8],
      [0, -8],
      [8, 0],
      [-8, 0],
      [5, -14],
      [-5, 14],
    ];
    for (const [x, z] of extras) this.coverAt(x, 0, z);
  }
}
