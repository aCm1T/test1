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
    // West sidewalk of main N-S road
    this.box(3.2, swH, 52, -7.6, swH * 0.5, 0, concrete, { cast: false });
    // East sidewalk
    this.box(3.2, swH, 52, 7.6, swH * 0.5, 0, concrete, { cast: false });

    // E-W street sidewalks
    this.box(40, swH, 3.2, 0, swH * 0.5, -7.6, concrete, { cast: false });
    this.box(40, swH, 3.2, 0, swH * 0.5, 7.6, concrete, { cast: false });

    // Dirt patches in alleys / broken curb
    this.box(4, 0.12, 8, -18, 0.06, 18, dirt, { collide: false, cast: false });
    this.box(6, 0.12, 4, 20, 0.06, -16, dirt, { collide: false, cast: false });
    this.box(5, 0.12, 5, -22, 0.06, -20, dirt, { collide: false, cast: false });
  }

  private buildRoadMarkings(): void {
    const m = this.kit.matRoadMark;
    // Center dashed line N-S
    for (let z = -24; z <= 24; z += 4) {
      this.box(0.25, 0.03, 1.6, 0, 0.02, z, m, { collide: false, cast: false });
    }
    // Center dashed line E-W
    for (let x = -20; x <= 20; x += 4) {
      if (Math.abs(x) < 5) continue;
      this.box(1.6, 0.03, 0.25, x, 0.02, 0, m, { collide: false, cast: false });
    }
    // Crosswalk at intersection
    for (let i = -3; i <= 3; i++) {
      this.box(0.45, 0.035, 4.5, i * 1.1, 0.025, 0, m, {
        collide: false,
        cast: false,
      });
    }
  }

  private buildPerimeterWalls(): void {
    const mat = this.kit.matConcreteDark;
    const t = 1.2;
    const h = 4.5;
    // Outer low walls keeping players in arena
    this.box(ARENA + 2, h, t, 0, h * 0.5, -HALF - 0.2, mat);
    this.box(ARENA + 2, h, t, 0, h * 0.5, HALF + 0.2, mat);
    this.box(t, h, ARENA + 2, -HALF - 0.2, h * 0.5, 0, mat);
    this.box(t, h, ARENA + 2, HALF + 0.2, h * 0.5, 0, mat);
  }

  // ── five buildings ───────────────────────────────────────────────────

  private buildBuildings(): void {
    // 1) North apartment — enterable, 2 floors, stairs to roof later
    this.buildNorthApartment();
    // 2) East warehouse — enterable open bay
    this.buildEastWarehouse();
    // 3) South shopfront — enterable ground floor
    this.buildSouthShop();
    // 4) West office block — mostly solid with lobby cutout
    this.buildWestOffice();
    // 5) SW ruined corner building
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

    // North wall (gap if door on N)
    {
      const z = cz - hd + wall * 0.5;
      if (doorFace === 'n') {
        const side = (w - doorW) * 0.5;
        makeWallSeg(side, totalH, wall, cx - (doorW * 0.5 + side * 0.5), totalH * 0.5, z);
        makeWallSeg(side, totalH, wall, cx + (doorW * 0.5 + side * 0.5), totalH * 0.5, z);
        makeWallSeg(doorW, totalH - doorH, wall, cx, doorH + (totalH - doorH) * 0.5, z);
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
      } else {
        makeWallSeg(wall, totalH, d, x, totalH * 0.5, cz);
      }
    }

    if (opts.windows) {
      this.addWindowRow(cx, cz, w, d, floors, floorH, wall);
    }
  }

  private addWindowRow(
    cx: number,
    cz: number,
    w: number,
    d: number,
    floors: number,
    floorH: number,
    wall: number,
  ): void {
    const glass = this.kit.matGlassBroken;
    for (let f = 0; f < floors; f++) {
      const y = f * floorH + floorH * 0.55;
      // South-facing windows
      for (let i = -1; i <= 1; i++) {
        if (i === 0 && f === 0) continue;
        this.box(1.1, 1.2, 0.08, cx + i * 2.4, y, cz + d * 0.5 - wall * 0.2, glass, {
          collide: false,
          cast: false,
        });
      }
      // North-facing
      for (let i = -1; i <= 1; i++) {
        this.box(1.1, 1.2, 0.08, cx + i * 2.4, y, cz - d * 0.5 + wall * 0.2, glass, {
          collide: false,
          cast: false,
        });
      }
    }
  }

  private buildNorthApartment(): void {
    // North of intersection, faces south onto street
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
    // Interior cover pillar
    this.box(1.2, 3.0, 1.2, -4, 1.5, -20, this.kit.matConcrete);
    this.coverAt(-1, 0, -16.5);
    this.coverAt(-7, 0, -16.5);
    // Balcony ledge on south face floor 2
    this.box(10, 0.25, 1.4, -4, 3.3, -14.4, this.kit.matConcrete);
    this.box(10, 1.0, 0.15, -4, 3.9, -13.75, this.kit.matMetal);
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
    this.coverAt(3, 0, 16.2);
    this.coverAt(-1, 0, 18);
    // Awning
    this.box(10, 0.12, 2.2, 3, 2.6, 14.8, this.kit.matMetalRust, { collide: false });
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
    this.coverAt(-15.5, 0, -2);
    this.coverAt(-17, 0, 4);
    // Side entrance alley door cut visual (solid wall already has east door)
  }

  private buildRuinedCorner(): void {
    // SW ruined shell — partial walls, rubble
    const mat = this.kit.matBrick;
    const cx = -20;
    const cz = 20;
    this.box(10, 4.5, 0.5, cx, 2.25, cz - 5, mat);
    this.box(0.5, 5.5, 9, cx - 5, 2.75, cz, mat);
    this.box(8, 2.2, 0.5, cx + 1, 1.1, cz + 4.5, mat);
    // Collapsed slab
    this.box(5, 0.4, 4, cx + 1, 1.8, cz - 1, this.kit.matConcrete, {
      rotY: 0.35,
    });
    this.box(3, 0.35, 3, cx - 2, 0.4, cz + 1, this.kit.matConcreteDark, {
      rotY: -0.5,
    });
    // Standing rebar-ish metal posts
    this.box(0.2, 3.5, 0.2, cx + 3, 1.75, cz - 3, this.kit.matMetalRust);
    this.box(0.2, 2.8, 0.2, cx - 1, 1.4, cz - 2, this.kit.matMetal);
    this.coverAt(cx, 0, cz);
    this.coverAt(cx + 3, 0, cz - 3);
  }

  // ── alleys, sandbags, barriers ───────────────────────────────────────

  private buildAlleysAndCover(): void {
    // Sandbag lines near intersection — classic mid-lane cover
    this.sandbagWall(-5, 6, 5, 0);
    this.sandbagWall(5, 5.5, 4, Math.PI * 0.5);
    this.sandbagWall(-6, -8, 4.5, 0.2);
    this.sandbagWall(8, -6, 3.5, -0.4);
    this.sandbagWall(14, 12, 4, 0.1);
    this.sandbagWall(-14, 12, 5, -0.15);

    // Concrete jersey barriers
    this.barrier(2, 0, 10, 0);
    this.barrier(-2.5, 0, -11, 0.1);
    this.barrier(10, 0, -12, Math.PI * 0.5);
    this.barrier(-11, 0, 8, Math.PI * 0.48);
    this.barrier(16, 0, -4, 0.3);

    // Metal dumpster alley cover
    this.box(1.8, 1.4, 1.2, -10, 0.7, 14, this.kit.matMetalRust);
    this.coverAt(-10, 0, 12.5);
    this.box(1.8, 1.4, 1.2, 11, 0.7, -14, this.kit.matMetal);
    this.coverAt(11, 0, -12.5);

    // Alley fence panels
    this.box(0.12, 2.2, 6, -14.5, 1.1, -14, this.kit.matMetal);
    this.box(6, 2.2, 0.12, 14, 1.1, 14.5, this.kit.matMetalRust);
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
        this.box(
          bagW * 0.95,
          bagH,
          bagD,
          x + lx,
          bagH * 0.5 + row * bagH,
          z + lz,
          mat,
          { rotY },
        );
      }
    }
    this.coverAt(x, 0, z);
  }

  private barrier(x: number, y: number, z: number, rotY: number): void {
    this.box(2.4, 1.05, 0.55, x, y + 0.52, z, this.kit.matConcrete, { rotY });
    this.coverAt(x, 0, z);
  }

  // ── wrecked cars ─────────────────────────────────────────────────────

  private buildVehicles(): void {
    this.wreckedCar(4, 12, 0.4);
    this.wreckedCar(-8, -4, -0.9);
    this.wreckedCar(18, -10, 1.2);
    this.wreckedCar(-16, 6, 0.25);
  }

  private wreckedCar(x: number, z: number, rotY: number): void {
    const body = this.kit.matMetalRust;
    const dark = this.kit.matMetal;
    // Chassis
    this.box(4.2, 0.7, 1.9, x, 0.55, z, body, { rotY });
    // Cabin
    this.box(2.0, 0.85, 1.75, x + Math.cos(rotY) * 0.2, 1.25, z + Math.sin(rotY) * 0.2, dark, {
      rotY,
    });
    // Hood crumpled
    this.box(1.3, 0.35, 1.7, x + Math.cos(rotY) * 1.4, 0.85, z + Math.sin(rotY) * 1.4, body, {
      rotY: rotY + 0.15,
    });
    // Wheels as boxes
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

    // Debris scatter (non-colliding small rubble + some colliding chunks)
    const rubble = this.kit.matConcreteDark;
    for (let i = 0; i < 28; i++) {
      const ang = i * 2.4;
      const rad = 8 + (i % 7) * 3.2;
      const x = Math.cos(ang) * rad + ((i * 17) % 5) - 2;
      const z = Math.sin(ang) * rad + ((i * 13) % 5) - 2;
      const s = 0.25 + (i % 4) * 0.12;
      this.box(s, s * 0.5, s * 0.8, x, s * 0.25, z, rubble, {
        collide: i % 3 === 0,
        cast: false,
        rotY: i * 0.7,
      });
    }

    // Tire stacks (metal-dark cylinders approximated as boxes)
    this.box(0.7, 0.35, 0.7, 12, 0.18, 8, this.kit.matMetal, { collide: false });
    this.box(0.7, 0.35, 0.7, 12, 0.52, 8, this.kit.matMetal, { collide: false });
    this.box(0.7, 0.35, 0.7, 12, 0.86, 8, this.kit.matMetal);
    this.coverAt(12, 0, 8);
  }

  // ── stairs to north apartment roof ───────────────────────────────────

  private buildStairsAndRooftop(): void {
    const mat = this.kit.matConcrete;
    // Exterior stair on west side of north apartment leading to roof (~6.4)
    const baseX = -12.2;
    const baseZ = -20;
    const steps = 14;
    const stepH = 0.46;
    const stepD = 0.55;
    for (let i = 0; i < steps; i++) {
      this.box(2.2, stepH, stepD, baseX, stepH * 0.5 + i * stepH, baseZ + 4.5 - i * stepD, mat);
    }
    // Landing
    this.box(3.2, 0.3, 3.2, baseX, steps * stepH + 0.1, baseZ - 3.2, mat);
    // Roof parapet access walkway onto apartment roof (roof at ~6.55)
    this.box(4, 0.3, 2, -8, 6.55, -20, mat);
    // Parapet walls on roof
    this.box(14.5, 0.9, 0.25, -4, 7.1, -15.1, this.kit.matBrick);
    this.box(14.5, 0.9, 0.25, -4, 7.1, -24.9, this.kit.matBrick);
    this.box(0.25, 0.9, 10, 2.9, 7.1, -20, this.kit.matBrick);
    this.box(0.25, 0.9, 6, -10.9, 7.1, -22, this.kit.matBrick);

    // Rooftop sandbags / AC unit cover
    this.box(2.5, 1.4, 1.8, -2, 7.3, -19, this.kit.matMetal);
    const roofY = 6.7;
    const bagMat = this.kit.matSandbag;
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 3; i++) {
        this.box(
          0.85,
          0.45,
          0.5,
          -6 + (i - 1) * 0.9,
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
    const specs: Array<[number, number, number, number, number]> = [
      // x, z, w, h, d
      [-ring, -10, 8, 22, 6],
      [-ring, 12, 10, 16, 7],
      [-ring, 28, 6, 28, 5],
      [ring, -8, 9, 20, 6],
      [ring, 15, 7, 26, 5],
      [ring, -25, 11, 14, 8],
      [-15, -ring, 12, 18, 7],
      [8, -ring, 8, 24, 6],
      [25, -ring, 10, 15, 7],
      [-20, ring, 9, 19, 6],
      [5, ring, 14, 12, 8],
      [22, ring, 7, 27, 5],
      [-30, -30, 6, 16, 6],
      [32, 32, 8, 21, 6],
    ];
    for (const [x, z, w, h, d] of specs) {
      this.box(w, h, d, x, h * 0.5 - 0.5, z, mat, {
        collide: false,
        cast: false,
        receive: false,
      });
      // Antenna / water tower accents
      if (h > 20) {
        this.box(0.35, 4, 0.35, x, h + 1.5, z, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
      }
    }
  }

  private placeSpawnsAndCover(): void {
    // Player already at south street
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

    // Extra mid-map cover nodes for AI
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
