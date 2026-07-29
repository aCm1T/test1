export interface MainMenuSettings {
  sensitivity: number;
  masterVolume: number;
  sfxVolume: number;
}

export interface MainMenuCallbacks {
  onPlay: (settings: MainMenuSettings) => void;
  onSettingsChange?: (settings: MainMenuSettings) => void;
}

const DEFAULT_SETTINGS: MainMenuSettings = {
  sensitivity: 1.0,
  masterVolume: 0.85,
  sfxVolume: 1.0,
};

/**
 * Full-screen cinematic main menu for BLACKOPS: FRONTLINE.
 * Play requests pointer lock; Settings for sensitivity/volume; Controls list.
 */
export class MainMenu {
  readonly root: HTMLElement;

  private settings: MainMenuSettings;
  private readonly callbacks: MainMenuCallbacks;
  private panelMain!: HTMLElement;
  private panelSettings!: HTMLElement;
  private panelControls!: HTMLElement;
  private disposed = false;

  constructor(callbacks: MainMenuCallbacks, container?: HTMLElement) {
    this.callbacks = callbacks;
    this.settings = { ...DEFAULT_SETTINGS };

    const mount = container ?? document.getElementById('app') ?? document.body;
    this.root = document.createElement('div');
    this.root.id = 'main-menu';
    this.root.className = 'main-menu';
    this.root.innerHTML = this.buildMarkup();
    mount.appendChild(this.root);

    this.cacheElements();
    this.bindEvents();
    this.showPanel('main');
  }

  show(): void {
    this.root.classList.remove('main-menu-hidden');
    this.root.setAttribute('aria-hidden', 'false');
  }

  hide(): void {
    this.root.classList.add('main-menu-hidden');
    this.root.setAttribute('aria-hidden', 'true');
  }

  isVisible(): boolean {
    return !this.root.classList.contains('main-menu-hidden');
  }

  getSettings(): MainMenuSettings {
    return { ...this.settings };
  }

  setSettings(partial: Partial<MainMenuSettings>): void {
    this.settings = { ...this.settings, ...partial };
    this.syncSliders();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.remove();
  }

  private cacheElements(): void {
    this.panelMain = this.root.querySelector('[data-panel="main"]')!;
    this.panelSettings = this.root.querySelector('[data-panel="settings"]')!;
    this.panelControls = this.root.querySelector('[data-panel="controls"]')!;
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

    this.root.querySelectorAll('[data-action="back"]').forEach((btn) => {
      btn.addEventListener('click', () => this.showPanel('main'));
    });

    const sens = this.root.querySelector<HTMLInputElement>('#mm-sensitivity');
    const master = this.root.querySelector<HTMLInputElement>('#mm-master-vol');
    const sfx = this.root.querySelector<HTMLInputElement>('#mm-sfx-vol');

    sens?.addEventListener('input', () => {
      this.settings.sensitivity = parseFloat(sens.value);
      this.updateSliderLabel('mm-sensitivity-val', this.settings.sensitivity.toFixed(2));
      this.callbacks.onSettingsChange?.(this.getSettings());
    });

    master?.addEventListener('input', () => {
      this.settings.masterVolume = parseFloat(master.value);
      this.updateSliderLabel('mm-master-vol-val', Math.round(this.settings.masterVolume * 100) + '%');
      this.callbacks.onSettingsChange?.(this.getSettings());
    });

    sfx?.addEventListener('input', () => {
      this.settings.sfxVolume = parseFloat(sfx.value);
      this.updateSliderLabel('mm-sfx-vol-val', Math.round(this.settings.sfxVolume * 100) + '%');
      this.callbacks.onSettingsChange?.(this.getSettings());
    });

    // Keyboard: Enter to play from main panel
    window.addEventListener('keydown', this.onKeyDown);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed || !this.isVisible()) return;
    if (e.code === 'Enter' && this.panelMain.classList.contains('mm-panel-active')) {
      e.preventDefault();
      this.startPlay();
    }
    if (e.code === 'Escape' && !this.panelMain.classList.contains('mm-panel-active')) {
      this.showPanel('main');
    }
  };

  private startPlay(): void {
    const target = document.getElementById('app') ?? document.body;
    const requestLock = (): void => {
      const el = target.querySelector('canvas') ?? target;
      if (el.requestPointerLock) {
        el.requestPointerLock();
      }
    };

    requestLock();
    this.hide();
    this.callbacks.onPlay(this.getSettings());
  }

  private showPanel(name: 'main' | 'settings' | 'controls'): void {
    this.panelMain.classList.toggle('mm-panel-active', name === 'main');
    this.panelSettings.classList.toggle('mm-panel-active', name === 'settings');
    this.panelControls.classList.toggle('mm-panel-active', name === 'controls');
  }

  private syncSliders(): void {
    const sens = this.root.querySelector<HTMLInputElement>('#mm-sensitivity');
    const master = this.root.querySelector<HTMLInputElement>('#mm-master-vol');
    const sfx = this.root.querySelector<HTMLInputElement>('#mm-sfx-vol');
    if (sens) sens.value = String(this.settings.sensitivity);
    if (master) master.value = String(this.settings.masterVolume);
    if (sfx) sfx.value = String(this.settings.sfxVolume);
    this.updateSliderLabel('mm-sensitivity-val', this.settings.sensitivity.toFixed(2));
    this.updateSliderLabel('mm-master-vol-val', Math.round(this.settings.masterVolume * 100) + '%');
    this.updateSliderLabel('mm-sfx-vol-val', Math.round(this.settings.sfxVolume * 100) + '%');
  }

  private updateSliderLabel(id: string, text: string): void {
    const el = this.root.querySelector(`#${id}`);
    if (el) el.textContent = text;
  }

  private buildMarkup(): string {
    return `
      <div class="mm-backdrop" aria-hidden="true"></div>
      <div class="mm-scanlines" aria-hidden="true"></div>
      <div class="mm-vignette" aria-hidden="true"></div>

      <div class="mm-content">
        <header class="mm-header">
          <p class="mm-eyebrow">TACTICAL OPS DIVISION</p>
          <h1 class="mm-title">BLACKOPS<span>:</span> FRONTLINE</h1>
          <p class="mm-subtitle">URBAN ASSAULT</p>
        </header>

        <div class="mm-panels">
          <nav class="mm-panel mm-panel-active" data-panel="main" aria-label="Main menu">
            <button type="button" class="mm-btn mm-btn-primary" data-action="play">
              <span class="mm-btn-tag">01</span> PLAY
            </button>
            <button type="button" class="mm-btn" data-action="settings">
              <span class="mm-btn-tag">02</span> SETTINGS
            </button>
            <button type="button" class="mm-btn" data-action="controls">
              <span class="mm-btn-tag">03</span> CONTROLS
            </button>
          </nav>

          <div class="mm-panel" data-panel="settings" aria-label="Settings">
            <h2 class="mm-panel-title">SETTINGS</h2>

            <label class="mm-slider">
              <span class="mm-slider-label">MOUSE SENSITIVITY <b id="mm-sensitivity-val">1.00</b></span>
              <input id="mm-sensitivity" type="range" min="0.2" max="3" step="0.05" value="1" />
            </label>

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
            <h2 class="mm-panel-title">CONTROLS</h2>
            <ul class="mm-controls-list">
              <li><kbd>W A S D</kbd> <span>Move</span></li>
              <li><kbd>MOUSE</kbd> <span>Look</span></li>
              <li><kbd>LMB</kbd> <span>Fire</span></li>
              <li><kbd>R</kbd> <span>Reload</span></li>
              <li><kbd>SHIFT</kbd> <span>Sprint</span></li>
              <li><kbd>CTRL / C</kbd> <span>Crouch</span></li>
              <li><kbd>SPACE</kbd> <span>Jump</span></li>
              <li><kbd>1 – 4</kbd> <span>Weapons</span></li>
              <li><kbd>F</kbd> <span>Interact</span></li>
              <li><kbd>ESC</kbd> <span>Menu / Unlock</span></li>
            </ul>
            <button type="button" class="mm-btn mm-btn-ghost" data-action="back">← BACK</button>
          </div>
        </div>

        <footer class="mm-footer">
          <span>BUILD 1.0.0</span>
          <span class="mm-footer-sep">//</span>
          <span>PRESS ENTER TO DEPLOY</span>
        </footer>
      </div>
    `;
  }
}
