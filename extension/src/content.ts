import { DoubleBufferedAudioPlayer } from './player';
import { GhostInterfaceManager, UIConfig } from './ui';

const BACKEND_URL = 'http://localhost:8765';

interface VideoSegment {
  index: number;
  start: number;
  end: number;
  sourceText: string;
  translatedText: string;
  audioStatus: 'PENDING' | 'GENERATING' | 'READY' | 'FAILED';
  audioUrl: string | null;
  cacheKey: string | null;
}

type PlaybackState = 'IDLE' | 'INITIALIZING' | 'SYNCING' | 'POLLING_AUDIO' | 'ORIGINAL_FALLBACK';

class LiveTubeContentScript {
  private sessionId: string;
  private state: PlaybackState = 'IDLE';
  
  private player: DoubleBufferedAudioPlayer;
  private ui: GhostInterfaceManager;
  
  private video: HTMLVideoElement | null = null;
  private segments: VideoSegment[] = [];
  
  private activeSegmentIndex = -1;
  private isDubbingEnabled = false;

  // Cấu hình UI mặc định
  private config: UIConfig = {
    voice: 'vi-VN-NamMinhNeural',
    volume: 0.8,
    subMode: 'vi'
  };

  // Quản lý polling
  private pollInterval: any = null;
  private pollTimeout: any = null;

  // Ngăn chặn vòng lặp Smart Pause vô tận
  private isSmartPausing = false;
  
  // Trạng thái chờ sinh audio cho câu thoại hiện tại
  private isWaitingForAudio = false;

  constructor() {
    this.sessionId = crypto.randomUUID ? crypto.randomUUID() : this.generateUUID();
    this.player = new DoubleBufferedAudioPlayer();
    this.ui = new GhostInterfaceManager();
  }

  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Khởi động Content Script
   */
  public start() {
    console.log('[LiveTube] Content script initialized. Version 2.0');
    
    // Đăng ký listeners cho giao diện UI
    this.ui.init(
      (enabled) => this.handleToggle(enabled),
      (newConfig) => this.handleConfigChange(newConfig)
    );

    // Đăng ký lắng nghe chuyển trang SPA của YouTube
    document.addEventListener('yt-navigate-finish', () => {
      this.handlePageNavigation();
    });

    // Chạy khởi tạo lần đầu
    this.handlePageNavigation();
  }

  /**
   * Xử lý chuyển trang YouTube
   */
  private handlePageNavigation() {
    console.log('[LiveTube] Chuyển trang YouTube detected. Đang chuẩn bị UI...');
    
    // Tạo session ID mới cho trang mới để tránh bị nhiễm chéo dữ liệu của các segment cũ
    this.sessionId = crypto.randomUUID ? crypto.randomUUID() : this.generateUUID();
    console.log(`[LiveTube] Generated new Session ID: ${this.sessionId}`);

    // 1. Dọn dẹp trạng thái cũ
    this.disableDubbing();
    this.ui.destroy();

    // 2. Chờ DOM của YouTube vẽ xong để inject UI
    setTimeout(() => {
      this.setupElements();
    }, 1500);
  }

  private setupElements() {
    const playerEl = document.querySelector('.html5-video-player') as HTMLElement;
    const rightControls = document.querySelector('.ytp-right-controls') as HTMLElement;
    const videoEl = document.querySelector('video') as HTMLVideoElement;

    if (!playerEl || !rightControls || !videoEl) {
      // Thử lại sau 1s nếu DOM chưa sẵn sàng
      setTimeout(() => this.setupElements(), 1000);
      return;
    }

    this.video = videoEl;
    this.player.setVideoElement(videoEl);

    // Đăng ký bắt sự kiện video YouTube
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

    // Inject Shadow DOM UI
    this.ui.injectUI(playerEl, rightControls);

    // Kiểm tra sức khỏe kết nối server
    this.checkServerHealth();
  }

  /**
   * Ping kiểm tra server
   */
  private async checkServerHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${BACKEND_URL}/status`);
      if (res.ok) {
        this.ui.updateStatusBadge('ready', 'Ready');
        return true;
      }
    } catch (e) {
      // Bỏ qua lỗi kết nối
    }
    this.ui.updateStatusBadge('offline', 'Offline');
    return false;
  }

  /**
   * Xử lý khi user Bật/Tắt switch lồng tiếng
   */
  private handleToggle(enabled: boolean) {
    if (enabled) {
      this.enableDubbing();
    } else {
      this.disableDubbing();
    }
  }

  /**
   * Xử lý khi thay đổi cấu hình giọng đọc / âm lượng / phụ đề
   */
  private handleConfigChange(newConfig: UIConfig) {
    const voiceChanged = this.config.voice !== newConfig.voice;
    this.config = newConfig;

    this.player.setDubVolume(newConfig.volume);

    // Nếu đổi giọng đọc, buộc phải init lại session để queue sinh giọng đọc mới
    if (voiceChanged && this.isDubbingEnabled) {
      console.log('[LiveTube] Thay đổi giọng đọc, đang khởi tạo lại session...');
      this.enableDubbing();
    } else {
      // Cập nhật phụ đề hiển thị ngay lập tức
      this.renderCurrentSubtitles();
    }
  }

  /**
   * Khởi động quá trình lồng tiếng cho video hiện tại
   */
  private async enableDubbing() {
    this.isDubbingEnabled = true;
    
    // Tạm dừng phát video gốc ngay lập tức trong khi tải/dịch phụ đề
    if (this.video) {
      console.log('[Script] Tạm dừng video để khởi tạo lồng tiếng...');
      this.video.pause();
    }
    
    this.transitionTo('INITIALIZING');
    this.ui.updateStatusBadge('active', 'Dịch...');
    this.ui.updateSubtitles('vi', null, '⏳ Đang chuẩn bị phụ đề dịch...');

    try {
      const payload = {
        sessionId: this.sessionId,
        url: window.location.href,
        voice: this.config.voice,
        rate: '+0%',
        volume: '+0%'
      };

      const res = await fetch(`${BACKEND_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Không thể khởi tạo session ở server');

      const data = await res.json();
      if (data.status === 'FAILED') {
        throw new Error(data.error || 'Dịch thuật thất bại.');
      }

      this.segments = data.segments || [];
      console.log(`[Script] Đã tải thành công ${this.segments.length} segments timeline.`);

      this.ui.updateStatusBadge('active', 'Active');
      this.ui.updateSubtitles('vi', null, '🎉 Đã bật lồng tiếng Việt!');
      
      // Xóa câu chào sau 1.5s và bắt đầu phát
      setTimeout(() => {
        this.transitionTo('SYNCING');
        this.renderCurrentSubtitles();
        
        // Tiếp tục phát video gốc khi hệ thống lồng tiếng đã sẵn sàng
        if (this.video && this.video.paused) {
          console.log('[Script] Khởi tạo xong. Tiếp tục phát video.');
          this.video.play().catch(() => {});
        }
      }, 1500);

      this.activeSegmentIndex = -1;

    } catch (err) {
      console.error('[Script ERROR] Bật lồng tiếng thất bại:', err);
      this.ui.updateStatusBadge('offline', 'Lỗi');
      this.ui.updateSubtitles('vi', null, `❌ Lỗi: ${(err as Error).message}`);
      this.disableDubbing();
    }
  }

  /**
   * Tắt lồng tiếng, khôi phục tiếng gốc
   */
  private disableDubbing() {
    this.isDubbingEnabled = false;
    this.segments = [];
    this.activeSegmentIndex = -1;
    this.clearPolling();
    this.player.stopAll();
    this.ui.updateVisualizer(false);
    this.ui.updateSubtitles('off', null, null);
    this.transitionTo('IDLE');
  }

  private transitionTo(newState: PlaybackState) {
    console.log(`[FSM] Chuyển trạng thái: ${this.state} -> ${newState}`);
    this.state = newState;
  }

  /**
   * Loop chính theo dõi timeline video.currentTime
   */
  private onTimeUpdate = () => {
    if (!this.isDubbingEnabled || this.segments.length === 0 || !this.video) return;
    if (this.state === 'INITIALIZING') return;

    const currTime = this.video.currentTime;

    // --- SMART PAUSE LOGIC (Đảm bảo câu thoại trước phải đọc xong mới được đi tiếp) ---
    if (this.activeSegmentIndex !== -1 && this.state === 'SYNCING') {
      const activeAudio = this.player.getActiveAudio();
      const currentSeg = this.segments.find(s => s.index === this.activeSegmentIndex);
      
      if (currentSeg && activeAudio && !activeAudio.paused && !activeAudio.ended && activeAudio.duration) {
        const videoTimeRemaining = currentSeg.end - currTime;
        const audioTimeRemaining = (activeAudio.duration - activeAudio.currentTime) / activeAudio.playbackRate;
        
        // Nếu audio lồng tiếng còn chưa đọc xong và video chuẩn bị (hoặc đã) vượt quá mốc end_time của segment
        if (audioTimeRemaining > videoTimeRemaining + 0.05 && videoTimeRemaining < 0.3) {
          if (!this.isSmartPausing) {
            console.log(`[Smart Pause] Kích hoạt. Chặn nhảy câu. Audio còn ${audioTimeRemaining.toFixed(2)}s, Video còn ${videoTimeRemaining.toFixed(2)}s.`);
            this.isSmartPausing = true;
            this.video.pause();
            
            const onAudioEnded = () => {
              if (this.isSmartPausing && this.video) {
                console.log('[Smart Pause] Audio kết thúc. Tiếp tục phát video.');
                this.isSmartPausing = false;
                this.video.play().catch(() => {});
              }
              activeAudio.removeEventListener('ended', onAudioEnded);
            };
            activeAudio.addEventListener('ended', onAudioEnded);
          }
          // Chặn xử lý tìm segment mới khi đang trong trạng thái Smart Pause chờ câu thoại hiện tại kết thúc
          return;
        }
      }
    }

    // Tìm segment chứa thời gian hiện tại
    const seg = this.segments.find(s => currTime >= s.start && currTime <= s.end);

    if (seg) {
      if (seg.index !== this.activeSegmentIndex) {
        // Chuyển sang segment mới
        this.activeSegmentIndex = seg.index;
        this.handleSegmentTransition(seg);
      } else {
        // Vẫn ở trong segment cũ: Kiểm tra lệch pha & thực hiện Micro-adjustments
        if (this.state === 'SYNCING') {
          this.player.checkDriftAndMicroAdjust(seg.start);
        }
      }
    } else {
      // Nằm ngoài timeline tất cả câu thoại (Silence gap)
      if (this.activeSegmentIndex !== -1) {
        this.activeSegmentIndex = -1;
        this.player.restoreVideoVolume();
        this.ui.updateVisualizer(false);
        this.ui.updateSubtitles(this.config.subMode, null, null);
      }
    }
  };

  /**
   * Xử lý khi chuyển sang câu thoại mới
   */
  private handleSegmentTransition(seg: VideoSegment) {
    this.clearPolling();

    // Chuẩn bị URL cho câu hiện tại và câu tiếp theo để preloading
    const voiceKey = this.config.voice;
    const activeUrl = seg.audioUrl ? `${BACKEND_URL}${seg.audioUrl}` : `${BACKEND_URL}/audio/cache/${seg.cacheKey}.mp3`;
    
    const nextSeg = this.segments.find(s => s.index === seg.index + 1);
    const preloadUrl = nextSeg && nextSeg.audioStatus === 'READY' 
      ? (nextSeg.audioUrl ? `${BACKEND_URL}${nextSeg.audioUrl}` : `${BACKEND_URL}/audio/cache/${nextSeg.cacheKey}.mp3`) 
      : null;

    if (seg.audioStatus === 'READY') {
      // Audio đã có sẵn: Phát ngay lập tức
      this.transitionTo('SYNCING');
      this.ui.updateVisualizer(true);
      this.ui.updateSubtitles(this.config.subMode, seg.sourceText, seg.translatedText);
      
      this.player.play(activeUrl, preloadUrl);

    } else if (seg.audioStatus === 'PENDING' || seg.audioStatus === 'GENERATING') {
      // Audio chưa READY: Chuyển sang Polling trạng thái và gửi yêu cầu ON_DEMAND
      this.transitionTo('POLLING_AUDIO');
      this.ui.updateVisualizer(false);
      this.ui.updateSubtitles(this.config.subMode, seg.sourceText, `⏳ [Chuẩn bị giọng đọc...] ${seg.translatedText}`);

      // Smart Pause: Chủ động tạm dừng video để chờ sinh âm thanh, tránh trôi timeline
      if (this.video && !this.video.paused) {
        console.log(`[Smart Pause] Chờ sinh giọng đọc cho câu #${seg.index}. Tạm dừng video.`);
        this.isWaitingForAudio = true;
        this.video.pause();
      }

      this.requestUrgentAudio(seg.index);
      this.startPolling(seg);

    } else {
      // Trạng thái FAILED: Fallback về tiếng gốc
      this.handleFallbackMode(seg);
    }
  }

  /**
   * Gửi yêu cầu sinh audio gấp Priority 1 (ON_DEMAND)
   */
  private async requestUrgentAudio(index: number) {
    try {
      await fetch(`${BACKEND_URL}/api/sessions/${this.sessionId}/segments/${index}/request-audio`, {
        method: 'POST'
      });
    } catch (e) {
      console.warn('[Script] Không thể gửi yêu cầu sinh audio gấp:', e);
    }
  }

  /**
   * Polling trạng thái của segment chưa READY
   */
  private startPolling(seg: VideoSegment) {
    const startTime = Date.now();
    const TIMEOUT_MS = 3500; // Giới hạn chờ 3.5 giây

    this.pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/sessions/${this.sessionId}/segments/${seg.index}`);
        if (!res.ok) return;

        const data = await res.json();
        seg.audioStatus = data.audioStatus;
        seg.audioUrl = data.audioUrl;

        if (data.audioStatus === 'READY') {
          // Sinh xong thành công! Phát ngay lập tức
          this.clearPolling();
          
          // Đảm bảo timeline video chưa trôi qua khỏi segment này
          if (this.video && this.video.currentTime >= seg.start && this.video.currentTime <= seg.end) {
            this.transitionTo('SYNCING');
            this.ui.updateVisualizer(true);
            this.ui.updateSubtitles(this.config.subMode, seg.sourceText, seg.translatedText);
            
            const activeUrl = `${BACKEND_URL}${data.audioUrl}`;
            this.player.play(activeUrl, null);

            // Tiếp tục video nếu trước đó bị dừng chờ audio
            if (this.isWaitingForAudio) {
              console.log(`[Smart Pause] Giọng đọc sẵn sàng cho câu #${seg.index}. Tiếp tục phát video.`);
              this.isWaitingForAudio = false;
              this.video.play().catch(() => {});
            }
          }
        }
      } catch (e) {
        // Bỏ qua lỗi polling
      }
    }, 400);

    // Hẹn giờ Timeout sau 3.5 giây nếu không sinh kịp
    this.pollTimeout = setTimeout(() => {
      console.warn(`[Poll] Sinh audio bị chậm quá 3.5s cho câu #${seg.index}. Chuyển sang Fallback.`);
      this.clearPolling();
      this.handleFallbackMode(seg);

      // Trở lại phát video gốc nếu trước đó bị tạm dừng chờ
      if (this.isWaitingForAudio && this.video) {
        console.log(`[Smart Pause] Hết thời gian chờ câu #${seg.index}. Tiếp tục phát video gốc (Fallback).`);
        this.isWaitingForAudio = false;
        this.video.play().catch(() => {});
      }
    }, TIMEOUT_MS);
  }

  private clearPolling() {
    clearInterval(this.pollInterval);
    clearTimeout(this.pollTimeout);
    this.pollInterval = null;
    this.pollTimeout = null;
  }

  /**
   * Xử lý Fallback: Khôi phục âm lượng video gốc, chỉ hiển thị phụ đề dịch
   */
  private handleFallbackMode(seg: VideoSegment) {
    this.transitionTo('ORIGINAL_FALLBACK');
    this.player.restoreVideoVolume();
    this.ui.updateVisualizer(false);
    this.ui.updateSubtitles(this.config.subMode, seg.sourceText, `⚠️ [Fallback] ${seg.translatedText}`);
  }

  /**
   * Xử lý khi user Tua video (Seeked)
   */
  private onVideoSeek = () => {
    if (!this.isDubbingEnabled || this.segments.length === 0 || !this.video) return;

    console.log('[Script] User tua video (Seeked). Reset trạng thái phát.');
    this.clearPolling();
    this.player.stopAll();
    this.ui.updateVisualizer(false);
    
    this.activeSegmentIndex = -1;
    this.isSmartPausing = false;

    // Đọc ngay timeline mới
    this.onTimeUpdate();
  };

  /**
   * Xử lý khi video bị Pause
   */
  private onVideoPause = () => {
    if (!this.isDubbingEnabled) return;
    
    // Nếu đây là pause do Smart Pause hoặc do chờ sinh audio chủ động, không được dừng audio
    if (this.isSmartPausing || this.isWaitingForAudio) return;

    console.log('[Script] Video pause. Tạm dừng audio.');
    this.player.pause();
    this.ui.updateVisualizer(false);
  };

  /**
   * Xử lý khi video Resume (Play)
   */
  private onVideoPlay = () => {
    if (!this.isDubbingEnabled) return;
    console.log('[Script] Video play. Tiếp tục audio.');
    this.player.resume();
    if (this.state === 'SYNCING') {
      this.ui.updateVisualizer(true);
    }
  };

  /**
   * Xử lý khi đổi tốc độ phát
   */
  private onPlaybackRateChange = () => {
    if (!this.isDubbingEnabled || !this.video) return;
    const newRate = this.video.playbackRate;
    console.log(`[Script] Tốc độ phát thay đổi: ${newRate}x`);
    this.player.syncPlaybackRate(newRate);
  };

  private renderCurrentSubtitles() {
    if (this.activeSegmentIndex === -1 || this.segments.length === 0) {
      this.ui.updateSubtitles('off', null, null);
      return;
    }
    const seg = this.segments.find(s => s.index === this.activeSegmentIndex);
    if (seg) {
      let prefix = '';
      if (this.state === 'POLLING_AUDIO') prefix = '⏳ ';
      if (this.state === 'ORIGINAL_FALLBACK') prefix = '⚠️ ';
      this.ui.updateSubtitles(this.config.subMode, seg.sourceText, `${prefix}${seg.translatedText}`);
    }
  }
}

// Khởi chạy script ngay lập tức
const script = new LiveTubeContentScript();
script.start();
