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
  /** View-punch spring constants. Underdamped on purpose: kick, overshoot, settle. */
  punchStiffness?: number;
  punchDamping?: number;
  /** Extra FOV while a slide is active. */
  slideFovBoost?: number;
}

/** Transient camera-only recoil. Never folded back into player aim angles. */
export interface ViewPunch {
  pitch: number;
  yaw: number;
  roll: number;
}

/** Springs are integrated in fixed slices so a long frame cannot destabilise them. */
const MAX_SPRING_SLICE = 1 / 120;

/**
 * First-person camera feel layered on PlayerController's camera:
 * head bob, landing dip, ADS FOV lerp, damage shake, idle breath, plus a
 * view-punch spring for weapon recoil and slide/mantle traversal impulses.
 *
 * Every impulse here is presentation-only. Aim-changing recoil stays in
 * WeaponSystem so that replaying a tick cannot depend on render timing.
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

  // View punch (recoil) spring — pitch/yaw/roll radians plus their velocities.
  private punchPitch = 0;
  private punchYaw = 0;
  private punchRoll = 0;
  private punchVelPitch = 0;
  private punchVelYaw = 0;
  private punchVelRoll = 0;

  // Traversal springs.
  private slideBlend = 0;
  private slideSurge = 0;
  private slideSurgeVel = 0;
  private mantleLift = 0;
  private mantleLiftVel = 0;

  private bobAmpWalk: number;
  private bobAmpSprint: number;
  private bobFreqWalk: number;
  private bobFreqSprint: number;
  private breathAmp: number;
  private breathFreq: number;
  private landKickMax: number;
  private shakeDecay: number;
  private punchStiffness: number;
  private punchDamping: number;
  private slideFovBoost: number;
  private motionScale = 1;

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
    this.punchStiffness = options.punchStiffness ?? 320;
    this.punchDamping = options.punchDamping ?? 24;
    this.slideFovBoost = options.slideFovBoost ?? 9;

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
    // Hard landings also throw the view down briefly rather than only dipping
    // the eye position, which is what sells weight at speed.
    if (impact > 0.35) this.addViewPunch(-0.02 * impact, 0, 0.008 * impact);
  }

  /**
   * Camera-only recoil impulse in radians. Positive pitch kicks the view up.
   * Applied as spring velocity so successive shots stack into a rising, settling
   * pattern instead of snapping to a fixed offset.
   */
  addViewPunch(pitch: number, yaw = 0, roll = 0): void {
    const scale = 34 * this.motionScale;
    this.punchVelPitch += pitch * scale;
    this.punchVelYaw += yaw * scale;
    this.punchVelRoll += roll * scale;
  }

  /** Forward/down surge as a slide begins, scaled by entry speed. */
  notifySlideStart(speed: number): void {
    const energy = MathUtils.clamp(speed / 10.2, 0, 1.4) * this.motionScale;
    if (energy <= 0) return;
    this.slideSurgeVel += energy * 9.5;
    this.addViewPunch(-0.026 * energy, 0, 0.03 * energy);
  }

  /** Upward surge as the player pulls over a ledge, scaled by ledge height. */
  notifyMantle(height: number): void {
    const lift = MathUtils.clamp(height, 0, 1.4) * this.motionScale;
    if (lift <= 0) return;
    this.mantleLiftVel += lift * 5.2;
    this.addViewPunch(-0.05 * lift, 0, -0.028 * lift);
    this.triggerDamageShake(0.18 * lift);
  }

  /** Distance-attenuated blast shake for explosions near the camera. */
  notifyExplosion(distance: number, radius: number, magnitude = 1): void {
    if (radius <= 0) return;
    const falloff = MathUtils.clamp(1 - distance / radius, 0, 1);
    if (falloff <= 0) return;
    const power = falloff * falloff * magnitude;
    this.triggerDamageShake(1.15 * power);
    this.addViewPunch(0.055 * power, 0, 0.04 * power);
  }

  setReducedMotion(reduced: boolean): void {
    this.motionScale = reduced ? 0.22 : 1;
    if (reduced) {
      this.shakeIntensity *= 0.25;
      this.landOffset *= 0.25;
      this.punchPitch *= 0.25;
      this.punchYaw *= 0.25;
      this.punchRoll *= 0.25;
      this.punchVelPitch *= 0.25;
      this.punchVelYaw *= 0.25;
      this.punchVelRoll *= 0.25;
    }
  }

  /** Current transient recoil offset (radians). Zero once fully settled. */
  getViewPunch(): ViewPunch {
    return { pitch: this.punchPitch, yaw: this.punchYaw, roll: this.punchRoll };
  }

  /** 0 while standing, 1 at full slide, used by HUD/audio for slide feedback. */
  getSlideBlend(): number {
    return this.slideBlend;
  }

  /**
   * Apply feel offsets for this frame.
   *
   * @param sliding Overrides the player's slide state for standalone use.
   */
  update(
    dt: number,
    moving: boolean,
    sprinting: boolean,
    ads: boolean,
    grounded: boolean,
    sliding?: boolean,
  ): void {
    const clampedDt = Math.min(dt, 0.05);

    if (this.player) {
      const pulse = this.player.consumeDamagePulse();
      if (pulse > 0) this.triggerDamageShake(pulse * 0.85);

      if (this.player.justDidLand()) {
        this.notifyLand(this.player.getLandImpact());
      }
      const slideSpeed = this.player.consumeSlideStart();
      if (slideSpeed > 0) this.notifySlideStart(slideSpeed);
      const mantleHeight = this.player.consumeMantle();
      if (mantleHeight > 0) this.notifyMantle(mantleHeight);
    }

    const isSliding = sliding ?? this.player?.isSliding() ?? false;
    const baseEyeY = this.player ? this.player.getEyeHeight() : this.camera.position.y;
    const basePitch = this.player ? this.player.getPitch() : this.camera.rotation.x;

    // Landing spring
    this.landVel += (-this.landOffset * 55 - this.landVel * 8) * clampedDt;
    this.landOffset += this.landVel * clampedDt;
    if (Math.abs(this.landOffset) < 1e-4 && Math.abs(this.landVel) < 1e-3) {
      this.landOffset = 0;
      this.landVel = 0;
    }

    this.integrateSprings(clampedDt);
    this.slideBlend = MathUtils.damp(this.slideBlend, isSliding ? 1 : 0, 13, clampedDt);

    // Head bob
    const wantBob = moving && grounded && !isSliding;
    const freq = sprinting ? this.bobFreqSprint : this.bobFreqWalk;
    const amp = (sprinting ? this.bobAmpSprint : this.bobAmpWalk) * this.motionScale;

    this.bobPhase += freq * clampedDt * (wantBob ? 1 : 0.15);
    this.bobBlend = MathUtils.damp(this.bobBlend, wantBob ? 1 : 0, 12, clampedDt);

    const bobY = Math.sin(this.bobPhase * 2) * amp * this.bobBlend;
    const bobX = Math.cos(this.bobPhase) * amp * 0.55 * this.bobBlend;

    // Idle breath
    this.breathPhase += this.breathFreq * clampedDt;
    const breathMul = ads ? 0.35 : sprinting ? 0.2 : 1;
    const breathY = Math.sin(this.breathPhase) * this.breathAmp * breathMul * this.motionScale;
    const breathPitch = Math.sin(this.breathPhase * 0.85) * 0.0012 * breathMul * this.motionScale;

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

    // A slide drops the eyeline below the crouch height and shoves the view
    // forward, so the traversal reads as committed weight rather than a crouch.
    const slideDip = this.slideBlend * 0.055 + this.slideSurge * 0.03;
    const slideRoll = this.slideBlend * 0.045 * this.motionScale;

    // Local camera position (child of player pivot)
    this.camera.position.set(
      bobX + this.shakeOffset.x,
      baseEyeY + bobY + breathY + this.landOffset + this.shakeOffset.y
        + this.mantleLift * 0.12 - slideDip,
      this.shakeOffset.z * 0.5 - this.slideSurge * 0.045,
    );

    const roll = -bobX * 2.8 + this.shakeOffset.x * 3.5 + slideRoll + this.punchRoll;
    const pitchTarget =
      breathPitch + bobY * 0.8 + this.landOffset * 0.9 + this.shakeOffset.y * 2.5
      - this.slideBlend * 0.03;
    this.feelPitch = MathUtils.damp(this.feelPitch, pitchTarget, 18, clampedDt);

    this.camera.rotation.set(basePitch + this.feelPitch + this.punchPitch, this.punchYaw, roll);

    // ADS / sprint FOV — ADS pulls in, sprint and slide punch outward.
    const targetFov = ads
      ? this.adsFov
      : sprinting && moving
        ? this.hipFov + 7
        : this.hipFov;
    const prevFov = this.camera.fov;
    const fovSpeed = ads ? 16 : sprinting ? 8 : 11;
    const slideFov = this.slideBlend * this.slideFovBoost * this.motionScale;
    this.camera.fov = MathUtils.damp(prevFov, targetFov + slideFov, fovSpeed, clampedDt);
    if (Math.abs(this.camera.fov - prevFov) > 0.01) {
      this.camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.shakeIntensity = 0;
    this.landOffset = 0;
    this.punchPitch = 0;
    this.punchYaw = 0;
    this.punchRoll = 0;
    this.punchVelPitch = 0;
    this.punchVelYaw = 0;
    this.punchVelRoll = 0;
  }

  private integrateSprings(dt: number): void {
    let remaining = dt;
    while (remaining > 1e-6) {
      const step = Math.min(MAX_SPRING_SLICE, remaining);
      remaining -= step;

      const k = this.punchStiffness;
      const c = this.punchDamping;
      this.punchVelPitch += (-k * this.punchPitch - c * this.punchVelPitch) * step;
      this.punchVelYaw += (-k * this.punchYaw - c * this.punchVelYaw) * step;
      this.punchVelRoll += (-k * this.punchRoll - c * this.punchVelRoll) * step;
      this.punchPitch += this.punchVelPitch * step;
      this.punchYaw += this.punchVelYaw * step;
      this.punchRoll += this.punchVelRoll * step;

      // Slide surge and mantle lift settle faster and never overshoot much:
      // they are a shove, not an oscillation.
      this.slideSurgeVel += (-90 * this.slideSurge - 15 * this.slideSurgeVel) * step;
      this.slideSurge += this.slideSurgeVel * step;
      this.mantleLiftVel += (-60 * this.mantleLift - 13 * this.mantleLiftVel) * step;
      this.mantleLift += this.mantleLiftVel * step;
    }

    if (Math.abs(this.punchPitch) < 1e-5 && Math.abs(this.punchVelPitch) < 1e-4) {
      this.punchPitch = 0;
      this.punchVelPitch = 0;
    }
    if (Math.abs(this.punchYaw) < 1e-5 && Math.abs(this.punchVelYaw) < 1e-4) {
      this.punchYaw = 0;
      this.punchVelYaw = 0;
    }
    if (Math.abs(this.punchRoll) < 1e-5 && Math.abs(this.punchVelRoll) < 1e-4) {
      this.punchRoll = 0;
      this.punchVelRoll = 0;
    }
    if (Math.abs(this.slideSurge) < 1e-5 && Math.abs(this.slideSurgeVel) < 1e-4) {
      this.slideSurge = 0;
      this.slideSurgeVel = 0;
    }
    if (Math.abs(this.mantleLift) < 1e-5 && Math.abs(this.mantleLiftVel) < 1e-4) {
      this.mantleLift = 0;
      this.mantleLiftVel = 0;
    }
  }
}
