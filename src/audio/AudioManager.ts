/**
 * Procedural Web Audio API sound manager for BLACKOPS: FRONTLINE.
 * No external audio files — all synthesized at runtime.
 */

export type AudioBus = 'master' | 'sfx' | 'ambient' | 'ui';

export interface AudioManagerOptions {
  masterVolume?: number;
  sfxVolume?: number;
  ambientVolume?: number;
  uiVolume?: number;
}

type NoiseType = 'white' | 'brown';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private uiGain: GainNode | null = null;

  private unlocked = false;
  private windNodes: { osc: OscillatorNode; filter: BiquadFilterNode; gain: GainNode } | null =
    null;
  private disposeGesture: (() => void) | null = null;

  private masterVol: number;
  private sfxVol: number;
  private ambientVol: number;
  private uiVol: number;

  constructor(options: AudioManagerOptions = {}) {
    this.masterVol = options.masterVolume ?? 0.85;
    this.sfxVol = options.sfxVolume ?? 1;
    this.ambientVol = options.ambientVolume ?? 0.35;
    this.uiVol = options.uiVolume ?? 0.7;
    this.bindUnlockGesture();
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  /** Resume AudioContext after a user gesture (click / key / pointer). */
  async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    this.unlocked = ctx.state === 'running';
    if (this.unlocked && !this.windNodes) {
      this.startAmbientWind();
    }
  }

  setVolume(bus: AudioBus, value: number): void {
    const v = Math.min(1, Math.max(0, value));
    switch (bus) {
      case 'master':
        this.masterVol = v;
        if (this.masterGain) this.masterGain.gain.value = v;
        break;
      case 'sfx':
        this.sfxVol = v;
        if (this.sfxGain) this.sfxGain.gain.value = v;
        break;
      case 'ambient':
        this.ambientVol = v;
        if (this.ambientGain) this.ambientGain.gain.value = v;
        break;
      case 'ui':
        this.uiVol = v;
        if (this.uiGain) this.uiGain.gain.value = v;
        break;
    }
  }

  getVolume(bus: AudioBus): number {
    switch (bus) {
      case 'master':
        return this.masterVol;
      case 'sfx':
        return this.sfxVol;
      case 'ambient':
        return this.ambientVol;
      case 'ui':
        return this.uiVol;
    }
  }

  /** Filtered noise burst + low thump — assault rifle style. */
  playGunshot(intensity = 1): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;
    const i = Math.min(1.5, Math.max(0.3, intensity));

    // Noise body
    const noiseDur = 0.12;
    const noise = this.createNoiseBuffer(noiseDur, 'white');
    const src = ctx.createBufferSource();
    src.buffer = noise;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200 + Math.random() * 400;
    bp.Q.value = 0.7;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.9 * i, t + 0.004);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + noiseDur);

    src.connect(bp);
    bp.connect(hp);
    hp.connect(noiseGain);
    noiseGain.connect(dest);
    src.start(t);
    src.stop(t + noiseDur + 0.02);

    // Low thump
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.08);

    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, t);
    thumpGain.gain.exponentialRampToValueAtTime(0.7 * i, t + 0.003);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);

    osc.connect(thumpGain);
    thumpGain.connect(dest);
    osc.start(t);
    osc.stop(t + 0.12);

    // Metallic click layer
    const click = ctx.createOscillator();
    click.type = 'square';
    click.frequency.value = 2200 + Math.random() * 600;
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(0.12 * i, t);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    const clickFilter = ctx.createBiquadFilter();
    clickFilter.type = 'bandpass';
    clickFilter.frequency.value = 2800;
    clickFilter.Q.value = 4;
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(dest);
    click.start(t);
    click.stop(t + 0.03);
  }

  /** Magazine release + bolt click. */
  playReload(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;

    const click = (freq: number, when: number, dur: number, vol: number) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, when);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.6, when + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(vol, when + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = 2.5;
      osc.connect(f);
      f.connect(g);
      g.connect(dest);
      osc.start(when);
      osc.stop(when + dur + 0.02);
    };

    click(420, t, 0.05, 0.35);
    click(280, t + 0.12, 0.07, 0.28);
    click(780, t + 0.32, 0.04, 0.4);
    click(520, t + 0.48, 0.06, 0.32);
  }

  /** Soft scuff footstep — varies pitch per step. */
  playFootstep(surface: 'concrete' | 'dirt' | 'metal' = 'concrete', power = 1): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;
    const p = Math.min(1.5, Math.max(0.3, power));

    const freqs: Record<string, number> = {
      concrete: 180,
      dirt: 110,
      metal: 320,
    };
    const base = freqs[surface] ?? 180;

    const noise = this.createNoiseBuffer(0.08, surface === 'dirt' ? 'brown' : 'white');
    const src = ctx.createBufferSource();
    src.buffer = noise;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = base + Math.random() * 80;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28 * p, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

    src.connect(filter);
    filter.connect(g);
    g.connect(dest);
    src.start(t);
    src.stop(t + 0.1);

    if (surface === 'metal') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 900 + Math.random() * 200;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.06 * p, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.connect(og);
      og.connect(dest);
      osc.start(t);
      osc.stop(t + 0.06);
    }
  }

  /** Sharp UI confirmation beep for confirmed hits. */
  playHitMarker(headshot = false): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.uiGain!;
    const t = ctx.currentTime;

    const freq = headshot ? 1400 : 980;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.setValueAtTime(freq * 1.25, t + 0.035);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);

    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 6;

    osc.connect(f);
    f.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  playUIClick(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.uiGain!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 660;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    osc.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  /** Continuous low wind drone for urban dusk ambience. */
  startAmbientWind(): void {
    if (!this.ready() || this.windNodes) return;
    const ctx = this.ctx!;
    const dest = this.ambientGain!;

    const buffer = this.createNoiseBuffer(2.5, 'brown');
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 220;
    filter.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.value = 0.22;

    // Slow LFO on filter for living wind
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 80;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    src.start();

    this.windNodes = { osc: lfo, filter, gain };
    // Keep buffer source alive on the nodes object via userData pattern
    (this.windNodes as unknown as { src: AudioBufferSourceNode }).src = src;
  }

  stopAmbientWind(): void {
    if (!this.windNodes) return;
    try {
      this.windNodes.osc.stop();
      const src = (this.windNodes as unknown as { src?: AudioBufferSourceNode }).src;
      src?.stop();
    } catch {
      /* already stopped */
    }
    this.windNodes = null;
  }

  dispose(): void {
    this.stopAmbientWind();
    if (this.disposeGesture) {
      this.disposeGesture();
      this.disposeGesture = null;
    }
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.masterGain = null;
    this.sfxGain = null;
    this.ambientGain = null;
    this.uiGain = null;
    this.unlocked = false;
  }

  private ready(): boolean {
    if (!this.unlocked) {
      void this.unlock();
      return false;
    }
    return !!this.ctx && !!this.sfxGain;
  }

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;

    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.masterVol;
    this.masterGain.connect(this.ctx.destination);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.sfxVol;
    this.sfxGain.connect(this.masterGain);

    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = this.ambientVol;
    this.ambientGain.connect(this.masterGain);

    this.uiGain = this.ctx.createGain();
    this.uiGain.gain.value = this.uiVol;
    this.uiGain.connect(this.masterGain);

    return this.ctx;
  }

  private bindUnlockGesture(): void {
    const handler = () => {
      void this.unlock();
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('pointerdown', handler, opts);
    window.addEventListener('keydown', handler, opts);
    window.addEventListener('touchstart', handler, opts);
    this.disposeGesture = () => {
      window.removeEventListener('pointerdown', handler, opts);
      window.removeEventListener('keydown', handler, opts);
      window.removeEventListener('touchstart', handler, opts);
    };
  }

  private createNoiseBuffer(duration: number, type: NoiseType): AudioBuffer {
    const ctx = this.ctx!;
    const sampleRate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    if (type === 'white') {
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
    } else {
      let last = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
    }
    return buffer;
  }
}
