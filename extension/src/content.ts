import { DoubleBufferedAudioPlayer } from './player';
import type { AudioFallbackEvent } from './player';
import { GhostInterfaceManager, UIConfig } from './ui';

const BACKEND_URL = 'http://localhost:8765';
const INITIAL_BUFFER_TIMEOUT_MS = 10_000;
const SEEK_BUFFER_TIMEOUT_MS = 8_000;
const LOOK_AHEAD_COUNT = 5;
const MIN_SUBTITLE_PAGE_WEIGHT = 1;

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

interface SubtitlePageBundle {
  enPages: string[];
  viPages: string[];
  weights: number[];
}

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
  private subtitlePageCache = new Map<string, SubtitlePageBundle>();
  private lastRenderedSubtitleKey = '';
  private fallbackSegmentIndex = -1;

  private config: UIConfig = {
    voice: 'vi-VN-NamMinhNeural',
    volume: 0.8,
    subMode: 'vi'
  };

  constructor() {
    this.sessionId = this.createSessionId();
    this.player = new DoubleBufferedAudioPlayer();
    this.player.setFallbackHandler((event) => this.handleAudioFallback(event));
    this.player.setPlayingHandler(() => this.handleDubAudioPlaying());
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
    const subModeChanged = this.config.subMode !== newConfig.subMode;
    this.config = newConfig;
    this.player.setDubVolume(newConfig.volume);

    if (voiceChanged && this.isDubbingEnabled) {
      this.disableDubbing(false);
      this.sessionId = this.createSessionId();
      void this.enableDubbing();
      return;
    }

    if (subModeChanged) {
      this.subtitlePageCache.clear();
      this.lastRenderedSubtitleKey = '';
    }

    this.renderCurrentSubtitles();
  }

  private async enableDubbing(): Promise<void> {
    const token = ++this.lifecycleToken;
    this.isDubbingEnabled = true;
    this.activeSegmentIndex = -1;
    this.fallbackSegmentIndex = -1;
    this.segments = [];
    this.subtitlePageCache.clear();
    this.lastRenderedSubtitleKey = '';
    this.player.stopAll();

    this.transitionTo('INITIALIZING');
    this.ui.updateStatusBadge('active', 'Dịch...');
    this.ui.updateVisualizer(false);
    this.ui.updateSubtitles('off', null, null);
    this.ui.showLoadingOverlay('Đang chuẩn bị phụ đề dịch...');
    const loadingSafetyTimeout = window.setTimeout(() => {
      this.ui.hideLoadingOverlay();
    }, 15_000);

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
      this.ui.showLoadingOverlay('Đang chuẩn bị giọng đọc...');

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
      this.resumeVideo();
      this.disableDubbing(false);
    } finally {
      window.clearTimeout(loadingSafetyTimeout);
      this.ui.hideLoadingOverlay();
    }
  }

  private disableDubbing(updateBadge = true): void {
    this.lifecycleToken++;
    this.seekToken++;
    this.isDubbingEnabled = false;
    this.segments = [];
    this.activeSegmentIndex = -1;
    this.fallbackSegmentIndex = -1;
    this.audioPlayVideoTime = 0;
    this.subtitlePageCache.clear();
    this.lastRenderedSubtitleKey = '';
    this.player.stopAll();
    this.ui.updateVisualizer(false);
    this.ui.updateSubtitles('off', null, null);
    this.ui.hideLoadingOverlay();
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
      this.fallbackSegmentIndex = -1;
      this.playSegment(segment);
    }

    this.renderCurrentSubtitles();
  };

  private playSegment(segment: VideoSegment): void {
    if (!this.video) return;

    const currentTime = this.video.currentTime;
    const remainingDuration = Math.max(0.1, segment.end - currentTime);
    const streamUrl = this.getStreamUrl(segment.index);
    const preloadUrl = this.getPreloadUrl(segment.index);

    this.audioPlayVideoTime = currentTime;
    this.transitionTo('PLAYING');
    this.ui.updateStatusBadge('active', 'Active');
    this.ui.updateVisualizer(true);
    this.player.play(streamUrl, preloadUrl, remainingDuration);

    void this.prepareWindow('PLAYBACK', segment.index, LOOK_AHEAD_COUNT);
  }

  private handleSilenceGap(): void {
    if (this.activeSegmentIndex === -1) return;

    this.activeSegmentIndex = -1;
    this.fallbackSegmentIndex = -1;
    this.audioPlayVideoTime = 0;
    this.player.restoreVideoVolume();
    this.ui.updateVisualizer(false);
    this.hideSubtitles();
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
    this.fallbackSegmentIndex = -1;
    this.audioPlayVideoTime = 0;

    const anchor = this.findAnchorSegment(this.video.currentTime);
    if (!anchor) {
      this.transitionTo('PLAYING');
      this.resumeVideo();
      return;
    }

    this.renderSegmentSubtitles(anchor, this.video.currentTime, true);
    this.ui.showLoadingOverlay('Đang tải giọng đọc...');

    try {
      if (this.video && !this.video.paused) {
        this.video.pause();
      }

      await this.prepareWindow('SEEK', anchor.index, LOOK_AHEAD_COUNT);
      await this.waitForStreamReady(anchor.index, SEEK_BUFFER_TIMEOUT_MS);
    } finally {
      this.ui.hideLoadingOverlay();

      if (token !== this.seekToken || !this.isDubbingEnabled) return;

      this.transitionTo('PLAYING');
      this.resumeVideo();
      this.onTimeUpdate();
    }
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

  private handleAudioFallback(event: AudioFallbackEvent): void {
    if (!this.isDubbingEnabled || this.state !== 'PLAYING') return;
    if (this.activeSegmentIndex === -1) return;
    if (this.fallbackSegmentIndex === this.activeSegmentIndex) return;

    this.fallbackSegmentIndex = this.activeSegmentIndex;
    this.player.restoreVideoVolume();
    this.ui.updateVisualizer(false);
    this.ui.updateStatusBadge('fallback', 'Tiếng gốc');
    this.renderCurrentSubtitles();

    console.warn('[LiveTube] Soft fallback to original audio:', {
      segmentIndex: this.activeSegmentIndex,
      reason: event.reason,
      message: event.message
    });
  }

  private handleDubAudioPlaying(): void {
    if (!this.isDubbingEnabled || this.state !== 'PLAYING') return;

    this.fallbackSegmentIndex = -1;
    this.ui.updateStatusBadge('active', 'Active');
    this.ui.updateVisualizer(true);
  }

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
    if (this.config.subMode === 'off' || this.activeSegmentIndex === -1 || this.segments.length === 0) {
      this.hideSubtitles();
      return;
    }

    const segment = this.segments.find((item) => item.index === this.activeSegmentIndex);
    if (!segment) return;

    this.renderSegmentSubtitles(segment, this.video?.currentTime ?? segment.start);
  }

  private renderSegmentSubtitles(segment: VideoSegment, currentTime: number, force = false): void {
    if (this.config.subMode === 'off') {
      this.hideSubtitles();
      return;
    }

    const pages = this.getSubtitlePageBundle(segment);
    const duration = Math.max(0.1, segment.end - segment.start);
    const ratio = Math.max(0, Math.min(1, (currentTime - segment.start) / duration));
    const pageIndex = this.selectWeightedPageIndex(pages.weights, ratio);

    const enText = this.config.subMode === 'bilingual' ? pages.enPages[pageIndex] || null : null;
    const viText = pages.viPages[pageIndex] || null;
    const renderKey = `${this.config.subMode}:${segment.index}:${pageIndex}:${enText || ''}:${viText || ''}`;

    if (!force && renderKey === this.lastRenderedSubtitleKey) return;

    this.lastRenderedSubtitleKey = renderKey;
    this.ui.updateSubtitles(this.config.subMode, enText, viText);
  }

  private hideSubtitles(): void {
    if (this.lastRenderedSubtitleKey === 'hidden') return;

    this.lastRenderedSubtitleKey = 'hidden';
    this.ui.updateSubtitles('off', null, null);
  }

  private getSubtitlePageBundle(segment: VideoSegment): SubtitlePageBundle {
    const cacheKey = `${segment.index}:${this.config.subMode}:${this.ui.getSubtitleLayoutSignature()}`;
    const cached = this.subtitlePageCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const sourceText = this.normalizeSubtitleText(segment.sourceText);
    const translatedText = this.normalizeSubtitleText(segment.translatedText || segment.sourceText);
    let viPages = this.ui.paginateSubtitleText(translatedText, 'vi');
    let enPages = this.config.subMode === 'bilingual'
      ? this.ui.paginateSubtitleText(sourceText, 'en')
      : [];

    if (this.config.subMode === 'bilingual') {
      const pageCount = Math.max(viPages.length, enPages.length, 1);

      if (viPages.length !== pageCount) {
        viPages = this.splitTextIntoPageCount(translatedText, pageCount);
      }

      if (enPages.length !== pageCount) {
        enPages = this.splitTextIntoPageCount(sourceText, pageCount);
      }
    }

    const weights = viPages.map((page, index) => (
      this.calculateSubtitlePageWeight(page || enPages[index] || '')
    ));
    const bundle: SubtitlePageBundle = {
      enPages,
      viPages,
      weights: weights.length > 0 ? weights : [MIN_SUBTITLE_PAGE_WEIGHT]
    };

    this.subtitlePageCache.set(cacheKey, bundle);
    return bundle;
  }

  private splitTextIntoPageCount(text: string, pageCount: number): string[] {
    const normalized = this.normalizeSubtitleText(text);
    if (!normalized) return [];
    if (pageCount <= 1) return [normalized];

    const words = normalized.split(/\s+/);
    const pages: string[] = [];
    let start = 0;

    for (let page = 0; page < pageCount; page++) {
      if (start >= words.length) {
        pages.push('');
        continue;
      }

      const remainingPages = pageCount - page;
      if (remainingPages === 1) {
        pages.push(words.slice(start).join(' '));
        break;
      }

      const remainingText = words.slice(start).join(' ');
      const targetChars = Math.max(1, Math.ceil(remainingText.length / remainingPages));
      const end = this.findNaturalPageBreak(words, start, targetChars);

      pages.push(words.slice(start, end + 1).join(' '));
      start = end + 1;
    }

    return pages;
  }

  private findNaturalPageBreak(words: string[], start: number, targetChars: number): number {
    let charCount = 0;
    let bestEnd = start;
    let recentBoundary = -1;

    for (let i = start; i < words.length; i++) {
      charCount += words[i].length + (i === start ? 0 : 1);

      if (/[,.!?;:]$/.test(words[i])) {
        recentBoundary = i;
      }

      bestEnd = i;
      if (charCount >= targetChars) {
        return recentBoundary >= start && recentBoundary >= i - 4 ? recentBoundary : bestEnd;
      }
    }

    return bestEnd;
  }

  private selectWeightedPageIndex(weights: number[], ratio: number): number {
    if (weights.length <= 1) return 0;

    const totalWeight = weights.reduce((sum, weight) => sum + Math.max(MIN_SUBTITLE_PAGE_WEIGHT, weight), 0);
    const targetWeight = Math.min(totalWeight - Number.EPSILON, Math.max(0, ratio) * totalWeight);
    let cursor = 0;

    for (let i = 0; i < weights.length; i++) {
      cursor += Math.max(MIN_SUBTITLE_PAGE_WEIGHT, weights[i]);
      if (targetWeight < cursor) return i;
    }

    return weights.length - 1;
  }

  private calculateSubtitlePageWeight(text: string): number {
    const normalized = this.normalizeSubtitleText(text);
    if (!normalized) return MIN_SUBTITLE_PAGE_WEIGHT;

    const wordCount = normalized.split(/\s+/).length;
    return Math.max(MIN_SUBTITLE_PAGE_WEIGHT, normalized.length + wordCount * 4);
  }

  private normalizeSubtitleText(text: string): string {
    return (text || '').replace(/\s+/g, ' ').trim();
  }
}

const script = new LiveTubeContentScript();
script.start();
