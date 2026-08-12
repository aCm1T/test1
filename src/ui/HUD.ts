export interface HUDAmmoState {
  magazine: number;
  reserve: number;
  magazineSize: number;
}

export interface HUDVitalsState {
  health: number;
  maxHealth: number;
  armor: number;
  maxArmor: number;
}

export interface KillfeedEntry {
  killer: string;
  victim: string;
  weapon?: string;
  headshot?: boolean;
}

export type HUDObjectiveStatus = 'active' | 'completed' | 'failed';

export interface HUDObjectiveState {
  /** Short directive, for example "Disable the jammer". */
  title: string;
  /** Optional location or tactical context shown beneath the directive. */
  description?: string;
  /** Normalized objective completion, from 0 to 1. Omit for non-progress objectives. */
  progress?: number;
  /** Human-readable progress such as "42 SEC" or "2 / 4". */
  progressLabel?: string;
  status?: HUDObjectiveStatus;
}

export type HUDMissionResultKind = 'completed' | 'failed';

export interface HUDMissionResult {
  kind: HUDMissionResultKind;
  title?: string;
  subtitle?: string;
  /** Optional restart/continue hint. */
  action?: string;
}

interface KillfeedItem {
  el: HTMLElement;
  expires: number;
}

const ACCENT = '#e85d04';

/**
 * Maps WeaponSystem angular spread (radians) to crosshair half-gap (CSS px).
 * Tuned so hip AR (~0.022 rad) reads ~15px idle and bloom/sprint stay under the 48px clamp.
 */
export const CROSSHAIR_SPREAD_RAD_TO_PX = 700;

/** Convert simulation cone half-angle to the HUD half-gap setCrosshairSpread expects. */
export function angularSpreadToCrosshairPx(angularRadians: number): number {
  if (!Number.isFinite(angularRadians) || angularRadians <= 0) return 0;
  return angularRadians * CROSSHAIR_SPREAD_RAD_TO_PX;
}

/**
 * COD-style HTML HUD overlay injected into `#app`.
 * Crosshair, ammo, health/armor, hitmarker, damage vignette, killfeed,
 * weapon name, compass, interact prompts.
 */
export class HUD {
  readonly root: HTMLElement;

  private crosshair!: HTMLElement;
  private crossTop!: HTMLElement;
  private crossBottom!: HTMLElement;
  private crossLeft!: HTMLElement;
  private crossRight!: HTMLElement;
  private ammoMag!: HTMLElement;
  private ammoReserve!: HTMLElement;
  private healthFill!: HTMLElement;
  private armorFill!: HTMLElement;
  private healthValue!: HTMLElement;
  private armorValue!: HTMLElement;
  private hitmarker!: HTMLElement;
  private damageVignette!: HTMLElement;
  private killfeed!: HTMLElement;
  private weaponName!: HTMLElement;
  private compassStrip!: HTMLElement;
  private compassLabel!: HTMLElement;
  private interactPrompt!: HTMLElement;
  private objective!: HTMLElement;
  private objectiveTitle!: HTMLElement;
  private objectiveDescription!: HTMLElement;
  private objectiveProgress!: HTMLElement;
  private objectiveProgressFill!: HTMLElement;
  private objectiveProgressLabel!: HTMLElement;
  private checkpoint!: HTMLElement;
  private checkpointLabel!: HTMLElement;
  private missionResult!: HTMLElement;
  private missionResultKicker!: HTMLElement;
  private missionResultTitle!: HTMLElement;
  private missionResultSubtitle!: HTMLElement;
  private missionResultAction!: HTMLElement;

  private spread = 0;
  private targetSpread = 4;
  private hitmarkerTimer = 0;
  private damageFlash = 0;
  private yaw = 0;
  private readonly killItems: KillfeedItem[] = [];
  private disposed = false;
  private raf = 0;
  private lastTime = performance.now();
  private checkpointTimer: number | undefined;

  constructor(container?: HTMLElement) {
    const mount = container ?? document.getElementById('app') ?? document.body;
    this.root = document.createElement('div');
    this.root.id = 'hud-root';
    this.root.className = 'hud-root';
    this.root.innerHTML = this.buildMarkup();
    mount.appendChild(this.root);
    this.cacheElements();
    this.setVisible(false);
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hud-hidden', !visible);
    this.root.setAttribute('aria-hidden', visible ? 'false' : 'true');
  }

  /** Show, update, or clear the current mission objective. */
  setObjective(state: HUDObjectiveState | null): void {
    if (!state) {
      this.objective.classList.remove('hud-objective-visible');
      this.objective.setAttribute('aria-hidden', 'true');
      return;
    }

    const status = state.status ?? 'active';
    this.objective.dataset.status = status;
    this.objectiveTitle.textContent = state.title;
    this.objectiveDescription.textContent = state.description ?? '';
    this.objectiveDescription.hidden = !state.description;
    this.objective.classList.add('hud-objective-visible');
    this.objective.setAttribute('aria-hidden', 'false');

    const hasProgress = Number.isFinite(state.progress);
    this.objectiveProgress.hidden = !hasProgress;
    if (hasProgress) {
      const progress = Math.min(1, Math.max(0, state.progress ?? 0));
      this.objectiveProgressFill.style.transform = `scaleX(${progress})`;
      this.objectiveProgressLabel.textContent =
        state.progressLabel ?? `${Math.round(progress * 100)}%`;
    }
  }

  /** Update objective progress without replacing its title or status. */
  setObjectiveProgress(progress: number, label?: string): void {
    const normalized = Math.min(1, Math.max(0, progress));
    this.objectiveProgress.hidden = false;
    this.objectiveProgressFill.style.transform = `scaleX(${normalized})`;
    this.objectiveProgressLabel.textContent = label ?? `${Math.round(normalized * 100)}%`;
  }

  /** Present an automatically dismissing checkpoint confirmation. */
  showCheckpoint(label = 'Checkpoint reached', durationMs = 2400): void {
    if (this.checkpointTimer !== undefined) window.clearTimeout(this.checkpointTimer);
    const duration = Math.max(600, durationMs);
    this.checkpointLabel.textContent = label;
    this.checkpoint.style.setProperty('--hud-checkpoint-duration', `${duration}ms`);
    this.checkpoint.classList.remove('hud-checkpoint-visible');
    // Restart the entrance animation when checkpoints arrive in quick succession.
    void this.checkpoint.offsetWidth;
    this.checkpoint.classList.add('hud-checkpoint-visible');
    this.checkpointTimer = window.setTimeout(() => {
      this.checkpoint.classList.remove('hud-checkpoint-visible');
      this.checkpointTimer = undefined;
    }, duration);
  }

  /** Show the full-screen mission completion/failure treatment. */
  showMissionResult(result: HUDMissionResult): void {
    const completed = result.kind === 'completed';
    this.missionResult.dataset.kind = result.kind;
    this.missionResultKicker.textContent = completed ? 'MISSION COMPLETE' : 'MISSION FAILED';
    this.missionResultTitle.textContent =
      result.title ?? (completed ? 'Objective secured' : 'Operator down');
    this.missionResultSubtitle.textContent =
      result.subtitle ??
      (completed ? 'Extraction confirmed. Stand by for debrief.' : resolveDeathRestoreSubtitle(false));
    this.missionResultAction.textContent = result.action ?? '';
    this.missionResultAction.hidden = !result.action;
    this.missionResult.classList.add('hud-result-visible');
    this.missionResult.setAttribute('aria-hidden', 'false');
  }

  clearMissionResult(): void {
    this.missionResult.classList.remove('hud-result-visible');
    this.missionResult.setAttribute('aria-hidden', 'true');
  }

  setCrosshairVisible(visible: boolean): void {
    this.crosshair.classList.toggle('hud-crosshair-disabled', !visible);
  }

  /** Mirrors the accessibility setting without changing global page preferences. */
  setReducedMotion(reduced: boolean): void {
    this.root.classList.toggle('hud-reduced-motion', reduced);
  }

  /** Dynamic crosshair half-gap in CSS pixels. */
  setCrosshairSpread(spread: number): void {
    this.targetSpread = Math.max(2, Math.min(48, spread));
  }

  /**
   * Drive the crosshair from WeaponSystem.getCurrentSpread() so movement bloom,
   * sustained-fire bloom, and ADS tightening match the hitscan cone.
   */
  setCrosshairFromWeaponSpread(angularRadians: number): void {
    this.setCrosshairSpread(angularSpreadToCrosshairPx(angularRadians));
  }

  setAmmo(state: HUDAmmoState): void {
    this.ammoMag.textContent = String(Math.max(0, Math.floor(state.magazine)));
    this.ammoReserve.textContent = String(Math.max(0, Math.floor(state.reserve)));
    const low = state.magazine <= Math.max(1, Math.floor(state.magazineSize * 0.25));
    this.ammoMag.classList.toggle('hud-ammo-low', low);
  }

  setVitals(state: HUDVitalsState): void {
    const hpPct = state.maxHealth > 0 ? (state.health / state.maxHealth) * 100 : 0;
    const arPct = state.maxArmor > 0 ? (state.armor / state.maxArmor) * 100 : 0;
    this.healthFill.style.width = `${Math.min(100, Math.max(0, hpPct))}%`;
    this.armorFill.style.width = `${Math.min(100, Math.max(0, arPct))}%`;
    this.healthValue.textContent = String(Math.max(0, Math.ceil(state.health)));
    this.armorValue.textContent = String(Math.max(0, Math.ceil(state.armor)));
    this.healthFill.classList.toggle('hud-bar-critical', hpPct <= 25);
  }

  setWeaponName(name: string): void {
    this.weaponName.textContent = name.toUpperCase();
  }

  /** Player yaw in radians — drives compass. */
  setCompassYaw(yaw: number): void {
    this.yaw = yaw;
  }

  showHitmarker(headshot = false): void {
    this.hitmarkerTimer = headshot ? 0.28 : 0.18;
    this.hitmarker.classList.toggle('hud-hitmarker-hs', headshot);
    this.hitmarker.classList.add('hud-hitmarker-active');
  }

  /**
   * Drop an in-flight hitmarker — used when combat telemetry is rewound
   * (death restore / rematch / QA / session restore). Death-delay frag credits
   * can arm the marker after the world already rewound.
   */
  clearHitmarker(): void {
    this.hitmarkerTimer = 0;
    this.hitmarker.classList.remove('hud-hitmarker-active', 'hud-hitmarker-hs');
  }

  /**
   * Instant damage flash + lingering vignette strength 0–1.
   */
  setDamage(intensity: number, flash = true): void {
    const d = Math.min(1, Math.max(0, intensity));
    this.damageVignette.style.opacity = String(0.15 + d * 0.75);
    if (flash) {
      this.damageFlash = 0.35;
      this.root.classList.add('hud-damage-flash');
    }
  }

  clearDamage(): void {
    this.damageFlash = 0;
    this.damageVignette.style.opacity = '0';
    this.root.classList.remove('hud-damage-flash');
  }

  /** Drop all killfeed rows — used when combat telemetry is rewound (death restore). */
  clearKillfeed(): void {
    while (this.killItems.length > 0) {
      const item = this.killItems.pop();
      item?.el.remove();
    }
    this.killfeed.replaceChildren();
  }

  pushKillfeed(entry: KillfeedEntry): void {
    const el = document.createElement('div');
    el.className = 'hud-killfeed-item';
    const weapon = entry.weapon ? `<span class="hud-kf-weapon">${escapeHtml(entry.weapon)}</span>` : '';
    const hs = entry.headshot ? '<span class="hud-kf-hs">⬤</span>' : '';
    el.innerHTML = `
      <span class="hud-kf-killer">${escapeHtml(entry.killer)}</span>
      ${weapon}${hs}
      <span class="hud-kf-victim">${escapeHtml(entry.victim)}</span>
    `;
    this.killfeed.prepend(el);
    this.killItems.push({ el, expires: performance.now() + 5000 });
    while (this.killItems.length > 6) {
      const old = this.killItems.shift();
      old?.el.remove();
    }
  }

  showInteract(text: string | null): void {
    if (!text) {
      this.interactPrompt.classList.remove('hud-prompt-visible');
      this.interactPrompt.textContent = '';
      return;
    }
    // PlayerController accepts both E and F for interact — show both.
    this.interactPrompt.innerHTML = formatInteractPrompt(text);
    this.interactPrompt.classList.add('hud-prompt-visible');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.checkpointTimer !== undefined) window.clearTimeout(this.checkpointTimer);
    this.root.remove();
  }

  private tick(now: number): void {
    if (this.disposed) return;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.spread += (this.targetSpread - this.spread) * Math.min(1, dt * 18);
    const s = this.spread;
    this.crossTop.style.transform = `translate(-50%, calc(-100% - ${s}px))`;
    this.crossBottom.style.transform = `translate(-50%, ${s}px)`;
    this.crossLeft.style.transform = `translate(calc(-100% - ${s}px), -50%)`;
    this.crossRight.style.transform = `translate(${s}px, -50%)`;

    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= dt;
      if (this.hitmarkerTimer <= 0) {
        this.hitmarker.classList.remove('hud-hitmarker-active');
      }
    }

    if (this.damageFlash > 0) {
      this.damageFlash -= dt;
      if (this.damageFlash <= 0) {
        this.root.classList.remove('hud-damage-flash');
      }
    }

    // Compass: degrees, 0 = North
    const deg = ((-this.yaw * 180) / Math.PI + 360) % 360;
    this.compassLabel.textContent = bearingLabel(deg);
    const offset = (deg / 360) * -400;
    this.compassStrip.style.transform = `translateX(calc(-50% + ${offset}px))`;

    const nowMs = now;
    for (let i = this.killItems.length - 1; i >= 0; i--) {
      if (nowMs >= this.killItems[i].expires) {
        this.killItems[i].el.classList.add('hud-killfeed-fade');
        const el = this.killItems[i].el;
        this.killItems.splice(i, 1);
        setTimeout(() => el.remove(), 400);
      }
    }

    this.raf = requestAnimationFrame(this.tick);
  }

  private cacheElements(): void {
    this.crosshair = this.root.querySelector('.hud-crosshair')!;
    this.crossTop = this.root.querySelector('.hud-cross-t')!;
    this.crossBottom = this.root.querySelector('.hud-cross-b')!;
    this.crossLeft = this.root.querySelector('.hud-cross-l')!;
    this.crossRight = this.root.querySelector('.hud-cross-r')!;
    this.ammoMag = this.root.querySelector('.hud-ammo-mag')!;
    this.ammoReserve = this.root.querySelector('.hud-ammo-reserve')!;
    this.healthFill = this.root.querySelector('.hud-health-fill')!;
    this.armorFill = this.root.querySelector('.hud-armor-fill')!;
    this.healthValue = this.root.querySelector('.hud-health-val')!;
    this.armorValue = this.root.querySelector('.hud-armor-val')!;
    this.hitmarker = this.root.querySelector('.hud-hitmarker')!;
    this.damageVignette = this.root.querySelector('.hud-damage-vignette')!;
    this.killfeed = this.root.querySelector('.hud-killfeed')!;
    this.weaponName = this.root.querySelector('.hud-weapon-name')!;
    this.compassStrip = this.root.querySelector('.hud-compass-strip')!;
    this.compassLabel = this.root.querySelector('.hud-compass-label')!;
    this.interactPrompt = this.root.querySelector('.hud-interact')!;
    this.objective = this.root.querySelector('.hud-objective')!;
    this.objectiveTitle = this.root.querySelector('.hud-objective-title')!;
    this.objectiveDescription = this.root.querySelector('.hud-objective-description')!;
    this.objectiveProgress = this.root.querySelector('.hud-objective-progress')!;
    this.objectiveProgressFill = this.root.querySelector('.hud-objective-progress-fill')!;
    this.objectiveProgressLabel = this.root.querySelector('.hud-objective-progress-label')!;
    this.checkpoint = this.root.querySelector('.hud-checkpoint')!;
    this.checkpointLabel = this.root.querySelector('.hud-checkpoint-label')!;
    this.missionResult = this.root.querySelector('.hud-mission-result')!;
    this.missionResultKicker = this.root.querySelector('.hud-result-kicker')!;
    this.missionResultTitle = this.root.querySelector('.hud-result-title')!;
    this.missionResultSubtitle = this.root.querySelector('.hud-result-subtitle')!;
    this.missionResultAction = this.root.querySelector('.hud-result-action')!;
    void this.crosshair;
  }

  private buildMarkup(): string {
    const ticks = buildCompassTicks();
    return `
      <div class="hud-damage-vignette" aria-hidden="true"></div>

      <div class="hud-compass">
        <div class="hud-compass-window">
          <div class="hud-compass-strip">${ticks}</div>
        </div>
        <div class="hud-compass-needle"></div>
        <div class="hud-compass-label">N</div>
      </div>

      <div class="hud-killfeed" aria-live="polite"></div>

      <section class="hud-objective" data-status="active" aria-live="polite" aria-hidden="true">
        <div class="hud-objective-rule"></div>
        <p class="hud-objective-kicker"><span class="hud-objective-diamond"></span> CURRENT OBJECTIVE</p>
        <h2 class="hud-objective-title">Awaiting orders</h2>
        <p class="hud-objective-description" hidden></p>
        <div class="hud-objective-progress" hidden>
          <div class="hud-objective-progress-track">
            <div class="hud-objective-progress-fill"></div>
          </div>
          <span class="hud-objective-progress-label">0%</span>
        </div>
      </section>

      <div class="hud-checkpoint" role="status" aria-live="polite">
        <span class="hud-checkpoint-icon">◇</span>
        <span class="hud-checkpoint-copy">
          <small>PROGRESS SAVED</small>
          <b class="hud-checkpoint-label">Checkpoint reached</b>
        </span>
      </div>

      <div class="hud-crosshair" aria-hidden="true">
        <span class="hud-cross-arm hud-cross-t"></span>
        <span class="hud-cross-arm hud-cross-b"></span>
        <span class="hud-cross-arm hud-cross-l"></span>
        <span class="hud-cross-arm hud-cross-r"></span>
        <span class="hud-cross-dot"></span>
      </div>

      <div class="hud-hitmarker" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
      </div>

      <div class="hud-interact" role="status"></div>

      <section class="hud-mission-result" aria-live="assertive" aria-hidden="true">
        <div class="hud-result-scan"></div>
        <div class="hud-result-content">
          <p class="hud-result-kicker">MISSION COMPLETE</p>
          <h2 class="hud-result-title">Objective secured</h2>
          <p class="hud-result-subtitle">Extraction confirmed. Stand by for debrief.</p>
          <p class="hud-result-action" hidden></p>
        </div>
      </section>

      <div class="hud-bottom-left">
        <div class="hud-vitals">
          <div class="hud-bar-row">
            <span class="hud-bar-icon" style="color:${ACCENT}">✚</span>
            <div class="hud-bar hud-bar-health">
              <div class="hud-health-fill"></div>
            </div>
            <span class="hud-health-val">100</span>
          </div>
          <div class="hud-bar-row">
            <span class="hud-bar-icon">⬡</span>
            <div class="hud-bar hud-bar-armor">
              <div class="hud-armor-fill"></div>
            </div>
            <span class="hud-armor-val">100</span>
          </div>
        </div>
      </div>

      <div class="hud-bottom-right">
        <div class="hud-weapon-name">ASSAULT RIFLE</div>
        <div class="hud-ammo">
          <span class="hud-ammo-mag">30</span>
          <span class="hud-ammo-sep">/</span>
          <span class="hud-ammo-reserve">120</span>
        </div>
      </div>
    `;
  }
}

/** Interact binding shown on prompts; matches PlayerController KeyE / KeyF. */
export const INTERACT_PROMPT_KEYS = 'E/F' as const;

/** Markup for an on-screen interact cue (both accepted keys). */
export function formatInteractPrompt(text: string): string {
  return `<kbd>E</kbd>/<kbd>F</kbd> <span>${escapeHtml(text)}</span>`;
}

/**
 * Single HUD interact slot: jammer/objective prompts beat wave toasts so
 * syncMissionHud cannot wipe an in-range interact, while an active toast keeps
 * the slot when nothing higher-priority is showing.
 */
export function resolveMissionInteractPrompt(options: {
  jammerInteractAvailable: boolean;
  waveToastRemaining: number;
}): string | null {
  if (options.jammerInteractAvailable) return 'DISABLE SIGNAL JAMMER';
  if (options.waveToastRemaining > 0) return 'INCOMING — HOSTILES REINFORCING';
  return null;
}

/** Death overlay copy must match restoreCheckpoint vs resetRunToOpening. */
export function resolveDeathRestoreSubtitle(hasCheckpoint: boolean): string {
  return hasCheckpoint
    ? 'Restoring the last secure checkpoint.'
    : 'Restarting Operation Nightglass.';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bearingLabel(deg: number): string {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(deg / 45) % 8;
  return labels[idx];
}

function buildCompassTicks(): string {
  const dirs = [
    { d: 0, l: 'N' },
    { d: 45, l: 'NE' },
    { d: 90, l: 'E' },
    { d: 135, l: 'SE' },
    { d: 180, l: 'S' },
    { d: 225, l: 'SW' },
    { d: 270, l: 'W' },
    { d: 315, l: 'NW' },
  ];
  // Triple the strip so scrolling wraps visually
  let html = '';
  for (let copy = -1; copy <= 1; copy++) {
    for (const dir of dirs) {
      const x = copy * 400 + (dir.d / 360) * 400;
      html += `<span class="hud-compass-tick" style="left:${x}px"><i></i><b>${dir.l}</b></span>`;
      for (let m = 1; m < 4; m++) {
        const mx = x + (m * 400) / 8;
        html += `<span class="hud-compass-minor" style="left:${mx}px"></span>`;
      }
    }
  }
  return html;
}
