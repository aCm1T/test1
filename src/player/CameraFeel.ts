import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import type { PlayerController } from './PlayerController';

export interface CameraFeelOptions {
  hipFov?: number;
  adsFov?: number;
  bobAmplitudeWalk?: number;
  bobAmplitudeSprint?: number;
  bobFrequencyWalk?: number;
  bobFrequencySprint?: number;
  breathAmplitude?: number;
  breathFrequency?: number;
  landKickMax?: number;
  shakeDecay?: number;
}

/**
 * First-person camera feel layered on PlayerController's camera:
 * head bob, landing dip, ADS FOV lerp (75→55), damage shake, idle breath.
 *
 * Call AFTER `PlayerController.update` so base eye height / pitch are set.
 */
export class CameraFeel {
  private readonly camera: PerspectiveCamera;
  private readonly player: PlayerController | null;

  hipFov: number;
  adsFov: number;

  private bobPhase = 0;
  private breathPhase = 0;
  private bobBlend = 0;
  private landOffset = 0;
  private landVel = 0;
  private shakeIntensity = 0;
  private shakeTime = 0;
  private feelPitch = 0;
  private readonly shakeOffset = new Vector3();

  private bobAmpWalk: number;
  private bobAmpSprint: number;
  private bobFreqWalk: number;
  private bobFreqSprint: number;
  private breathAmp: number;
  private breathFreq: number;
  private landKickMax: number;
  private shakeDecay: number;

  constructor(
    camera: PerspectiveCamera,
    player?: PlayerController | null,
    options: CameraFeelOptions = {},
  ) {
    this.camera = camera;
    this.player = player ?? null;

    this.hipFov = options.hipFov ?? 75;
    this.adsFov = options.adsFov ?? 55;
    this.bobAmpWalk = options.bobAmplitudeWalk ?? 0.018;
    this.bobAmpSprint = options.bobAmplitudeSprint ?? 0.032;
    this.bobFreqWalk = options.bobFrequencyWalk ?? 9.5;
    this.bobFreqSprint = options.bobFrequencySprint ?? 13.5;
    this.breathAmp = options.breathAmplitude ?? 0.0045;
    this.breathFreq = options.breathFrequency ?? 1.35;
    this.landKickMax = options.landKickMax ?? 0.085;
    this.shakeDecay = options.shakeDecay ?? 6.5;

    this.camera.fov = this.hipFov;
    this.camera.updateProjectionMatrix();
  }

  /** Trigger a damage camera shake (0–1+ intensity). */
  triggerDamageShake(intensity = 0.6): void {
    this.shakeIntensity = Math.max(this.shakeIntensity, Math.min(intensity, 2));
    this.shakeTime = 0;
  }

  /** Notify a landing impact (0–1+). */
  notifyLand(impact: number): void {
    const kick = MathUtils.clamp(impact, 0, 1.5) * this.landKickMax;
    this.landVel = -kick * 18;
    this.landOffset = Math.min(this.landOffset, -kick * 0.35);
  }

  /**
   * Apply feel offsets for this frame.
   */
  update(
    dt: number,
    moving: boolean,
    sprinting: boolean,
    ads: boolean,
    grounded: boolean,
  ): void {
    const clampedDt = Math.min(dt, 0.05);

    if (this.player) {
      const pulse = this.player.consumeDamagePulse();
      if (pulse > 0) this.triggerDamageShake(pulse * 0.85);

      if (this.player.justDidLand()) {
        this.notifyLand(this.player.getLandImpact());
      }
    }

    const baseEyeY = this.player ? this.player.getEyeHeight() : this.camera.position.y;
    const basePitch = this.player ? this.player.getPitch() : this.camera.rotation.x;

    // Landing spring
    this.landVel += (-this.landOffset * 55 - this.landVel * 8) * clampedDt;
    this.landOffset += this.landVel * clampedDt;
    if (Math.abs(this.landOffset) < 1e-4 && Math.abs(this.landVel) < 1e-3) {
      this.landOffset = 0;
      this.landVel = 0;
    }

    // Head bob
    const wantBob = moving && grounded;
    const freq = sprinting ? this.bobFreqSprint : this.bobFreqWalk;
    const amp = sprinting ? this.bobAmpSprint : this.bobAmpWalk;

    this.bobPhase += freq * clampedDt * (wantBob ? 1 : 0.15);
    this.bobBlend = MathUtils.damp(this.bobBlend, wantBob ? 1 : 0, 12, clampedDt);

    const bobY = Math.sin(this.bobPhase * 2) * amp * this.bobBlend;
    const bobX = Math.cos(this.bobPhase) * amp * 0.55 * this.bobBlend;

    // Idle breath
    this.breathPhase += this.breathFreq * clampedDt;
    const breathMul = ads ? 0.35 : sprinting ? 0.2 : 1;
    const breathY = Math.sin(this.breathPhase) * this.breathAmp * breathMul;
    const breathPitch = Math.sin(this.breathPhase * 0.85) * 0.0012 * breathMul;

    // Damage shake
    if (this.shakeIntensity > 0.001) {
      this.shakeTime += clampedDt;
      this.shakeIntensity *= Math.exp(-this.shakeDecay * clampedDt);
      const t = this.shakeTime * 40;
      this.shakeOffset.set(
        Math.sin(t * 1.7) * this.shakeIntensity * 0.028,
        Math.cos(t * 2.1) * this.shakeIntensity * 0.022,
        Math.sin(t * 1.3) * this.shakeIntensity * 0.01,
      );
      if (this.shakeIntensity < 0.002) {
        this.shakeIntensity = 0;
        this.shakeOffset.set(0, 0, 0);
      }
    } else {
      this.shakeOffset.set(0, 0, 0);
    }

    // Local camera position (child of player pivot)
    this.camera.position.set(
      bobX + this.shakeOffset.x,
      baseEyeY + bobY + breathY + this.landOffset + this.shakeOffset.y,
      this.shakeOffset.z * 0.5,
    );

    const roll = -bobX * 2.8 + this.shakeOffset.x * 3.5;
    const pitchTarget =
      breathPitch + bobY * 0.8 + this.landOffset * 0.9 + this.shakeOffset.y * 2.5;
    this.feelPitch = MathUtils.damp(this.feelPitch, pitchTarget, 18, clampedDt);

    this.camera.rotation.set(basePitch + this.feelPitch, 0, roll);

    // ADS / sprint FOV — hip 75, ADS 55, sprint adds a slight punch to 82
    const targetFov = ads
      ? this.adsFov
      : sprinting && moving
        ? this.hipFov + 7
        : this.hipFov;
    const prevFov = this.camera.fov;
    const fovSpeed = ads ? 16 : sprinting ? 8 : 11;
    this.camera.fov = MathUtils.damp(this.camera.fov, targetFov, fovSpeed, clampedDt);
    if (Math.abs(this.camera.fov - prevFov) > 0.01) {
      this.camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.shakeIntensity = 0;
    this.landOffset = 0;
  }
}
