/**
 * Procedural Web Audio API sound manager for BLACKOPS: FRONTLINE.
 * No external audio files — all synthesized at runtime.
 */

import { SeededRandom, type RandomSource } from '../mission';

export type AudioBus = 'master' | 'sfx' | 'ambient' | 'ui';

export interface AudioManagerOptions {
  masterVolume?: number;
  sfxVolume?: number;
  ambientVolume?: number;
  uiVolume?: number;
  /** Independent deterministic presentation stream. */
  random?: RandomSource;
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
  private suppliedAmbientSource: AudioBufferSourceNode | null = null;
  private acousticSpace: 'indoor' | 'outdoor' = 'outdoor';
  private disposeGesture: (() => void) | null = null;
  private readonly suppliedBuffers = new Map<string, AudioBuffer>();
  /** Reused by every procedural one-shot; AudioBufferSourceNodes remain disposable. */
  private readonly proceduralNoiseBuffers = new Map<string, AudioBuffer>();

  private masterVol: number;
  private sfxVol: number;
  private ambientVol: number;
  private uiVol: number;
  private readonly random: RandomSource;

  constructor(options: AudioManagerOptions = {}) {
    this.masterVol = options.masterVolume ?? 0.85;
    this.sfxVol = options.sfxVolume ?? 1;
    this.ambientVol = options.ambientVolume ?? 0.35;
    this.uiVol = options.uiVolume ?? 0.7;
    const fallbackRandom = new SeededRandom(0x41554449);
    this.random = options.random ?? (() => fallbackRandom.next());
    this.bindUnlockGesture();
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  getSuppliedBufferCount(): number {
    return new Set(this.suppliedBuffers.values()).size;
  }

  installBuffer(id: string, buffer: AudioBuffer, aliases: readonly string[] = []): void {
    this.suppliedBuffers.set(id.toLowerCase(), buffer);
    for (const alias of aliases) this.suppliedBuffers.set(alias.toLowerCase(), buffer);
    if (
      this.unlocked
      && [id, ...aliases].some((value) => value.toLowerCase() === 'ambience')
    ) {
      this.stopAmbientWind();
      this.startAmbientWind();
    }
  }

  clearSuppliedBuffers(): void {
    this.stopAmbientWind();
    this.suppliedBuffers.clear();
    if (this.unlocked) this.startAmbientWind();
  }

  setAcousticSpace(space: 'indoor' | 'outdoor'): void {
    if (this.acousticSpace === space) return;
    this.acousticSpace = space;
    this.applyAcousticMix();
  }

  getAcousticSpace(): 'indoor' | 'outdoor' {
    return this.acousticSpace;
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
        if (this.ambientGain) {
          // Indoor duck is a mix state, not a volume preference — keep the
          // preference and re-apply the current acoustic attenuation.
          this.ambientGain.gain.value = v * this.ambientSpaceMul();
        }
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
    const indoor = this.acousticSpace === 'indoor';
    // Seeded pitch wobble keeps bursts from stacking into a machine tone while
    // staying deterministic for a given presentation stream.
    const pitch = 0.94 + this.random() * 0.12;
    const suppliedLayers = this.playSuppliedLayers(
      ['weapon-ar-fire', 'weapon-ar-mechanical', 'weapon-layers'],
      this.sfxGain!,
      i,
    );
    if (suppliedLayers > 0) {
      this.playSupplied(
        [indoor ? 'indoor-tail' : 'outdoor-tail'],
        this.sfxGain!,
        i * 0.62,
      );
      return;
    }

    // Noise body — snappy attack so fire reads on the same frame as the muzzle.
    const noiseDur = indoor ? 0.09 : 0.12;
    const noise = this.createNoiseBuffer(noiseDur, 'white');
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = pitch;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // Indoors emphasize the mid slap; outdoors keep more open air around the crack.
    bp.frequency.value = (indoor ? 980 : 1200) + this.random() * (indoor ? 280 : 400);
    bp.Q.value = indoor ? 1.1 : 0.7;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = indoor ? 240 : 180;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.95 * i, t + 0.002);
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
    osc.frequency.setValueAtTime(140 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(45 * pitch, t + 0.08);

    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, t);
    thumpGain.gain.exponentialRampToValueAtTime((indoor ? 0.82 : 0.7) * i, t + 0.002);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);

    osc.connect(thumpGain);
    thumpGain.connect(dest);
    osc.start(t);
    osc.stop(t + 0.12);

    // Metallic click layer
    const click = ctx.createOscillator();
    click.type = 'square';
    click.frequency.value = (2200 + this.random() * 600) * pitch;
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(0.12 * i, t);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    const clickFilter = ctx.createBiquadFilter();
    clickFilter.type = 'bandpass';
    clickFilter.frequency.value = 2800 * pitch;
    clickFilter.Q.value = 4;
    click.connect(clickFilter);
    clickFilter.connect(clickGain);
    clickGain.connect(dest);
    click.start(t);
    click.stop(t + 0.03);

    this.playGunshotTail(i);
  }

  /**
   * Reflected tail after the crack. This is the layer that makes a shot feel
   * like it happened somewhere: a tight slap indoors, a long open decay outside.
   */
  private playGunshotTail(intensity: number): void {
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;
    const indoor = this.acousticSpace === 'indoor';
    const duration = indoor ? 0.34 : 0.85;

    const tail = this.createNoiseBuffer(duration, 'brown');
    const src = ctx.createBufferSource();
    src.buffer = tail;

    const band = ctx.createBiquadFilter();
    band.type = indoor ? 'bandpass' : 'lowpass';
    band.frequency.setValueAtTime(indoor ? 900 : 1600, t);
    band.frequency.exponentialRampToValueAtTime(indoor ? 420 : 240, t + duration);
    band.Q.value = indoor ? 1.4 : 0.7;

    const gain = ctx.createGain();
    // Indoors the reflection arrives almost immediately and dies hard; outdoors
    // it swells slightly then decays over most of a second.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(
      (indoor ? 0.3 : 0.2) * intensity,
      t + (indoor ? 0.012 : 0.05),
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(band);
    band.connect(gain);
    gain.connect(dest);
    src.start(t);
    src.stop(t + duration + 0.05);
  }

  /** Dead trigger on an empty weapon — a dry mechanical clack, no report. */
  playDryFire(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;
    if (this.playSupplied(['weapon-dryfire', 'weapon-empty'], dest, 0.8)) return;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1500, t);
    osc.frequency.exponentialRampToValueAtTime(360, t + 0.035);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1100;
    f.Q.value = 3.5;
    osc.connect(f);
    f.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /** Brass hitting the ground a beat after the shot. */
  playShellDrop(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    // The delay is what makes the cue read as brass landing rather than part of
    // the report itself.
    const t = ctx.currentTime + 0.18 + this.random() * 0.12;
    if (this.playSupplied(['weapon-shell', 'shell-casing'], dest, 0.5)) return;

    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const when = t + i * (0.045 + this.random() * 0.03);
      osc.frequency.setValueAtTime(2400 + this.random() * 1400, when);
      osc.frequency.exponentialRampToValueAtTime(1200, when + 0.05);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.055 / (i + 1), when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 1800;
      osc.connect(f);
      f.connect(g);
      g.connect(dest);
      osc.start(when);
      osc.stop(when + 0.08);
    }
  }

  /** Fabric-and-grit scrape as the player commits to a slide. */
  playSlide(power = 1): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;
    const p = Math.min(1.4, Math.max(0.2, power));
    if (this.playSupplied(['movement-slide', 'slide'], dest, p)) return;

    const duration = 0.55;
    const src = ctx.createBufferSource();
    src.buffer = this.createNoiseBuffer(duration, 'white');

    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.setValueAtTime(2100, t);
    band.frequency.exponentialRampToValueAtTime(620, t + duration);
    band.Q.value = 0.9;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3 * p, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    src.connect(band);
    band.connect(g);
    g.connect(dest);
    src.start(t);
    src.stop(t + duration + 0.05);
  }

  /** Grunt-and-scuff for pulling over a ledge. */
  playMantle(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;
    if (this.playSupplied(['movement-mantle', 'mantle'], dest, 0.9)) return;

    this.playFootstep('concrete', 1.2);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(96, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 420;
    osc.connect(f);
    f.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + 0.28);
  }

  /** Frag body clacking off hard cover. */
  playGrenadeBounce(power = 1): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;
    const p = Math.min(1.3, Math.max(0.15, power));
    const pitch = 0.92 + this.random() * 0.16;
    if (this.playSupplied(['grenade-bounce', 'impacts'], dest, p * 0.6)) return;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime((720 + this.random() * 340) * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(240 * pitch, t + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.13 * p, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 640 * pitch;
    f.Q.value = 2.2;
    osc.connect(f);
    f.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  /**
   * Distance-attenuated blast. Far detonations lose their crack and keep only
   * the low roll, which is the cheapest convincing distance cue available.
   */
  playExplosion(distance = 0, radius = 6.5): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;
    const proximity = Math.max(0.12, 1 - Math.min(1, distance / Math.max(1, radius * 2.2)));
    if (this.playSupplied(['explosion', 'grenade-explode'], dest, proximity * 1.2)) return;

    // Quantise the fallback tail so repeated rematches reuse at most eleven
    // cached buffers instead of retaining one unique AudioBuffer per distance.
    const duration = Math.round((0.9 + proximity * 0.5) * 20) / 20;
    const src = ctx.createBufferSource();
    src.buffer = this.createNoiseBuffer(duration, 'brown');
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.setValueAtTime(1400 * proximity + 180, t);
    low.frequency.exponentialRampToValueAtTime(90, t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.85 * proximity, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(low);
    low.connect(g);
    g.connect(dest);
    src.start(t);
    src.stop(t + duration + 0.05);

    // Sub-bass thump only survives at close range.
    if (proximity > 0.3) {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(88, t);
      sub.frequency.exponentialRampToValueAtTime(28, t + 0.4);
      const subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.0001, t);
      subGain.gain.exponentialRampToValueAtTime(0.7 * proximity, t + 0.015);
      subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      sub.connect(subGain);
      subGain.connect(dest);
      sub.start(t);
      sub.stop(t + 0.5);
    }
  }

  /**
   * Magazine release + bolt click.
   *
   * @param empty Adds the bolt-release slam that only happens on a dry reload.
   */
  playReload(empty = false): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;
    if (this.playSupplied(
      empty ? ['weapon-reload-empty', 'weapon-reload', 'reload'] : ['weapon-reload', 'reload'],
      this.sfxGain!,
      1,
    )) return;

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
    // The bolt slamming home is the audible difference between reloading early
    // and being caught empty.
    if (empty) click(190, t + 0.66, 0.11, 0.46);
  }

  /** Soft scuff footstep — varies pitch per step. */
  playFootstep(surface: 'concrete' | 'dirt' | 'metal' = 'concrete', power = 1): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.sfxGain!;
    const t = ctx.currentTime;
    const p = Math.min(1.5, Math.max(0.3, power));
    const indoor = this.acousticSpace === 'indoor';
    if (this.playSupplied(
      [`footsteps-${surface}`, `footstep-${surface}`, 'footsteps-surface'],
      this.sfxGain!,
      p,
    )) return;

    const freqs: Record<string, number> = {
      concrete: 180,
      dirt: 110,
      metal: 320,
    };
    const base = freqs[surface] ?? 180;
    // Confined spaces truncate the scrape and push more body; outdoors open the top.
    const spaceMul = indoor ? 0.7 : 1.08;
    const pitch = 0.9 + this.random() * 0.2;

    const noise = this.createNoiseBuffer(indoor ? 0.06 : 0.08, surface === 'dirt' ? 'brown' : 'white');
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = pitch;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = (base + this.random() * 80) * spaceMul;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime((indoor ? 0.34 : 0.28) * p, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (indoor ? 0.07 : 0.09));

    src.connect(filter);
    filter.connect(g);
    g.connect(dest);
    src.start(t);
    src.stop(t + 0.1);

    if (surface === 'metal') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = (900 + this.random() * 200) * pitch;
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.06 * p, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      osc.connect(og);
      og.connect(dest);
      osc.start(t);
      osc.stop(t + 0.06);
    }
  }

  playImpact(surface = 'default'): void {
    if (!this.ready()) return;
    const resolved: 'concrete' | 'dirt' | 'metal' = surface === 'metal'
      ? 'metal'
      : surface === 'dirt' || surface === 'wood'
        ? 'dirt'
        : 'concrete';
    if (this.playSupplied(
      [`impact-${resolved}`, 'impacts'],
      this.sfxGain!,
      0.75,
    )) return;
    this.playFootstep(resolved, 0.4);
  }

  /** Sharp UI confirmation beep for confirmed hits. */
  playHitMarker(headshot = false): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const dest = this.uiGain!;
    const t = ctx.currentTime;
    if (this.playSupplied([headshot ? 'ui-headshot' : 'ui-hitmarker', 'ui'], this.uiGain!, 1)) return;

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
    if (this.playSupplied(['ui-click', 'ui'], this.uiGain!, 0.8)) return;
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
    if (!this.ready() || this.windNodes || this.suppliedAmbientSource) return;
    const ctx = this.ctx!;
    const dest = this.ambientGain!;

    const supplied = this.findSupplied(['ambience-dusk', 'ambience']);
    if (supplied) {
      const source = ctx.createBufferSource();
      source.buffer = supplied;
      source.loop = true;
      source.connect(dest);
      source.start();
      this.suppliedAmbientSource = source;
      this.applyAcousticMix();
      return;
    }

    const buffer = this.createNoiseBuffer(2.5, 'brown');
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 220;
    filter.Q.value = 0.6;

    const gain = ctx.createGain();
    gain.gain.value = this.acousticSpace === 'indoor' ? 0.05 : 0.22;

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
    this.applyAcousticMix();
  }

  stopAmbientWind(): void {
    if (this.suppliedAmbientSource) {
      try {
        this.suppliedAmbientSource.stop();
      } catch {
        /* already stopped */
      }
      this.suppliedAmbientSource.disconnect();
      this.suppliedAmbientSource = null;
    }
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
    this.suppliedBuffers.clear();
    this.proceduralNoiseBuffers.clear();
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
    this.ambientGain.gain.value = this.ambientVol * this.ambientSpaceMul();
    this.ambientGain.connect(this.masterGain);

    this.uiGain = this.ctx.createGain();
    this.uiGain.gain.value = this.uiVol;
    this.uiGain.connect(this.masterGain);

    // Generate the common fallback palette during the launch gesture. Building
    // a fresh 0.85 s brown-noise tail for every AR round was a multi-megabyte-
    // per-second allocation stream during automatic fire.
    for (const [duration, type] of PROCEDURAL_NOISE_PREWARM) {
      this.createNoiseBuffer(duration, type);
    }

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
    const cacheKey = `${type}:${length}`;
    const cached = this.proceduralNoiseBuffers.get(cacheKey);
    if (cached) return cached;
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    // A local deterministic stream keeps buffer prewarming from consuming the
    // gameplay presentation RNG. Pitch, filters and envelopes still vary each
    // playback, while the expensive sample array is shared safely.
    let noiseState = noiseSeed(type, length);

    if (type === 'white') {
      for (let i = 0; i < length; i++) {
        noiseState = nextNoiseState(noiseState);
        data[i] = noiseState / 0x1_0000_0000 * 2 - 1;
      }
    } else {
      let last = 0;
      for (let i = 0; i < length; i++) {
        noiseState = nextNoiseState(noiseState);
        const white = noiseState / 0x1_0000_0000 * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
    }
    this.proceduralNoiseBuffers.set(cacheKey, buffer);
    return buffer;
  }

  private playSupplied(ids: readonly string[], destination: AudioNode, gainValue: number): boolean {
    const buffer = this.findSupplied(ids);
    if (!buffer || !this.ctx) return false;
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.buffer = buffer;
    gain.gain.value = Math.max(0, gainValue);
    source.connect(gain);
    gain.connect(destination);
    source.start();
    return true;
  }

  private playSuppliedLayers(
    ids: readonly string[],
    destination: AudioNode,
    gainValue: number,
  ): number {
    let played = 0;
    for (let index = 0; index < ids.length; index += 1) {
      const buffer = this.suppliedBuffers.get(ids[index].toLowerCase());
      if (!buffer) continue;
      let duplicate = false;
      for (let prior = 0; prior < index; prior += 1) {
        if (this.suppliedBuffers.get(ids[prior].toLowerCase()) === buffer) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) continue;
      const source = this.ctx!.createBufferSource();
      const gain = this.ctx!.createGain();
      source.buffer = buffer;
      gain.gain.value = Math.max(0, gainValue);
      source.connect(gain);
      gain.connect(destination);
      source.start();
      played += 1;
    }
    return played;
  }

  private findSupplied(ids: readonly string[]): AudioBuffer | undefined {
    for (const id of ids) {
      const buffer = this.suppliedBuffers.get(id.toLowerCase());
      if (buffer) return buffer;
    }
    return undefined;
  }

  /** Indoor spaces duck the outdoor wind bed so gunfire/footsteps own the mix. */
  private ambientSpaceMul(): number {
    return this.acousticSpace === 'indoor' ? 0.28 : 1;
  }

  private applyAcousticMix(): void {
    if (!this.ctx || !this.ambientGain) return;
    const t = this.ctx.currentTime;
    const indoor = this.acousticSpace === 'indoor';
    this.ambientGain.gain.cancelScheduledValues(t);
    this.ambientGain.gain.setTargetAtTime(this.ambientVol * this.ambientSpaceMul(), t, 0.09);
    if (!this.windNodes) return;
    this.windNodes.filter.frequency.cancelScheduledValues(t);
    this.windNodes.filter.frequency.setTargetAtTime(indoor ? 120 : 220, t, 0.12);
    this.windNodes.gain.gain.cancelScheduledValues(t);
    this.windNodes.gain.gain.setTargetAtTime(indoor ? 0.05 : 0.22, t, 0.1);
  }
}

const PROCEDURAL_NOISE_PREWARM: readonly (readonly [number, NoiseType])[] = [
  [0.09, 'white'],
  [0.12, 'white'],
  [0.34, 'brown'],
  [0.85, 'brown'],
  [0.55, 'white'],
  [0.06, 'white'],
  [0.08, 'white'],
  [0.06, 'brown'],
  [0.08, 'brown'],
  [2.5, 'brown'],
];

function noiseSeed(type: NoiseType, length: number): number {
  return ((type === 'white' ? 0x57484954 : 0x42524f57) ^ length) >>> 0;
}

function nextNoiseState(state: number): number {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}
