export class DoubleBufferedAudioPlayer {
  // Pool chứa đúng 2 Audio Element cố định để chống rò rỉ bộ nhớ
  private audioA: HTMLAudioElement;
  private audioB: HTMLAudioElement;
  private useAudioA = true;

  private videoElement: HTMLVideoElement | null = null;
  private defaultDubVolume = 0.8;
  
  // Trạng thái Volume Ducking mượt mà
  private isDucked = false;
  private originalVideoVolume = 1.0;
  private fadeInterval: any = null;

  // Trạng thái đồng bộ an toàn (chỉ cho phép sync sau khi audio đã thực sự phát)
  private isAudioReadyForSync = false;

  constructor() {
    this.audioA = new Audio();
    this.audioA.preload = 'auto';
    this.audioB = new Audio();
    this.audioB.preload = 'auto';

    const setupListeners = (audio: HTMLAudioElement) => {
      audio.addEventListener('playing', () => {
        if (audio === this.getActiveAudio()) {
          this.isAudioReadyForSync = true;
          console.log('[Player] Active audio starts playing. Sync enabled.');
        }
      });

      audio.addEventListener('waiting', () => {
        if (audio === this.getActiveAudio()) {
          this.isAudioReadyForSync = false;
          console.log('[Player] Active audio is buffering. Sync temporarily paused.');
        }
      });
    };

    setupListeners(this.audioA);
    setupListeners(this.audioB);
  }

  public setVideoElement(video: HTMLVideoElement) {
    this.videoElement = video;
  }

  public setDubVolume(volume: number) {
    this.defaultDubVolume = volume;
    this.getActiveAudio().volume = volume;
    this.getPreloadAudio().volume = volume;
  }

  /**
   * Trả về Audio Element đang phát
   */
  public getActiveAudio(): HTMLAudioElement {
    return this.useAudioA ? this.audioA : this.audioB;
  }

  /**
   * Trả về Audio Element dùng để tải trước (Preload)
   */
  public getPreloadAudio(): HTMLAudioElement {
    return this.useAudioA ? this.audioB : this.audioA;
  }

  /**
   * Hoán đổi vai trò giữa 2 Audio Element (Double Buffering)
   */
  public swapBuffers() {
    this.useAudioA = !this.useAudioA;
  }

  /**
   * Bắt đầu phát câu thoại hiện tại và chuẩn bị tải câu thoại tiếp theo
   */
  public play(activeUrl: string, preloadUrl: string | null, segmentDuration?: number) {
    const active = this.getActiveAudio();
    const preload = this.getPreloadAudio();

    // Kiểm tra xem file activeUrl đã được preload sẵn ở buffer phụ hay chưa
    const isPreloaded = preload.src === activeUrl;

    if (isPreloaded) {
      console.log(`[Player] Cache hit on preload buffer! Swapping buffers for: ${activeUrl}`);
      // Hoán đổi vai trò của 2 buffer
      this.swapBuffers();
      
      const newActive = this.getActiveAudio();
      newActive.volume = this.defaultDubVolume;
      
      // Áp dụng tăng tốc độ phát động nếu bản dịch tiếng Việt dài hơn timeline segment
      this.applyDynamicRate(newActive, segmentDuration);

      this.isAudioReadyForSync = false; // Reset cờ đồng bộ cho câu thoại mới

      newActive.play()
        .then(() => {
          this.duckVideoVolume();
        })
        .catch((err) => {
          console.warn('[Player] Phát audio preload thất bại:', err);
        });

      // buffer phụ mới (newPreload) sẽ được dùng để preload câu tiếp theo
      const newPreload = this.getPreloadAudio();
      this.cleanupAudio(newPreload);
      if (preloadUrl) {
        newPreload.src = preloadUrl;
        newPreload.load();
        newPreload.volume = this.defaultDubVolume;
        if (this.videoElement) {
          newPreload.playbackRate = this.videoElement.playbackRate;
        }
      }
    } else {
      // Cache miss hoặc chưa tải trước kịp: Nạp trực tiếp vào buffer active hiện tại
      console.log(`[Player] Cache miss on preload buffer. Loading activeUrl directly: ${activeUrl}`);
      this.cleanupAudio(active);
      active.src = activeUrl;
      active.volume = this.defaultDubVolume;
      
      // Áp dụng tăng tốc độ phát động nếu bản dịch tiếng Việt dài hơn timeline segment
      this.applyDynamicRate(active, segmentDuration);

      this.isAudioReadyForSync = false; // Reset cờ đồng bộ cho câu thoại mới

      active.play()
        .then(() => {
          this.duckVideoVolume();
        })
        .catch((err) => {
          console.warn('[Player] Phát active audio trực tiếp thất bại:', err);
        });

      // Tải trước vào buffer phụ
      this.cleanupAudio(preload);
      if (preloadUrl) {
        preload.src = preloadUrl;
        preload.load();
        preload.volume = this.defaultDubVolume;
        if (this.videoElement) {
          preload.playbackRate = this.videoElement.playbackRate;
        }
      }
    }
  }

  /**
   * Tính toán và điều chỉnh tốc độ phát của audio lồng tiếng để khớp với timeline segment
   */
  private applyDynamicRate(audio: HTMLAudioElement, segmentDuration?: number) {
    if (!this.videoElement) return;
    const videoRate = this.videoElement.playbackRate;

    // Đặt tốc độ mặc định ban đầu là tốc độ video để tránh bị lệch ngay khi mới phát
    audio.playbackRate = videoRate;

    const computeRate = () => {
      if (segmentDuration && audio.duration && audio.duration > segmentDuration) {
        const requiredRate = (audio.duration / segmentDuration) * videoRate;
        const maxRate = videoRate * 1.35;
        const targetRate = Math.min(requiredRate, maxRate);
        
        if (Math.abs(audio.playbackRate - targetRate) > 0.01) {
          audio.playbackRate = targetRate;
          console.log(`[Player] Dynamic Speedup: Audio duration ${audio.duration.toFixed(2)}s > Segment duration ${segmentDuration.toFixed(2)}s. Speeding up to ${audio.playbackRate.toFixed(2)}x.`);
        }
      }
    };

    if (audio.duration) {
      computeRate();
    } else {
      audio.addEventListener('loadedmetadata', computeRate, { once: true });
    }
  }

  /**
   * Tạm dừng phát audio lồng tiếng
   */
  public pause() {
    this.getActiveAudio().pause();
    this.restoreVideoVolume();
  }

  /**
   * Tiếp tục phát audio lồng tiếng
   */
  public resume() {
    const active = this.getActiveAudio();
    if (active.src && !active.ended) {
      active.play()
        .then(() => {
          this.duckVideoVolume();
        })
        .catch(() => {});
    }
  }

  /**
   * Dừng toàn bộ các Audio Elements, giải phóng buffer mạng hoàn toàn
   */
  public stopAll() {
    this.cleanupAudio(this.audioA);
    this.cleanupAudio(this.audioB);
    this.restoreVideoVolume();
  }

  private cleanupAudio(audio: HTMLAudioElement) {
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load(); // Ép buộc trình duyệt giải phóng buffer tệp tin cũ
    } catch (e) {
      // Bỏ qua lỗi dọn dẹp
    }
  }

  /**
   * Giảm âm lượng video gốc xuống 30% (Voice-Over) với hiệu ứng fade mượt mà 300ms
   */
  private duckVideoVolume() {
    if (!this.videoElement || this.isDucked) return;
    this.isDucked = true;
    
    clearInterval(this.fadeInterval);
    this.originalVideoVolume = this.videoElement.volume;
    
    const targetVolume = this.originalVideoVolume * 0.3;
    const startVolume = this.videoElement.volume;
    const steps = 15;
    const stepDuration = 300 / steps;
    let currentStep = 0;

    this.fadeInterval = setInterval(() => {
      if (!this.videoElement) return;
      currentStep++;
      const val = startVolume - ((startVolume - targetVolume) * (currentStep / steps));
      this.videoElement.volume = Math.max(0, val);

      if (currentStep >= steps) {
        clearInterval(this.fadeInterval);
        this.videoElement.volume = targetVolume;
      }
    }, stepDuration);
  }

  /**
   * Khôi phục âm lượng video gốc về 100% với hiệu ứng fade mượt mà 500ms
   */
  public restoreVideoVolume() {
    if (!this.videoElement || !this.isDucked) return;
    this.isDucked = false;
    
    clearInterval(this.fadeInterval);
    
    const targetVolume = this.originalVideoVolume;
    const startVolume = this.videoElement.volume;
    const steps = 20;
    const stepDuration = 500 / steps;
    let currentStep = 0;

    this.fadeInterval = setInterval(() => {
      if (!this.videoElement) return;
      currentStep++;
      const val = startVolume + ((targetVolume - startVolume) * (currentStep / steps));
      this.videoElement.volume = Math.min(1.0, val);

      if (currentStep >= steps) {
        clearInterval(this.fadeInterval);
        this.videoElement.volume = targetVolume;
      }
    }, stepDuration);
  }

  /**
   * Đồng bộ tốc độ phát của audio theo video chính
   */
  public syncPlaybackRate(rate: number) {
    this.getActiveAudio().playbackRate = rate;
    this.getPreloadAudio().playbackRate = rate;
  }

  /**
   * Kiểm tra lệch pha (Drift check) và tinh chỉnh tinh vi (Micro-adjustments)
   * @param segmentStart Thời gian bắt đầu câu thoại trên timeline video
   */
  public checkDriftAndMicroAdjust(segmentStart: number) {
    const video = this.videoElement;
    const audio = this.getActiveAudio();
    
    if (!video || audio.paused || audio.ended || !audio.src) return;

    // Chặn đồng bộ nếu audio chưa sẵn sàng hoặc đang buffering/chưa thực sự phát tiếng
    if (!this.isAudioReadyForSync || audio.currentTime === 0) return;

    // Khoảng thời gian thực tế đã phát trên video kể từ mốc bắt đầu segment
    const videoProgress = video.currentTime - segmentStart;
    const audioProgress = audio.currentTime;

    const drift = videoProgress - audioProgress;

    // 1. Lệch pha nghiêm trọng (> 0.4s): Force-seek audio để bắt kịp video
    if (Math.abs(drift) > 0.4) {
      console.log(`[Sync] Lệch pha lớn detected (${drift.toFixed(2)}s). Đồng bộ cứng audio.`);
      try {
        this.isAudioReadyForSync = false; // Tạm dừng sync, chờ audio seek xong và kích hoạt lại event playing
        audio.currentTime = Math.max(0, videoProgress);
      } catch (e) {
        // Bỏ qua lỗi seek khi audio đang buffering
      }
      audio.playbackRate = video.playbackRate; // Reset playback rate
      return;
    }

    // 2. Lệch pha nhỏ (0.1s - 0.3s): Tinh chỉnh Micro-adjustments
    // Điều chỉnh tốc độ audio nhanh/chậm đi 5% để bắt kịp video êm ái không ngắt tiếng
    if (drift > 0.1) {
      // Audio đang chậm hơn video: tăng tốc audio lên
      audio.playbackRate = video.playbackRate * 1.05;
    } else if (drift < -0.1) {
      // Audio đang nhanh hơn video: giảm tốc audio đi
      audio.playbackRate = video.playbackRate * 0.95;
    } else {
      // Lệch pha trong ngưỡng cho phép: khôi phục tốc độ chuẩn
      audio.playbackRate = video.playbackRate;
    }
  }
}
