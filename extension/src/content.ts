import { DoubleBufferedAudioPlayer } from './player';
import { GhostInterfaceManager, UIConfig } from './ui';

const BACKEND_URL = 'http://localhost:8765';
const INITIAL_BUFFER_TIMEOUT_MS = 10_000;
const SEEK_BUFFER_TIMEOUT_MS = 8_000;
const LOOK_AHEAD_COUNT = 5;

interface VideoSegment {
  index: number;
  start: number;
  end: number;
  sourceText: string;
  translatedText: string;
}

interface SessionResponse {
  status: 'READY' | 'FAILED';
  sessionId: string;
  videoId: string;
  segments: VideoSegment[];
  error?: string;
}

type PrepareMode = 'INITIAL' | 'PLAYBACK' | 'SEEK';
type PlaybackState = 'IDLE' | 'INITIALIZING' | 'BUFFERING' | 'PLAYING' | 'SEEK_BUFFERING';

class LiveTubeContentScript {
  private sessionId: string;
  private state: PlaybackState = 'IDLE';
  private lifecycleToken = 0;
  private seekToken = 0;

  private player: DoubleBufferedAudioPlayer;
  private ui: GhostInterfaceManager;
  private video: HTMLVideoElement | null = null;
  private segments: VideoSegment[] = [];

  private activeSegmentIndex = -1;
  private isDubbingEnabled = false;
  private audioPlayVideoTime = 0;

  private config: UIConfig = {
    voice: 'vi-VN-NamMinhNeural',
    volume: 0.8,
    subMode: 'vi'
  };

  constructor() {
    this.sessionId = this.createSessionId();
    this.player = new DoubleBufferedAudioPlayer();
    this.ui = new GhostInterfaceManager();
  }

  public start(): void {
    console.log('[LiveTube] Content script initialized. Version 3.0');

    this.ui.init(
      (enabled) => this.handleToggle(enabled),
      (newConfig) => this.handleConfigChange(newConfig)
    );

    document.addEventListener('yt-navigate-finish', () => {
      this.handlePageNavigation();
    });

    this.handlePageNavigation();
  }

  private createSessionId(): string {
    return crypto.randomUUID ? crypto.randomUUID() : this.generateUUID();
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = Math.random() * 16 | 0;
      const value = char === 'x' ? random : (random & 0x3 | 0x8);
      return value.toString(16);
    });
  }

  private handlePageNavigation(): void {
    console.log('[LiveTube] YouTube navigation detected. Preparing V3 UI...');
    this.sessionId = this.createSessionId();
    this.disableDubbing(false);
    this.ui.destroy();

    setTimeout(() => {
      this.setupElements();
    }, 1500);
  }

  private setupElements(): void {
    const playerEl = document.querySelector('.html5-video-player') as HTMLElement | null;
    const rightControls = document.querySelector('.ytp-right-controls') as HTMLElement | null;
    const videoEl = document.querySelector('video') as HTMLVideoElement | null;

    if (!playerEl || !rightControls || !videoEl) {
      setTimeout(() => this.setupElements(), 1000);
      return;
    }

    this.video = videoEl;
    this.player.setVideoElement(videoEl);

    this.video.removeEventListener('timeupdate', this.onTimeUpdate);
    this.video.removeEventListener('seeked', this.onVideoSeek);
    this.video.removeEventListener('pause', this.onVideoPause);
    this.video.removeEventListener('play', this.onVideoPlay);
    this.video.removeEventListener('ratechange', this.onPlaybackRateChange);

    this.video.addEventListener('timeupdate', this.onTimeUpdate);
    this.video.addEventListener('seeked', this.onVideoSeek);
    this.video.addEventListener('pause', this.onVideoPause);
    this.video.addEventListener('play', this.onVideoPlay);
    this.video.addEventListener('ratechange', this.onPlaybackRateChange);

    this.ui.injectUI(playerEl, rightControls);
    void this.checkServerHealth();
  }

  private async checkServerHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${BACKEND_URL}/status`);
      if (res.ok) {
        this.ui.updateStatusBadge('ready', 'Ready');
        return true;
      }
    } catch {
      // Server offline is represented in the UI below.
    }

    this.ui.updateStatusBadge('offline', 'Offline');
    return false;
  }

  private handleToggle(enabled: boolean): void {
    if (enabled) {
      void this.enableDubbing();
    } else {
      this.disableDubbing();
    }
  }

  private handleConfigChange(newConfig: UIConfig): void {
    const voiceChanged = this.config.voice !== newConfig.voice;
    this.config = newConfig;
    this.player.setDubVolume(newConfig.volume);

    if (voiceChanged && this.isDubbingEnabled) {
      this.disableDubbing(false);
      this.sessionId = this.createSessionId();
      void this.enableDubbing();
      return;
    }

    this.renderCurrentSubtitles();
  }

  private async enableDubbing(): Promise<void> {
    const token = ++this.lifecycleToken;
    this.isDubbingEnabled = true;
    this.activeSegmentIndex = -1;
    this.segments = [];
    this.player.stopAll();

    this.transitionTo('INITIALIZING');
    this.ui.updateStatusBadge('active', 'Dịch...');
    this.ui.updateVisualizer(false);
    this.ui.updateSubtitles('vi', null, 'Đang chuẩn bị phụ đề dịch...');

    try {
      const session = await this.createSession();
      if (token !== this.lifecycleToken || !this.isDubbingEnabled) return;

      this.segments = session.segments || [];
      if (this.segments.length === 0) {
        throw new Error('Không có timeline phụ đề để lồng tiếng.');
      }

      const anchor = this.findAnchorSegment(this.video?.currentTime || 0);
      this.transitionTo('BUFFERING');
      this.ui.updateStatusBadge('active', 'Buffering');
      this.ui.updateSubtitles('vi', null, 'Đang chuẩn bị giọng đọc...');

      if (this.video && !this.video.paused) {
        this.video.pause();
      }

      if (anchor) {
        await this.prepareWindow('INITIAL', anchor.index, LOOK_AHEAD_COUNT);
        await this.waitForStreamReady(anchor.index, INITIAL_BUFFER_TIMEOUT_MS);
      }

      if (token !== this.lifecycleToken || !this.isDubbingEnabled) return;

      this.transitionTo('PLAYING');
      this.ui.updateStatusBadge('active', 'Active');
      this.resumeVideo();
      this.onTimeUpdate();
    } catch (error) {
      console.error('[LiveTube ERROR] Failed to enable dubbing:', error);
      this.ui.updateStatusBadge('offline', 'Lỗi');
      this.ui.updateSubtitles('vi', null, `Lỗi: ${(error as Error).message}`);
      this.disableDubbing(false);
    }
  }

  private disableDubbing(updateBadge = true): void {
    this.lifecycleToken++;
    this.seekToken++;
    this.isDubbingEnabled = false;
    this.segments = [];
    this.activeSegmentIndex = -1;
    this.audioPlayVideoTime = 0;
    this.player.stopAll();
    this.ui.updateVisualizer(false);
    this.ui.updateSubtitles('off', null, null);
    if (updateBadge) {
      this.ui.updateStatusBadge('ready', 'Ready');
    }
    this.transitionTo('IDLE');
  }

  private transitionTo(newState: PlaybackState): void {
    if (this.state !== newState) {
      console.log(`[FSM] ${this.state} -> ${newState}`);
      this.state = newState;
    }
  }

  private async createSession(): Promise<SessionResponse> {
    const response = await fetch(`${BACKEND_URL}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: this.sessionId,
        url: window.location.href,
        voice: this.config.voice,
        rate: '+0%',
        volume: '+0%'
      })
    });

    if (!response.ok) {
      throw new Error('Không thể khởi tạo session ở server.');
    }

    const data = await response.json() as SessionResponse;
    if (data.status === 'FAILED') {
      throw new Error(data.error || 'Dịch thuật thất bại.');
    }

    return data;
  }

  private async prepareWindow(mode: PrepareMode, anchorIndex: number, lookAhead: number): Promise<void> {
    try {
      const response = await fetch(`${BACKEND_URL}/api/sessions/${this.sessionId}/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anchorIndex, mode, lookAhead })
      });

      if (!response.ok) {
        console.warn(`[LiveTube] Prepare ${mode} failed with HTTP ${response.status}.`);
      }
    } catch (error) {
      console.warn(`[LiveTube] Prepare ${mode} request failed:`, error);
    }
  }

  private waitForStreamReady(segmentIndex: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const audio = new Audio();
      let settled = false;
      let timeout: number | null = null;

      const cleanup = (): void => {
        audio.removeEventListener('canplay', onReady);
        audio.removeEventListener('loadeddata', onReady);
        audio.removeEventListener('error', onError);
        if (timeout !== null) {
          window.clearTimeout(timeout);
        }
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      };

      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(ready);
      };

      const onReady = (): void => finish(true);
      const onError = (): void => finish(false);

      timeout = window.setTimeout(() => finish(false), timeoutMs);
      audio.preload = 'auto';
      audio.addEventListener('canplay', onReady, { once: true });
      audio.addEventListener('loadeddata', onReady, { once: true });
      audio.addEventListener('error', onError, { once: true });
      audio.src = this.getStreamUrl(segmentIndex);
      audio.load();
    });
  }

  private getStreamUrl(segmentIndex: number): string {
    return `${BACKEND_URL}/api/stream/${this.sessionId}/${segmentIndex}`;
  }

  private getPreloadUrl(segmentIndex: number): string | null {
    const nextSegment = this.segments.find((segment) => segment.index === segmentIndex + 1);
    return nextSegment ? this.getStreamUrl(nextSegment.index) : null;
  }

  private findSegmentAt(time: number): VideoSegment | null {
    return this.segments.find((segment) => time >= segment.start && time <= segment.end) || null;
  }

  private findAnchorSegment(time: number): VideoSegment | null {
    return this.findSegmentAt(time)
      || this.segments.find((segment) => segment.start >= time)
      || this.segments[this.segments.length - 1]
      || null;
  }

  private onTimeUpdate = (): void => {
    if (!this.isDubbingEnabled || !this.video || this.segments.length === 0) return;
    if (this.state === 'INITIALIZING' || this.state === 'BUFFERING' || this.state === 'SEEK_BUFFERING') return;

    const segment = this.findSegmentAt(this.video.currentTime);
    if (!segment) {
      this.handleSilenceGap();
      return;
    }

    if (segment.index !== this.activeSegmentIndex) {
      this.activeSegmentIndex = segment.index;
      this.playSegment(segment);
    }
  };

  private playSegment(segment: VideoSegment): void {
    if (!this.video) return;

    const currentTime = this.video.currentTime;
    const remainingDuration = Math.max(0.1, segment.end - currentTime);
    const streamUrl = this.getStreamUrl(segment.index);
    const preloadUrl = this.getPreloadUrl(segment.index);

    this.audioPlayVideoTime = currentTime;
    this.transitionTo('PLAYING');
    this.ui.updateVisualizer(true);
    this.ui.updateSubtitles(this.config.subMode, segment.sourceText, segment.translatedText);
    this.player.play(streamUrl, preloadUrl, remainingDuration);

    void this.prepareWindow('PLAYBACK', segment.index, LOOK_AHEAD_COUNT);
  }

  private handleSilenceGap(): void {
    if (this.activeSegmentIndex === -1) return;

    this.activeSegmentIndex = -1;
    this.audioPlayVideoTime = 0;
    this.player.restoreVideoVolume();
    this.ui.updateVisualizer(false);
    this.ui.updateSubtitles(this.config.subMode, null, null);
  }

  private onVideoSeek = (): void => {
    if (!this.isDubbingEnabled || !this.video || this.segments.length === 0) return;
    void this.handleSeekBuffering();
  };

  private async handleSeekBuffering(): Promise<void> {
    if (!this.video) return;

    const token = ++this.seekToken;
    this.transitionTo('SEEK_BUFFERING');
    this.player.stopAll();
    this.ui.updateVisualizer(false);
    this.activeSegmentIndex = -1;
    this.audioPlayVideoTime = 0;

    const anchor = this.findAnchorSegment(this.video.currentTime);
    if (!anchor) {
      this.transitionTo('PLAYING');
      this.resumeVideo();
      return;
    }

    this.ui.updateSubtitles(this.config.subMode, anchor.sourceText, `Đang tải giọng đọc... ${anchor.translatedText}`);

    if (!this.video.paused) {
      this.video.pause();
    }

    await this.prepareWindow('SEEK', anchor.index, LOOK_AHEAD_COUNT);
    await this.waitForStreamReady(anchor.index, SEEK_BUFFER_TIMEOUT_MS);

    if (token !== this.seekToken || !this.isDubbingEnabled) return;

    this.transitionTo('PLAYING');
    this.resumeVideo();
    this.onTimeUpdate();
  }

  private onVideoPause = (): void => {
    if (!this.isDubbingEnabled) return;
    if (this.state === 'BUFFERING' || this.state === 'SEEK_BUFFERING') return;

    this.player.pause();
    this.ui.updateVisualizer(false);
  };

  private onVideoPlay = (): void => {
    if (!this.isDubbingEnabled || this.state !== 'PLAYING') return;

    this.player.resume();
    if (this.activeSegmentIndex !== -1) {
      this.ui.updateVisualizer(true);
      window.setTimeout(() => {
        if (this.state === 'PLAYING' && this.activeSegmentIndex !== -1) {
          this.player.checkDriftAndMicroAdjust(this.audioPlayVideoTime);
        }
      }, 300);
    }
  };

  private onPlaybackRateChange = (): void => {
    if (!this.isDubbingEnabled || !this.video) return;

    this.player.syncPlaybackRate(this.video.playbackRate);
    window.setTimeout(() => {
      if (this.state === 'PLAYING' && this.activeSegmentIndex !== -1) {
        this.player.checkDriftAndMicroAdjust(this.audioPlayVideoTime);
      }
    }, 300);
  };

  private resumeVideo(): void {
    if (this.video && this.video.paused) {
      this.video.play().catch(() => {});
    }
  }

  private renderCurrentSubtitles(): void {
    if (this.activeSegmentIndex === -1 || this.segments.length === 0) {
      this.ui.updateSubtitles('off', null, null);
      return;
    }

    const segment = this.segments.find((item) => item.index === this.activeSegmentIndex);
    if (!segment) return;

    const prefix = this.state === 'SEEK_BUFFERING' || this.state === 'BUFFERING' ? 'Đang tải giọng đọc... ' : '';
    this.ui.updateSubtitles(this.config.subMode, segment.sourceText, `${prefix}${segment.translatedText}`);
  }
}

const script = new LiveTubeContentScript();
script.start();
