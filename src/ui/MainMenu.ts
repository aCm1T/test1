import { normalizeQualityPreference, type QualityPreference } from '../engine';
import { requestPointerLockSafely } from '../player/PointerLock';

export interface MainMenuSettings {
  sensitivity: number;
  masterVolume: number;
  sfxVolume: number;
  /** ADS look sensitivity multiplier. Defaults to 0.8 for legacy callers. */
  adsMultiplier?: number;
  /** Horizontal/engine camera field of view in degrees. Defaults to 90. */
  fieldOfView?: number;
  reducedMotion?: boolean;
  toggleADS?: boolean;
  showCrosshair?: boolean;
  /** A capability-capped graphics preference; never forces an unsafe tier. */
  graphicsTier?: QualityPreference;
}

export interface MainMenuCallbacks {
  onPlay: (settings: MainMenuSettings) => void;
  onSettingsChange?: (settings: MainMenuSettings) => void;
  onRestart?: () => void;
  onReturnToMenu?: () => void;
}

export const DEFAULT_MAIN_MENU_SETTINGS: Required<MainMenuSettings> = {
  sensitivity: 1.0,
  masterVolume: 0.85,
  sfxVolume: 1.0,
  adsMultiplier: 0.8,
  fieldOfView: 90,
  reducedMotion: false,
  toggleADS: false,
  showCrosshair: true,
  graphicsTier: 'auto',
};

/**
 * Full-screen cinematic main menu for BLACKOPS: FRONTLINE.
 * Play requests pointer lock; Settings for sensitivity/volume; Controls list.
 */
export class MainMenu {
  readonly root: HTMLElement;

  private settings: Required<MainMenuSettings>;
  private readonly callbacks: MainMenuCallbacks;
  private panelMain!: HTMLElement;
  private panelSettings!: HTMLElement;
  private panelControls!: HTMLElement;
  private graphicsListbox!: HTMLElement;
  private graphicsButton!: HTMLButtonElement;
  private graphicsOpen = false;
  private inSession = false;
  private disposed = false;

  constructor(callbacks: MainMenuCallbacks, container?: HTMLElement) {
    this.callbacks = callbacks;
    this.settings = { ...DEFAULT_MAIN_MENU_SETTINGS };
    try {
      const saved = JSON.parse(window.localStorage.getItem('nightglass.settings.v1') ?? 'null');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        this.settings = normalizeSettings({ ...this.settings, ...saved });
      }
    } catch { /* Storage may be unavailable; defaults remain playable. */ }

    const mount = container ?? document.getElementById('app') ?? document.body;
    this.root = document.createElement('div');
    this.root.id = 'main-menu';
    this.root.className = 'main-menu';
    this.root.innerHTML = this.buildMarkup();
    mount.appendChild(this.root);

    this.cacheElements();
    this.bindEvents();
    this.syncSliders();
    this.showPanel('main');
  }

  show(): void {
    this.root.classList.remove('main-menu-hidden');
    this.root.setAttribute('aria-hidden', 'false');
  }

  setInSession(inSession: boolean): void {
    this.inSession = inSession;
    const label = this.root.querySelector('[data-play-label]');
    if (label) label.textContent = inSession ? 'RESUME' : 'PLAY';
    const subtitle = this.root.querySelector('.mm-subtitle');
    if (subtitle) subtitle.textContent = inSession ? 'OPERATION PAUSED' : 'OPERATION NIGHTGLASS';
    const hint = this.root.querySelector('[data-deploy-hint]');
    if (hint) hint.textContent = inSession ? 'PRESS ENTER TO RESUME' : 'PRESS ENTER TO DEPLOY';
    this.root.querySelectorAll<HTMLElement>('[data-session-action]').forEach((element) => {
      element.hidden = !inSession;
    });
  }

  setLoading(loading: boolean): void {
    const play = this.root.querySelector<HTMLButtonElement>('[data-action="play"]');
    if (!play) return;
    play.disabled = loading || this.root.classList.contains('main-menu-launch-blocked');
    const label = this.root.querySelector('[data-play-label]');
    if (label) label.textContent = loading ? 'LOADING…' : this.inSession ? 'RESUME' : 'PLAY';
    this.root.classList.toggle('main-menu-loading', loading);
  }

  hide(): void {
    this.root.classList.add('main-menu-hidden');
    this.root.setAttribute('aria-hidden', 'true');
  }

  isVisible(): boolean {
    return !this.root.classList.contains('main-menu-hidden');
  }

  /**
   * Release builds are fail-closed: an incomplete authored asset package must
   * never silently launch into the procedural development route.
   */
  setLaunchBlocked(message: string | null): void {
    const play = this.root.querySelector<HTMLButtonElement>('[data-action="play"]');
    if (!play) return;
    play.disabled = message !== null;
    this.root.classList.toggle('main-menu-launch-blocked', message !== null);
    const notice = this.root.querySelector<HTMLElement>('[data-launch-notice]');
    if (notice) {
      notice.textContent = message ?? '';
      notice.hidden = message === null;
    }
  }

  getSettings(): MainMenuSettings {
    return { ...this.settings };
  }

  setSettings(partial: Partial<MainMenuSettings>): void {
    this.settings = normalizeSettings({ ...this.settings, ...partial });
    this.syncSliders();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
  }

  private cacheElements(): void {
    this.panelMain = this.root.querySelector('[data-panel="main"]')!;
    this.panelSettings = this.root.querySelector('[data-panel="settings"]')!;
    this.panelControls = this.root.querySelector('[data-panel="controls"]')!;
    this.graphicsListbox = this.root.querySelector('[data-graphics-listbox]')!;
    this.graphicsButton = this.root.querySelector('[data-graphics-button]')!;
  }

  private bindEvents(): void {
    this.root.querySelector('[data-action="play"]')?.addEventListener('click', () => {
      this.startPlay();
    });

    this.root.querySelector('[data-action="settings"]')?.addEventListener('click', () => {
      this.showPanel('settings');
    });

    this.root.querySelector('[data-action="controls"]')?.addEventListener('click', () => {
      this.showPanel('controls');
    });
    this.root.querySelector('[data-action="restart"]')?.addEventListener('click', () => {
      this.callbacks.onRestart?.();
    });
    this.root.querySelector('[data-action="return-menu"]')?.addEventListener('click', () => {
      this.callbacks.onReturnToMenu?.();
    });

    this.root.querySelectorAll('[data-action="back"]').forEach((btn) => {
      btn.addEventListener('click', () => this.showPanel('main'));
    });

    const sens = this.root.querySelector<HTMLInputElement>('#mm-sensitivity');
    const master = this.root.querySelector<HTMLInputElement>('#mm-master-vol');
    const sfx = this.root.querySelector<HTMLInputElement>('#mm-sfx-vol');
    const ads = this.root.querySelector<HTMLInputElement>('#mm-ads-multiplier');
    const fov = this.root.querySelector<HTMLInputElement>('#mm-fov');
    const reducedMotion = this.root.querySelector<HTMLInputElement>('#mm-reduced-motion');
    const toggleAds = this.root.querySelector<HTMLInputElement>('#mm-toggle-ads');
    const crosshair = this.root.querySelector<HTMLInputElement>('#mm-crosshair');
    const graphicsOptions = [...this.root.querySelectorAll<HTMLElement>('[role="option"][data-value]')];

    sens?.addEventListener('input', () => {
      this.settings.sensitivity = parseFloat(sens.value);
      this.updateSliderLabel('mm-sensitivity-val', this.settings.sensitivity.toFixed(2));
      this.emitSettings();
    });

    master?.addEventListener('input', () => {
      this.settings.masterVolume = parseFloat(master.value);
      this.updateSliderLabel('mm-master-vol-val', Math.round(this.settings.masterVolume * 100) + '%');
      this.emitSettings();
    });

    sfx?.addEventListener('input', () => {
      this.settings.sfxVolume = parseFloat(sfx.value);
      this.updateSliderLabel('mm-sfx-vol-val', Math.round(this.settings.sfxVolume * 100) + '%');
      this.emitSettings();
    });

    ads?.addEventListener('input', () => {
      this.settings.adsMultiplier = parseFloat(ads.value);
      this.updateSliderLabel('mm-ads-multiplier-val', `${this.settings.adsMultiplier.toFixed(2)}×`);
      this.emitSettings();
    });

    fov?.addEventListener('input', () => {
      this.settings.fieldOfView = parseInt(fov.value, 10);
      this.updateSliderLabel('mm-fov-val', `${this.settings.fieldOfView}°`);
      this.emitSettings();
    });

    reducedMotion?.addEventListener('change', () => {
      this.settings.reducedMotion = reducedMotion.checked;
      this.root.classList.toggle('mm-reduced-motion', reducedMotion.checked);
      this.emitSettings();
    });

    toggleAds?.addEventListener('change', () => {
      this.settings.toggleADS = toggleAds.checked;
      this.emitSettings();
    });

    crosshair?.addEventListener('change', () => {
      this.settings.showCrosshair = crosshair.checked;
      this.emitSettings();
    });

    this.graphicsButton.addEventListener('click', () => this.setGraphicsOpen(!this.graphicsOpen));
    this.graphicsButton.addEventListener('keydown', (event) => this.onGraphicsKeyDown(event));
    this.graphicsListbox.addEventListener('keydown', (event) => this.onGraphicsKeyDown(event));
    graphicsOptions.forEach((option) => option.addEventListener('click', () => {
      this.selectGraphics(option.dataset.value ?? 'auto');
    }));

    // Keyboard: Enter to play from main panel
    window.addEventListener('keydown', this.onKeyDown);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || !this.isVisible()) return;
    if (e.code === 'Escape' && this.graphicsOpen) {
      e.preventDefault();
      this.setGraphicsOpen(false, true);
      return;
    }
    if (e.code === 'Enter' && this.panelMain.classList.contains('mm-panel-active')) {
      e.preventDefault();
      this.startPlay();
    }
    if (e.code === 'Escape' && !this.panelMain.classList.contains('mm-panel-active')) {
      this.showPanel('main');
    }
  };

  private startPlay(): void {
    const play = this.root.querySelector<HTMLButtonElement>('[data-action="play"]');
    if (play?.disabled) return;
    const target = document.getElementById('app') ?? document.body;
    requestPointerLockSafely(target.querySelector('canvas') ?? target);
    this.hide();
    this.callbacks.onPlay(this.getSettings());
  }

  private showPanel(name: 'main' | 'settings' | 'controls'): void {
    this.setGraphicsOpen(false);
    this.panelMain.classList.toggle('mm-panel-active', name === 'main');
    this.panelSettings.classList.toggle('mm-panel-active', name === 'settings');
    this.panelControls.classList.toggle('mm-panel-active', name === 'controls');
  }

  private syncSliders(): void {
    const sens = this.root.querySelector<HTMLInputElement>('#mm-sensitivity');
    const master = this.root.querySelector<HTMLInputElement>('#mm-master-vol');
    const sfx = this.root.querySelector<HTMLInputElement>('#mm-sfx-vol');
    const ads = this.root.querySelector<HTMLInputElement>('#mm-ads-multiplier');
    const fov = this.root.querySelector<HTMLInputElement>('#mm-fov');
    const reducedMotion = this.root.querySelector<HTMLInputElement>('#mm-reduced-motion');
    const toggleAds = this.root.querySelector<HTMLInputElement>('#mm-toggle-ads');
    const crosshair = this.root.querySelector<HTMLInputElement>('#mm-crosshair');
    if (sens) sens.value = String(this.settings.sensitivity);
    if (master) master.value = String(this.settings.masterVolume);
    if (sfx) sfx.value = String(this.settings.sfxVolume);
    if (ads) ads.value = String(this.settings.adsMultiplier);
    if (fov) fov.value = String(this.settings.fieldOfView);
    if (reducedMotion) reducedMotion.checked = this.settings.reducedMotion;
    if (toggleAds) toggleAds.checked = this.settings.toggleADS;
    if (crosshair) crosshair.checked = this.settings.showCrosshair;
    this.syncGraphicsListbox();
    this.updateSliderLabel('mm-sensitivity-val', this.settings.sensitivity.toFixed(2));
    this.updateSliderLabel('mm-master-vol-val', Math.round(this.settings.masterVolume * 100) + '%');
    this.updateSliderLabel('mm-sfx-vol-val', Math.round(this.settings.sfxVolume * 100) + '%');
    this.updateSliderLabel('mm-ads-multiplier-val', `${this.settings.adsMultiplier.toFixed(2)}×`);
    this.updateSliderLabel('mm-fov-val', `${this.settings.fieldOfView}°`);
    this.root.classList.toggle('mm-reduced-motion', this.settings.reducedMotion);
  }

  private emitSettings(): void {
    try {
      window.localStorage.setItem('nightglass.settings.v1', JSON.stringify(this.settings));
    } catch { /* Settings still apply when persistence is blocked. */ }
    this.callbacks.onSettingsChange?.(this.getSettings());
  }

  private updateSliderLabel(id: string, text: string): void {
    const el = this.root.querySelector(`#${id}`);
    if (el) el.textContent = text;
  }

  private setGraphicsOpen(open: boolean, restoreFocus = false): void {
    this.graphicsOpen = open;
    this.graphicsButton.setAttribute('aria-expanded', String(open));
    this.graphicsListbox.hidden = !open;
    this.root.querySelector('.mm-select-shell')?.classList.toggle('mm-listbox-open', open);
    if (open) {
      this.graphicsListbox.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    } else if (restoreFocus) {
      this.graphicsButton.focus();
    }
  }

  private onGraphicsKeyDown(event: KeyboardEvent): void {
    const options = [...this.graphicsListbox.querySelectorAll<HTMLElement>('[role="option"]')];
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.setGraphicsOpen(false, true);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!this.graphicsOpen) this.setGraphicsOpen(true);
      else if (document.activeElement instanceof HTMLElement) {
        this.selectGraphics(document.activeElement.dataset.value ?? this.settings.graphicsTier);
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!this.graphicsOpen) this.setGraphicsOpen(true);
    const current = Math.max(0, options.indexOf(document.activeElement as HTMLElement));
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }

  private selectGraphics(value: string): void {
    this.settings.graphicsTier = normalizeQualityPreference(value);
    this.syncGraphicsListbox();
    this.setGraphicsOpen(false, true);
    this.emitSettings();
  }

  private syncGraphicsListbox(): void {
    const labels: Record<QualityPreference, string> = {
      auto: 'AUTO (ADAPTIVE)',
      low: 'LOW',
      medium: 'MEDIUM',
      high: 'HIGH',
      ultra: 'ULTRA',
    };
    const value = this.graphicsButton.querySelector<HTMLElement>('[data-graphics-value]');
    if (value) value.textContent = labels[this.settings.graphicsTier];
    this.graphicsListbox.querySelectorAll<HTMLElement>('[role="option"]').forEach((option) => {
      const selected = option.dataset.value === this.settings.graphicsTier;
      option.setAttribute('aria-selected', String(selected));
      option.tabIndex = selected ? 0 : -1;
    });
  }

  private buildMarkup(): string {
    return `
      <div class="mm-backdrop" aria-hidden="true"></div>
      <div class="mm-scanlines" aria-hidden="true"></div>
      <div class="mm-vignette" aria-hidden="true"></div>

      <div class="mm-content">
        <header class="mm-header">
          <p class="mm-eyebrow">TACTICAL OPS DIVISION</p>
          <h1 class="mm-title">FRONTLINE<span>:</span> NIGHTGLASS</h1>
          <p class="mm-subtitle">OPERATION NIGHTGLASS</p>
        </header>

        <div class="mm-panels">
          <nav class="mm-panel mm-panel-active" data-panel="main" aria-label="Main menu">
            <button type="button" class="mm-btn mm-btn-primary" data-action="play">
              <span class="mm-btn-tag">01</span> <span data-play-label>PLAY</span>
            </button>
            <p class="mm-launch-notice" data-launch-notice role="status" hidden></p>
            <button type="button" class="mm-btn" data-action="settings">
              <span class="mm-btn-tag">02</span> SETTINGS
            </button>
            <button type="button" class="mm-btn" data-action="controls">
              <span class="mm-btn-tag">03</span> CONTROLS
            </button>
            <button type="button" class="mm-btn" data-action="restart" data-session-action hidden>
              <span class="mm-btn-tag">04</span> RESTART MISSION
            </button>
            <button type="button" class="mm-btn mm-btn-ghost" data-action="return-menu" data-session-action hidden>
              RETURN TO MAIN MENU
            </button>
          </nav>

          <div class="mm-panel" data-panel="settings" aria-label="Settings">
            <div class="mm-panel-heading">
              <div>
                <p class="mm-panel-index">02 / SYSTEM</p>
                <h2 class="mm-panel-title">SETTINGS</h2>
              </div>
              <span>FIELD CONFIGURATION</span>
            </div>

            <p class="mm-settings-group">AIM</p>

            <label class="mm-slider">
              <span class="mm-slider-label">GRAPHICS TIER <b>CAPABILITY CAPPED</b></span>
              <span class="mm-select-shell">
                <button type="button" class="mm-listbox-button" data-graphics-button
                  role="combobox" aria-label="Graphics tier" aria-haspopup="listbox"
                  aria-controls="mm-graphics-listbox" aria-expanded="false">
                  <span data-graphics-value>AUTO (ADAPTIVE)</span><i aria-hidden="true"></i>
                </button>
                <span id="mm-graphics-listbox" class="mm-listbox" data-graphics-listbox
                  role="listbox" aria-label="Graphics tier" hidden>
                  <button type="button" role="option" data-value="auto" aria-selected="true">AUTO (ADAPTIVE)</button>
                  <button type="button" role="option" data-value="low" aria-selected="false">LOW</button>
                  <button type="button" role="option" data-value="medium" aria-selected="false">MEDIUM</button>
                  <button type="button" role="option" data-value="high" aria-selected="false">HIGH</button>
                  <button type="button" role="option" data-value="ultra" aria-selected="false">ULTRA</button>
                </span>
              </span>
            </label>

            <label class="mm-slider">
              <span class="mm-slider-label">MOUSE SENSITIVITY <b id="mm-sensitivity-val">1.00</b></span>
              <input id="mm-sensitivity" type="range" min="0.2" max="3" step="0.05" value="1" />
            </label>

            <label class="mm-slider">
              <span class="mm-slider-label">ADS MULTIPLIER <b id="mm-ads-multiplier-val">0.80×</b></span>
              <input id="mm-ads-multiplier" type="range" min="0.2" max="1.5" step="0.05" value="0.8" />
            </label>

            <label class="mm-slider">
              <span class="mm-slider-label">FIELD OF VIEW <b id="mm-fov-val">90°</b></span>
              <input id="mm-fov" type="range" min="70" max="120" step="1" value="90" />
            </label>

            <div class="mm-toggle-grid">
              <label class="mm-toggle">
                <span><b>TOGGLE ADS</b><small>Aim remains active after release</small></span>
                <input id="mm-toggle-ads" type="checkbox" />
                <i aria-hidden="true"></i>
              </label>
              <label class="mm-toggle">
                <span><b>CROSSHAIR</b><small>Show the center weapon reticle</small></span>
                <input id="mm-crosshair" type="checkbox" checked />
                <i aria-hidden="true"></i>
              </label>
              <label class="mm-toggle">
                <span><b>REDUCED MOTION</b><small>Limit interface and camera motion</small></span>
                <input id="mm-reduced-motion" type="checkbox" />
                <i aria-hidden="true"></i>
              </label>
            </div>

            <p class="mm-settings-group mm-settings-audio">AUDIO</p>

            <label class="mm-slider">
              <span class="mm-slider-label">MASTER VOLUME <b id="mm-master-vol-val">85%</b></span>
              <input id="mm-master-vol" type="range" min="0" max="1" step="0.01" value="0.85" />
            </label>

            <label class="mm-slider">
              <span class="mm-slider-label">SFX VOLUME <b id="mm-sfx-vol-val">100%</b></span>
              <input id="mm-sfx-vol" type="range" min="0" max="1" step="0.01" value="1" />
            </label>

            <button type="button" class="mm-btn mm-btn-ghost" data-action="back">← BACK</button>
          </div>

          <div class="mm-panel" data-panel="controls" aria-label="Controls">
            <div class="mm-panel-heading">
              <div>
                <p class="mm-panel-index">03 / INPUT</p>
                <h2 class="mm-panel-title">CONTROLS</h2>
              </div>
              <span>KEYBOARD + MOUSE</span>
            </div>
            <ul class="mm-controls-list">
              <li><kbd>W A S D</kbd> <span>Move</span></li>
              <li><kbd>MOUSE</kbd> <span>Look</span></li>
              <li><kbd>LMB</kbd> <span>Fire</span></li>
              <li><kbd>RMB</kbd> <span>Aim down sights</span></li>
              <li><kbd>R</kbd> <span>Reload</span></li>
              <li><kbd>SHIFT</kbd> <span>Sprint</span></li>
              <li><kbd>CTRL / C</kbd> <span>Crouch / Slide</span></li>
              <li><kbd>SPACE</kbd> <span>Jump / Mantle</span></li>
              <li><kbd>1 – 3</kbd> <span>AR / Pistol / Knife</span></li>
              <li><kbd>WHEEL</kbd> <span>Cycle weapons</span></li>
              <li><kbd>G</kbd> <span>Frag grenade</span></li>
              <li><kbd>E / F</kbd> <span>Interact</span></li>
              <li><kbd>ESC</kbd> <span>Menu / Unlock</span></li>
            </ul>
            <button type="button" class="mm-btn mm-btn-ghost" data-action="back">← BACK</button>
          </div>
        </div>

        <footer class="mm-footer">
          <span>BUILD 1.0.0</span>
          <span class="mm-footer-sep">//</span>
          <span data-deploy-hint>PRESS ENTER TO DEPLOY</span>
        </footer>
      </div>
    `;
  }
}

function normalizeSettings(settings: MainMenuSettings): Required<MainMenuSettings> {
  return {
    sensitivity: clamp(settings.sensitivity, 0.2, 3, DEFAULT_MAIN_MENU_SETTINGS.sensitivity),
    masterVolume: clamp(settings.masterVolume, 0, 1, DEFAULT_MAIN_MENU_SETTINGS.masterVolume),
    sfxVolume: clamp(settings.sfxVolume, 0, 1, DEFAULT_MAIN_MENU_SETTINGS.sfxVolume),
    adsMultiplier: clamp(
      settings.adsMultiplier,
      0.2,
      1.5,
      DEFAULT_MAIN_MENU_SETTINGS.adsMultiplier,
    ),
    fieldOfView: clamp(settings.fieldOfView, 70, 120, DEFAULT_MAIN_MENU_SETTINGS.fieldOfView),
    reducedMotion: typeof settings.reducedMotion === 'boolean' ? settings.reducedMotion : DEFAULT_MAIN_MENU_SETTINGS.reducedMotion,
    toggleADS: typeof settings.toggleADS === 'boolean' ? settings.toggleADS : DEFAULT_MAIN_MENU_SETTINGS.toggleADS,
    showCrosshair: typeof settings.showCrosshair === 'boolean' ? settings.showCrosshair : DEFAULT_MAIN_MENU_SETTINGS.showCrosshair,
    graphicsTier: normalizeQualityPreference(settings.graphicsTier),
  };
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value as number)) : fallback;
}
