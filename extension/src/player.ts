export type AudioFallbackReason = 'error' | 'stalled' | 'startup-timeout' | 'playback-rejected' | 'resume-rejected';

export interface AudioFallbackEvent {
  reason: AudioFallbackReason;
  streamUrl: string;
  message: string;
}

const ACTIVE_AUDIO_STARTUP_TIMEOUT_MS = 6_000;
const ACTIVE_AUDIO_STALLED_TIMEOUT_MS = 2_500;

export class DoubleBufferedAudioPlayer {
  private audioA: HTMLAudioElement;
  private audioB: HTMLAudioElement;
  private useAudioA = true;

  private videoElement: HTMLVideoElement | null = null;
  private defaultDubVolume = 0.8;
  private isDucked = false;
  private originalVideoVolume = 1.0;
  private fadeInterval: number | null = null;
  private isAudioReadyForSync = false;
  private startupFallbackTimer: number | null = null;
  private stalledFallbackTimer: number | null = null;
  private activeStreamUrl = '';
  private fallbackNotifiedForStreamUrl = '';
  private readonly suppressedFallbackAudios = new WeakSet<HTMLAudioElement>();
  private onFallbackCallback: (event: AudioFallbackEvent) => void = () => {};
  private onPlayingCallback: (streamUrl: string) => void = () => {};

  constructor() {
    this.audioA = this.createAudioElement();
    this.audioB = this.createAudioElement();
  }

  public setVideoElement(video: HTMLVideoElement): void {
    this.videoElement = video;
  }

  public setDubVolume(volume: number): void {
    this.defaultDubVolume = volume;
    this.audioA.volume = volume;
    this.audioB.volume = volume;
  }

  public setFallbackHandler(handler: (event: AudioFallbackEvent) => void): void {
    this.onFallbackCallback = handler;
  }

  public setPlayingHandler(handler: (streamUrl: string) => void): void {
    this.onPlayingCallback = handler;
  }

  public getActiveAudio(): HTMLAudioElement {
    return this.useAudioA ? this.audioA : this.audioB;
  }

  public getPreloadAudio(): HTMLAudioElement {
    return this.useAudioA ? this.audioB : this.audioA;
  }

  public swapBuffers(): void {
    this.useAudioA = !this.useAudioA;
  }

  public play(streamUrl: string, preloadUrl: string | null, segmentDuration?: number): void {
    const preload = this.getPreloadAudio();
    const isPreloaded = preload.src === streamUrl;

    if (isPreloaded) {
      this.swapBuffers();
      const active = this.getActiveAudio();
      active.volume = this.defaultDubVolume;
      this.prepareActiveAudio(active, segmentDuration);
      this.playActiveAudio(active, streamUrl);
      this.loadPreloadStream(preloadUrl);
      return;
    }

    const active = this.getActiveAudio();
    this.cleanupAudio(active);
    active.src = streamUrl;
    active.volume = this.defaultDubVolume;
    this.prepareActiveAudio(active, segmentDuration);
    active.load();
    this.playActiveAudio(active, streamUrl);
    this.loadPreloadStream(preloadUrl);
  }

  public pause(): void {
    this.getActiveAudio().pause();
    this.restoreVideoVolume();
  }

  public resume(): void {
    const active = this.getActiveAudio();
    if (!active.src || active.ended) return;

    active.play().catch((error) => {
      console.warn('[Player] Resume stream failed:', error);
      this.restoreVideoVolume();
      this.notifyFallback('resume-rejected', (error as Error).message);
    });
  }

  public stopAll(): void {
    this.cleanupAudio(this.audioA);
    this.cleanupAudio(this.audioB);
    this.restoreVideoVolume();
    this.isAudioReadyForSync = false;
    this.clearFallbackTimers();
    this.activeStreamUrl = '';
    this.fallbackNotifiedForStreamUrl = '';
  }

  public restoreVideoVolume(): void {
    if (!this.videoElement || !this.isDucked) return;
    this.isDucked = false;

    if (this.fadeInterval !== null) {
      window.clearInterval(this.fadeInterval);
    }

    const targetVolume = this.originalVideoVolume;
    const startVolume = this.videoElement.volume;
    const steps = 20;
    const stepDuration = 500 / steps;
    let currentStep = 0;

    this.fadeInterval = window.setInterval(() => {
      if (!this.videoElement) return;

      currentStep++;
      const nextVolume = startVolume + ((targetVolume - startVolume) * (currentStep / steps));
      this.videoElement.volume = Math.min(1, nextVolume);

      if (currentStep >= steps) {
        if (this.fadeInterval !== null) {
          window.clearInterval(this.fadeInterval);
          this.fadeInterval = null;
        }
        this.videoElement.volume = targetVolume;
      }
    }, stepDuration);
  }

  public syncPlaybackRate(rate: number): void {
    this.audioA.playbackRate = rate;
    this.audioB.playbackRate = rate;
  }

  public checkDriftAndMicroAdjust(audioPlayVideoTime: number): void {
    const video = this.videoElement;
    const audio = this.getActiveAudio();

    if (!video || audio.paused || audio.ended || !audio.src) return;
    if (!this.isAudioReadyForSync || audio.currentTime === 0) return;

    const speedRatio = audio.playbackRate / video.playbackRate;
    const elapsedVideo = video.currentTime - audioPlayVideoTime;
    const elapsedAudioInVideoSeconds = audio.currentTime / speedRatio;
    const drift = elapsedVideo - elapsedAudioInVideoSeconds;

    console.log(`[Sync-Check] elapsedVideo: ${elapsedVideo.toFixed(2)}s, elapsedAudio: ${elapsedAudioInVideoSeconds.toFixed(2)}s. Drift: ${drift.toFixed(2)}s.`);

    if (Math.abs(drift) > 0.4) {
      console.log(`[Sync] Large drift detected (${drift.toFixed(2)}s). Hard-syncing audio.`);
      try {
        this.isAudioReadyForSync = false;
        audio.currentTime = Math.max(0, elapsedVideo * speedRatio);
      } catch {
        // The stream may not be seekable while buffering.
      }
      return;
    }

    if (drift > 0.15) {
      audio.playbackRate *= 1.05;
      console.log(`[Sync] Audio is behind. Temporarily speeding up to ${audio.playbackRate.toFixed(2)}x.`);
    } else if (drift < -0.15) {
      audio.playbackRate *= 0.95;
      console.log(`[Sync] Audio is ahead. Temporarily slowing down to ${audio.playbackRate.toFixed(2)}x.`);
    }
  }

  private createAudioElement(): HTMLAudioElement {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.volume = this.defaultDubVolume;

    audio.addEventListener('playing', () => {
      if (audio !== this.getActiveAudio()) return;

      this.clearFallbackTimers();
      this.fallbackNotifiedForStreamUrl = '';
      this.isAudioReadyForSync = true;
      this.duckVideoVolume();
      this.onPlayingCallback(this.activeStreamUrl || audio.currentSrc || audio.src);
      console.log('[Player] Stream is playing.');
    });

    audio.addEventListener('waiting', () => {
      if (audio !== this.getActiveAudio()) return;

      this.isAudioReadyForSync = false;
      console.log('[Player] Stream is buffering...');
    });

    audio.addEventListener('stalled', () => {
      if (audio !== this.getActiveAudio()) return;
      if (this.suppressedFallbackAudios.has(audio)) return;

      this.isAudioReadyForSync = false;
      console.warn('[Player] Stream stalled. Waiting briefly before soft fallback.');
      this.scheduleStalledFallback(audio);
    });

    audio.addEventListener('error', () => {
      if (audio !== this.getActiveAudio()) return;
      if (this.suppressedFallbackAudios.has(audio)) return;

      this.isAudioReadyForSync = false;
      console.warn('[Player] Stream error. Restoring original video audio.');
      this.restoreVideoVolume();
      this.notifyFallback('error', audio.error?.message || 'Audio stream error.');
    });

    audio.addEventListener('ended', () => {
      if (audio !== this.getActiveAudio()) return;

      this.clearFallbackTimers();
      this.isAudioReadyForSync = false;
      this.restoreVideoVolume();
    });

    return audio;
  }

  private prepareActiveAudio(audio: HTMLAudioElement, segmentDuration?: number): void {
    this.isAudioReadyForSync = false;
    this.applyDynamicRate(audio, segmentDuration);
  }

  private playActiveAudio(audio: HTMLAudioElement, streamUrl: string): void {
    this.activeStreamUrl = streamUrl;
    this.fallbackNotifiedForStreamUrl = '';
    this.armStartupFallback(audio);

    audio.play().catch((error) => {
      console.warn('[Player] Stream playback failed:', error);
      this.clearFallbackTimers();
      this.isAudioReadyForSync = false;
      this.restoreVideoVolume();
      this.notifyFallback('playback-rejected', (error as Error).message);
    });
  }

  private loadPreloadStream(preloadUrl: string | null): void {
    const preload = this.getPreloadAudio();
    this.cleanupAudio(preload);

    if (!preloadUrl) return;

    preload.src = preloadUrl;
    preload.volume = this.defaultDubVolume;
    if (this.videoElement) {
      preload.playbackRate = this.videoElement.playbackRate;
    }
    preload.load();
  }

  private applyDynamicRate(audio: HTMLAudioElement, segmentDuration?: number): void {
    if (!this.videoElement) return;

    const videoRate = this.videoElement.playbackRate;
    audio.playbackRate = videoRate;

    const computeRate = (): void => {
      if (!segmentDuration || !audio.duration || audio.duration <= segmentDuration) return;

      const requiredRate = (audio.duration / segmentDuration) * videoRate;
      const maxRate = videoRate * 1.35;
      const targetRate = Math.min(requiredRate, maxRate);

      if (Math.abs(audio.playbackRate - targetRate) > 0.01) {
        audio.playbackRate = targetRate;
        console.log(`[Player] Dynamic speedup: ${audio.duration.toFixed(2)}s audio > ${segmentDuration.toFixed(2)}s segment. Rate=${audio.playbackRate.toFixed(2)}x.`);
      }
    };

    if (audio.duration) {
      computeRate();
    } else {
      audio.addEventListener('loadedmetadata', computeRate, { once: true });
    }
  }

  private cleanupAudio(audio: HTMLAudioElement): void {
    try {
      if (audio === this.getActiveAudio()) {
        this.clearFallbackTimers();
      }

      this.suppressedFallbackAudios.add(audio);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      window.setTimeout(() => {
        this.suppressedFallbackAudios.delete(audio);
      }, 0);
    } catch {
      // Ignore cleanup failures from detached or partially loaded streams.
    }
  }

  private armStartupFallback(audio: HTMLAudioElement): void {
    this.clearFallbackTimers();

    this.startupFallbackTimer = window.setTimeout(() => {
      if (audio !== this.getActiveAudio()) return;
      if (audio.paused || audio.ended) return;
      if (this.isAudioReadyForSync || audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;

      console.warn('[Player] Stream startup timeout. Falling back to original audio.');
      this.isAudioReadyForSync = false;
      this.restoreVideoVolume();
      this.notifyFallback('startup-timeout', 'Audio stream did not start in time.');
    }, ACTIVE_AUDIO_STARTUP_TIMEOUT_MS);
  }

  private scheduleStalledFallback(audio: HTMLAudioElement): void {
    if (this.stalledFallbackTimer !== null) {
      window.clearTimeout(this.stalledFallbackTimer);
    }

    this.stalledFallbackTimer = window.setTimeout(() => {
      this.stalledFallbackTimer = null;

      if (audio !== this.getActiveAudio()) return;
      if (audio.ended || audio.paused) return;
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return;

      this.restoreVideoVolume();
      this.notifyFallback('stalled', 'Audio stream stalled.');
    }, ACTIVE_AUDIO_STALLED_TIMEOUT_MS);
  }

  private clearFallbackTimers(): void {
    if (this.startupFallbackTimer !== null) {
      window.clearTimeout(this.startupFallbackTimer);
      this.startupFallbackTimer = null;
    }

    if (this.stalledFallbackTimer !== null) {
      window.clearTimeout(this.stalledFallbackTimer);
      this.stalledFallbackTimer = null;
    }
  }

  private notifyFallback(reason: AudioFallbackReason, message: string): void {
    const streamUrl = this.activeStreamUrl || this.getActiveAudio().currentSrc || this.getActiveAudio().src;
    if (streamUrl && this.fallbackNotifiedForStreamUrl === streamUrl) return;

    this.fallbackNotifiedForStreamUrl = streamUrl;
    this.onFallbackCallback({
      reason,
      streamUrl,
      message
    });
  }

  private duckVideoVolume(): void {
    if (!this.videoElement || this.isDucked) return;
    this.isDucked = true;

    if (this.fadeInterval !== null) {
      window.clearInterval(this.fadeInterval);
    }

    this.originalVideoVolume = this.videoElement.volume;
    const targetVolume = this.originalVideoVolume * 0.3;
    const startVolume = this.videoElement.volume;
    const steps = 15;
    const stepDuration = 300 / steps;
    let currentStep = 0;

    this.fadeInterval = window.setInterval(() => {
      if (!this.videoElement) return;

      currentStep++;
      const nextVolume = startVolume - ((startVolume - targetVolume) * (currentStep / steps));
      this.videoElement.volume = Math.max(0, nextVolume);

      if (currentStep >= steps) {
        if (this.fadeInterval !== null) {
          window.clearInterval(this.fadeInterval);
          this.fadeInterval = null;
        }
        this.videoElement.volume = targetVolume;
      }
    }, stepDuration);
  }
}
