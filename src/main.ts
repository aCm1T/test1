import './style.css';

import { Vector3 } from 'three';
import {
  GameRenderer,
  PostProcessing,
  setupLighting,
  setupEnvironment,
  GameClock,
} from './engine';
import { Level } from './world';
import { PlayerController, CameraFeel } from './player';
import { WeaponSystem } from './weapons';
import { asHitscanEnemies } from './combat';
import { EnemyManager } from './enemies';
import { VFXManager, DecalManager } from './vfx';
import { AudioManager } from './audio';
import { HUD, MainMenu } from './ui';

/**
 * BLACKOPS: FRONTLINE — urban dusk FPS bootstrap.
 * Wires renderer, level, player, weapons, AI, VFX, audio, and HUD.
 */
class Game {
  private readonly app: HTMLElement;
  private readonly renderer: GameRenderer;
  private readonly post: PostProcessing;
  private readonly clock: GameClock;
  private readonly lighting;
  private readonly environment;
  private readonly level: Level;
  private readonly player: PlayerController;
  private readonly cameraFeel: CameraFeel;
  private readonly weapons: WeaponSystem;
  private readonly enemies: EnemyManager;
  private readonly vfx: VFXManager;
  private readonly decals: DecalManager;
  private readonly audio: AudioManager;
  private readonly hud: HUD;
  private readonly menu: MainMenu;

  private playing = false;
  private paused = false;
  private footstepTimer = 0;
  private readonly muzzlePos = new Vector3();
  private readonly muzzleDir = new Vector3();
  private readonly tmp = new Vector3();
  private lastWeaponName = '';
  private animId = 0;

  constructor() {
    const app = document.getElementById('app');
    if (!app) throw new Error('#app mount missing');
    this.app = app;

    this.renderer = new GameRenderer({
      container: app,
      exposure: 1.55,
      shadowMapSize: 2048,
      clearColor: 0x1a2433,
    });

    this.environment = setupEnvironment(
      this.renderer.renderer,
      this.renderer.scene,
    );

    this.lighting = setupLighting(this.renderer.scene, {
      mapRadius: 42,
      shadowMapSize: 2048,
      fogDensity: 0.0036,
      fogColor: 0x3a4450,
      hemiIntensity: 2.3,
      sunIntensity: 2.55,
      moonIntensity: 0.55,
    });

    this.level = new Level(this.renderer.scene);
    // Clear intersection spawn — avoid prop/car overlap that flings the player.
    this.level.playerSpawn.set(0, 0, 0);
    // Guaranteed hostile in the opening frame (screenshot / first-second readability).
    this.level.enemySpawns.unshift(new Vector3(3.5, 0, -8));
    this.level.enemySpawns.unshift(new Vector3(-4, 0, -10));

    this.player = new PlayerController({
      position: this.level.playerSpawn.clone(),
      sensitivity: 0.00215,
    });
    // Look north down the street with slight dip so asphalt fills the frame.
    this.player.setLook(Math.PI, -0.18);
    this.renderer.scene.add(this.player.pivot);

    // Gameplay uses the player camera; keep renderer camera as unused fallback.
    this.post = new PostProcessing(
      this.renderer.renderer,
      this.renderer.scene,
      this.player.camera,
    );

    this.cameraFeel = new CameraFeel(this.player.camera, this.player);

    this.weapons = new WeaponSystem({
      player: this.player,
      camera: this.player.camera,
      colliders: this.level.colliders,
      callbacks: {
        onFire: (weapon, hit) => this.handleFire(weapon, hit),
        onHit: (_enemy, bodyPart) => {
          this.hud.showHitmarker(bodyPart === 'head');
          this.audio.playHitMarker(bodyPart === 'head');
        },
        onKill: (_enemy, bodyPart) => {
          this.hud.showHitmarker(bodyPart === 'head');
          this.hud.pushKillfeed({
            killer: 'You',
            victim: 'Hostile',
            weapon: this.weapons.getActiveDef().name,
            headshot: bodyPart === 'head',
          });
        },
        onReload: () => this.audio.playReload(),
      },
    });

    this.enemies = new EnemyManager(this.renderer.scene, this.level, {
      maxAlive: 8,
      waveDelay: 7,
      waveSize: 4,
      onEnemyShoot: (ev) => this.handleEnemyShot(ev),
      onEnemyDeath: () => {
        /* killfeed handled via weapon onKill for player kills */
      },
    });

    this.vfx = new VFXManager(this.renderer.scene);
    this.decals = new DecalManager(this.renderer.scene);
    this.audio = new AudioManager();
    this.hud = new HUD(this.app);
    this.clock = new GameClock();

    this.menu = new MainMenu(
      {
        onPlay: (settings) => this.startGame(settings),
        onSettingsChange: (settings) => this.applySettings(settings),
      },
      this.app,
    );

    this.player.attach(this.renderer.renderer.domElement);

    window.addEventListener('resize', this.onResize);
    document.addEventListener('pointerlockchange', this.onPointerLock);
    window.addEventListener('keydown', this.onKeyDown);

    // Prevent context menu on canvas during ADS
    this.renderer.renderer.domElement.addEventListener('contextmenu', (e) =>
      e.preventDefault(),
    );

    this.syncPostSize();
    this.clock.start();
    this.loop();
  }

  private applySettings(settings: {
    sensitivity: number;
    masterVolume: number;
    sfxVolume: number;
  }): void {
    this.player.sensitivity = 0.00215 * settings.sensitivity;
    this.audio.setVolume('master', settings.masterVolume);
    this.audio.setVolume('sfx', settings.sfxVolume);
  }

  private async startGame(settings: {
    sensitivity: number;
    masterVolume: number;
    sfxVolume: number;
  }): Promise<void> {
    this.applySettings(settings);
    await this.audio.unlock();
    this.menu.hide();
    this.hud.setVisible(true);
    this.playing = true;
    this.paused = false;

    if (this.player.isDead()) {
      this.player.revive(true);
      this.player.setPosition(
        this.level.playerSpawn.x,
        this.level.playerSpawn.y,
        this.level.playerSpawn.z,
      );
    }

    this.hud.setWeaponName(this.weapons.getActiveDef().name);
    this.hud.setVitals({
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      armor: this.player.armor,
      maxArmor: this.player.maxArmor,
    });
    this.syncAmmoHud();

    // Pointer lock after user gesture (Play click)
    this.player.requestPointerLock(this.renderer.renderer.domElement);
  }

  private handleFire(
    weapon: string,
    hit: import('./combat').HitscanHit | null,
  ): void {
    this.audio.playGunshot(weapon === 'pistol' ? 0.75 : weapon === 'knife' ? 0.35 : 1);
    this.post.pulseBloom(weapon === 'ar' ? 0.4 : 0.25);

    this.player.camera.getWorldPosition(this.muzzlePos);
    this.player.camera.getWorldDirection(this.muzzleDir);
    this.muzzlePos.addScaledVector(this.muzzleDir, 0.55);
    if (weapon !== 'knife') {
      this.vfx.spawnMuzzleFlash(this.muzzlePos, this.muzzleDir);
    }

    if (!hit) return;

    if (hit.enemy && !hit.hitWorld) {
      this.vfx.spawnBlood(hit.point, this.muzzleDir);
    } else if (hit.hitWorld) {
      this.vfx.spawnImpact(hit.point, hit.normal);
      this.decals.spawnAt(hit.point, hit.normal);
    }
  }

  private handleEnemyShot(ev: {
    origin: Vector3;
    direction: Vector3;
    damage: number;
  }): void {
    // Simple accuracy: chance to hit based on distance + randomness
    const toPlayer = this.tmp.copy(this.player.getEyePosition()).sub(ev.origin);
    const dist = toPlayer.length();
    toPlayer.normalize();
    const align = toPlayer.dot(ev.direction);
    const hitChance = Math.max(0, align) * MathUtilsClamp(1.15 - dist / 55, 0.15, 0.85);

    this.vfx.spawnMuzzleFlash(ev.origin, ev.direction, 10);

    if (Math.random() < hitChance && this.playing && !this.player.isDead()) {
      const dmg = ev.damage * (0.7 + Math.random() * 0.5);
      this.player.takeDamage(dmg);
      this.hud.setDamage(1 - this.player.health / this.player.maxHealth, true);
      this.post.setDamageIntensity(
        MathUtilsClamp(1 - this.player.health / this.player.maxHealth, 0, 1),
      );
      this.hud.setVitals({
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        armor: this.player.armor,
        maxArmor: this.player.maxArmor,
      });
      this.cameraFeel.triggerDamageShake(0.55 + dmg / 80);

      if (this.player.isDead()) {
        this.onPlayerDeath();
      }
    }
  }

  private onPlayerDeath(): void {
    this.hud.setDamage(1, true);
    this.hud.pushKillfeed({
      killer: 'Hostile',
      victim: 'You',
      weapon: 'Rifle',
    });
    setTimeout(() => {
      if (!this.playing) return;
      this.player.revive(true);
      this.player.setPosition(
        this.level.playerSpawn.x,
        this.level.playerSpawn.y,
        this.level.playerSpawn.z,
      );
      this.post.setDamageIntensity(0);
      this.hud.clearDamage();
      this.hud.setVitals({
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        armor: this.player.armor,
        maxArmor: this.player.maxArmor,
      });
      this.player.requestPointerLock(this.renderer.renderer.domElement);
    }, 2200);
  }

  private syncAmmoHud(): void {
    const ammo = this.weapons.getAmmo();
    if (ammo) {
      this.hud.setAmmo({
        magazine: ammo.mag,
        reserve: ammo.reserve,
        magazineSize: ammo.magSize,
      });
    } else {
      this.hud.setAmmo({ magazine: 0, reserve: 0, magazineSize: 0 });
    }
  }

  private onResize = (): void => {
    this.renderer.setSize();
    this.syncPostSize();
    const cam = this.player.camera;
    cam.aspect =
      (this.app.clientWidth || window.innerWidth) /
      Math.max(1, this.app.clientHeight || window.innerHeight);
    cam.updateProjectionMatrix();
  };

  private syncPostSize(): void {
    const w = this.app.clientWidth || window.innerWidth;
    const h = this.app.clientHeight || window.innerHeight;
    this.post.setSize(w, h);
  }

  private onPointerLock = (): void => {
    if (!this.playing) return;
    if (document.pointerLockElement === null && !this.player.isDead()) {
      this.paused = true;
      this.menu.show();
      this.hud.setVisible(false);
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' && this.playing) {
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
    }
  };

  private loop = (): void => {
    this.animId = requestAnimationFrame(this.loop);
    const dt = this.clock.getDelta();

    if (this.playing && !this.paused && !this.menu.isVisible()) {
      this.updateGameplay(dt);
    } else if (!this.playing) {
      // Idle menu camera drift using renderer camera
      const t = this.clock.getElapsed();
      const cam = this.renderer.camera;
      cam.position.set(
        Math.sin(t * 0.08) * 18,
        9 + Math.sin(t * 0.15) * 0.6,
        22 + Math.cos(t * 0.07) * 8,
      );
      cam.lookAt(0, 2.5, 0);
      this.post.setCamera(cam);
    }

    this.vfx.update(dt);
    this.decals.update(dt);
    this.post.render(dt);
  };

  private updateGameplay(dt: number): void {
    this.post.setCamera(this.player.camera);

    this.player.update(dt, this.level.colliders);
    this.enemies.update(dt, this.player.getPositionRef());

    const hitscanTargets = asHitscanEnemies(this.enemies.getAlive());
    this.weapons.update(dt, this.renderer.scene, hitscanTargets);

    this.cameraFeel.update(
      dt,
      this.player.isMoving(),
      this.player.isSprinting(),
      this.weapons.isADS(),
      this.player.isGrounded(),
    );

    // Footsteps
    if (this.player.isGrounded() && this.player.isMoving()) {
      const speed = this.player.getHorizontalSpeed();
      this.footstepTimer -= dt;
      const interval = this.player.isSprinting() ? 0.32 : 0.48;
      if (this.footstepTimer <= 0 && speed > 0.8) {
        this.audio.playFootstep('concrete', this.player.isSprinting() ? 1.1 : 0.85);
        this.footstepTimer = interval;
      }
    } else {
      this.footstepTimer = 0;
    }

    // HUD sync
    const weaponName = this.weapons.getActiveDef().name;
    if (weaponName !== this.lastWeaponName) {
      this.lastWeaponName = weaponName;
      this.hud.setWeaponName(weaponName);
    }
    this.syncAmmoHud();
    this.hud.setVitals({
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      armor: this.player.armor,
      maxArmor: this.player.maxArmor,
    });
    this.hud.setCompassYaw(this.player.getYaw());

    const spread = this.weapons.isADS()
      ? 3
      : this.player.isSprinting()
        ? 18
        : this.player.isMoving()
          ? 10
          : 5;
    this.hud.setCrosshairSpread(spread);

    const dmgIntensity = MathUtilsClamp(
      1 - this.player.health / this.player.maxHealth,
      0,
      1,
    );
    this.post.setDamageIntensity(dmgIntensity * 0.85);
    if (dmgIntensity < 0.05) this.hud.clearDamage();
  }

  dispose(): void {
    cancelAnimationFrame(this.animId);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('pointerlockchange', this.onPointerLock);
    window.removeEventListener('keydown', this.onKeyDown);
    this.weapons.dispose();
    this.player.dispose();
    this.enemies.dispose();
    this.vfx.dispose();
    this.decals.dispose();
    this.level.dispose();
    this.lighting.dispose();
    this.environment.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.hud.dispose();
    this.menu.dispose();
    this.audio.dispose();
  }
}

function MathUtilsClamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// Boot
const game = new Game();

/** Headless / QA hooks for cinematic captures without pointer lock. */
declare global {
  interface Window {
    __BLACKOPS__?: {
      start: () => Promise<void>;
      look: (yaw: number, pitch: number) => void;
      moveTo: (x: number, y: number, z: number) => void;
      fire: () => void;
      debug: () => {
        pos: { x: number; y: number; z: number };
        grounded: boolean;
        colliders: number;
        yaw: number;
        pitch: number;
      };
    };
  }
}

window.__BLACKOPS__ = {
  start: async () => {
    await game['audio'].unlock();
    game['menu'].hide();
    game['hud'].setVisible(true);
    game['playing'] = true;
    game['paused'] = false;
    game['post'].setCamera(game['player'].camera);
  },
  look: (yaw: number, pitch: number) => {
    game['player'].setLook(yaw, pitch);
  },
  moveTo: (x: number, y: number, z: number) => {
    game['player'].setPosition(x, Math.max(0, y), z);
  },
  fire: () => {
    const w = game['weapons'] as unknown as { keys: Set<string> };
    w.keys.add('MouseLeft');
    setTimeout(() => w.keys.delete('MouseLeft'), 80);
  },
  debug: () => {
    const p = game['player'];
    return {
      pos: p.getPosition(),
      grounded: p.isGrounded(),
      colliders: game['level'].colliders.length,
      yaw: p.getYaw(),
      pitch: p.getPitch(),
    };
  },
};

void game;
