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
      this.playActiveAudio(active);
      this.loadPreloadStream(preloadUrl);
      return;
    }

    const active = this.getActiveAudio();
    this.cleanupAudio(active);
    active.src = streamUrl;
    active.volume = this.defaultDubVolume;
    this.prepareActiveAudio(active, segmentDuration);
    active.load();
    this.playActiveAudio(active);
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
    });
  }

  public stopAll(): void {
    this.cleanupAudio(this.audioA);
    this.cleanupAudio(this.audioB);
    this.restoreVideoVolume();
    this.isAudioReadyForSync = false;
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

      this.isAudioReadyForSync = true;
      this.duckVideoVolume();
      console.log('[Player] Stream is playing.');
    });

    audio.addEventListener('waiting', () => {
      if (audio !== this.getActiveAudio()) return;

      this.isAudioReadyForSync = false;
      console.log('[Player] Stream is buffering...');
    });

    audio.addEventListener('error', () => {
      if (audio !== this.getActiveAudio()) return;

      this.isAudioReadyForSync = false;
      console.warn('[Player] Stream error. Restoring original video audio.');
      this.restoreVideoVolume();
    });

    audio.addEventListener('ended', () => {
      if (audio !== this.getActiveAudio()) return;

      this.isAudioReadyForSync = false;
      this.restoreVideoVolume();
    });

    return audio;
  }

  private prepareActiveAudio(audio: HTMLAudioElement, segmentDuration?: number): void {
    this.isAudioReadyForSync = false;
    this.applyDynamicRate(audio, segmentDuration);
  }

  private playActiveAudio(audio: HTMLAudioElement): void {
    audio.play().catch((error) => {
      console.warn('[Player] Stream playback failed:', error);
      this.isAudioReadyForSync = false;
      this.restoreVideoVolume();
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
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch {
      // Ignore cleanup failures from detached or partially loaded streams.
    }
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
