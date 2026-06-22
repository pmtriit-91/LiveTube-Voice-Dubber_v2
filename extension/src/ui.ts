export interface UIConfig {
  voice: string;
  volume: number;
  subMode: 'vi' | 'bilingual' | 'off';
}

export class GhostInterfaceManager {
  private shadowHost: HTMLDivElement | null = null;
  private shadow: ShadowRoot | null = null;
  private popover: HTMLDivElement | null = null;
  private subOverlay: HTMLDivElement | null = null;
  private controlBtn: HTMLButtonElement | null = null;

  private onToggleCallback: (enabled: boolean) => void = () => {};
  private onConfigChangeCallback: (config: UIConfig) => void = () => {};

  constructor() {}

  public init(
    onToggle: (enabled: boolean) => void,
    onConfigChange: (config: UIConfig) => void
  ) {
    this.onToggleCallback = onToggle;
    this.onConfigChangeCallback = onConfigChange;
  }

  /**
   * Tạo Shadow DOM giao diện ngầm (Ghost Interface) cô lập hoàn toàn
   */
  public injectUI(playerElement: HTMLElement, rightControls: HTMLElement) {
    if (this.shadowHost) return; // Đã khởi tạo

    console.log('[UI] Khởi tạo giao diện Ghost Interface (Shadow DOM)...');

    // Inject global styles cho nút bấm điều khiển ngoài Shadow DOM
    const styleId = 'livetube-global-button-styles';
    if (!document.getElementById(styleId)) {
      const globalStyle = document.createElement('style');
      globalStyle.id = styleId;
      globalStyle.textContent = `
        .livetube-dub-button {
          transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), color 0.2s ease !important;
          color: #eeeeee !important;
        }
        .livetube-dub-button:hover {
          transform: scale(1.15) !important;
          color: #6366f1 !important;
        }
        .livetube-dub-button.popover-open {
          color: #6366f1 !important;
        }
        .livetube-dub-button.dubbing-on {
          color: #10b981 !important;
          filter: drop-shadow(0 0 5px rgba(16, 185, 129, 0.7)) !important;
        }
        .livetube-dub-button.dubbing-on:hover {
          color: #34d399 !important;
        }
      `;
      document.head.appendChild(globalStyle);
    }

    this.shadowHost = document.createElement('div');
    this.shadowHost.id = 'livetube-dubber-shadow-host';
    
    // Sử dụng Open mode để Content Script truy cập được
    this.shadow = this.shadowHost.attachShadow({ mode: 'open' });

    // CSS Styling scoped trong Shadow DOM
    const style = document.createElement('style');
    style.textContent = `
      :host {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 1000;
      }

      /* Settings Popover Style */
      #livetube-popover {
        position: absolute;
        width: 280px;
        background: rgba(18, 18, 20, 0.9);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 14px;
        box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7);
        z-index: 99999;
        padding: 16px;
        font-family: system-ui, -apple-system, sans-serif;
        color: #f3f4f6;
        box-sizing: border-box;
        display: none;
        transition: opacity 0.2s ease, transform 0.2s ease;
        pointer-events: auto; /* Cho phép tương tác click */
      }
      
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 14px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      
      .title {
        font-size: 14px;
        font-weight: bold;
        color: #6366f1;
        letter-spacing: 0.5px;
      }

      .status-badge {
        font-size: 10px;
        font-weight: bold;
        padding: 2px 8px;
        border-radius: 20px;
        text-transform: uppercase;
      }
      
      .status-badge.offline {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
      }
      
      .status-badge.ready {
        background: rgba(99, 102, 241, 0.15);
        color: #818cf8;
      }

      .status-badge.active {
        background: rgba(16, 185, 129, 0.15);
        color: #34d399;
      }

      .row {
        display: flex;
        align-items: center;
        margin-bottom: 14px;
      }

      .label {
        font-size: 12px;
        font-weight: 600;
        margin-left: 10px;
        color: #e5e7eb;
      }

      /* Switch Styling */
      .switch {
        position: relative;
        display: inline-block;
        width: 38px;
        height: 20px;
      }

      .switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }

      .slider {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background-color: #3f3f46;
        transition: .2s;
        border-radius: 20px;
      }

      .slider:before {
        position: absolute;
        content: "";
        height: 14px;
        width: 14px;
        left: 3px;
        bottom: 3px;
        background-color: white;
        transition: .2s;
        border-radius: 50%;
      }

      input:checked + .slider {
        background-color: #10b981;
      }

      input:checked + .slider:before {
        transform: translateX(18px);
      }
      
      input:disabled + .slider {
        background-color: #27272a;
        cursor: not-allowed;
      }

      .group {
        display: flex;
        flex-direction: column;
        margin-bottom: 12px;
      }

      .group label {
        font-size: 11px;
        color: #9ca3af;
        margin-bottom: 6px;
        font-weight: 600;
      }

      .group select {
        background: #1e1e24;
        border: 1px solid #3f3f46;
        border-radius: 8px;
        color: #ffffff;
        padding: 6px 10px;
        font-size: 12px;
        outline: none;
        cursor: pointer;
      }

      /* Native-style Subtitle Overlay */
      #livetube-sub-overlay {
        position: absolute;
        bottom: 75px;
        left: 50%;
        transform: translateX(-50%);
        width: 85%;
        text-align: center;
        z-index: 2000;
        pointer-events: none;
        box-sizing: border-box;
      }

      .sub-en {
        font-family: 'Roboto', Arial, sans-serif;
        font-size: calc(14px + 0.5vw);
        color: #e5e7eb;
        text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 4px rgba(0,0,0,0.85);
        margin: 0 0 6px 0;
        font-weight: normal;
      }

      .sub-vi {
        font-family: 'Roboto', Arial, sans-serif;
        font-size: calc(16px + 0.7vw);
        color: #facc15;
        font-weight: bold;
        text-shadow: -1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0 2px 6px rgba(0,0,0,0.95);
        margin: 0;
      }

      /* Visualizer bar indicator */
      .visualizer {
        display: inline-flex;
        align-items: flex-end;
        gap: 2.5px;
        width: 16px;
        height: 12px;
        margin-left: 8px;
      }

      .bar {
        width: 2.5px;
        height: 3px;
        background-color: #10b981;
        border-radius: 1px;
      }

      @keyframes bounce {
        0%, 100% { height: 3px; }
        50% { height: 12px; }
      }

      .visualizer.active .bar:nth-child(1) { animation: bounce 0.6s infinite 0.1s; }
      .visualizer.active .bar:nth-child(2) { animation: bounce 0.6s infinite 0.3s; }
      .visualizer.active .bar:nth-child(3) { animation: bounce 0.6s infinite 0.2s; }

      /* Volume Range Styling */
      input[type=range] {
        -webkit-appearance: none;
        width: 100%;
        height: 6px;
        border-radius: 3px;
        background: #3f3f46;
        outline: none;
      }
      input[type=range]::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #6366f1;
        cursor: pointer;
        transition: background 0.15s;
      }
      input[type=range]::-webkit-slider-thumb:hover {
        background: #818cf8;
      }
    `;
    this.shadow.appendChild(style);

    // 2. Vẽ Popover Cấu hình
    this.popover = document.createElement('div');
    this.popover.id = 'livetube-popover';
    this.popover.innerHTML = `
      <div class="header">
        <span class="title">LiveTube Dubber V2</span>
        <span id="dubber-status" class="status-badge offline">Checking...</span>
      </div>
      <div class="row">
        <label class="switch">
          <input type="checkbox" id="dubber-toggle" disabled>
          <span class="slider"></span>
        </label>
        <span class="label">Bật Lồng Tiếng Việt</span>
        <div id="dubber-visualizer" class="visualizer">
          <div class="bar"></div>
          <div class="bar"></div>
          <div class="bar"></div>
        </div>
      </div>
      <div class="group">
        <label>Giọng đọc lồng tiếng:</label>
        <select id="dubber-voice">
          <option value="vi-VN-NamMinhNeural">Nam (Nam Minh - Recommended)</option>
          <option value="vi-VN-HoaiMyNeural">Nữ (Hoài Mỹ)</option>
        </select>
      </div>
      <div class="group">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
          <label style="margin: 0;">Âm lượng lồng tiếng:</label>
          <span id="dubber-volume-value" style="font-size: 11px; color: #10b981; font-weight: bold;">80%</span>
        </div>
        <input type="range" id="dubber-volume-slider" min="0" max="1" step="0.05" value="0.8">
      </div>
      <div class="group">
        <label>Chế độ phụ đề:</label>
        <select id="dubber-sub-mode">
          <option value="vi">Chỉ phụ đề Tiếng Việt</option>
          <option value="bilingual">Song ngữ (Anh + Việt)</option>
          <option value="off">Tắt hiển thị phụ đề dịch</option>
        </select>
      </div>
      <div style="margin-top: 14px; padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: space-between; align-items: center; font-size: 9px; color: #71717a;">
        <span>Mission: Tri thức cho người Việt</span>
        <span>Version 2.0</span>
      </div>
    `;
    this.shadow.appendChild(this.popover);

    // 3. Vẽ Subtitle Overlay
    this.subOverlay = document.createElement('div');
    this.subOverlay.id = 'livetube-sub-overlay';
    this.subOverlay.innerHTML = `
      <p id="livetube-sub-en" class="sub-en" style="display: none;"></p>
      <p id="livetube-sub-vi" class="sub-vi" style="display: none;"></p>
    `;
    this.shadow.appendChild(this.subOverlay);

    // 4. Inject shadow host vào player container để fullscreen chuẩn
    playerElement.appendChild(this.shadowHost);

    // 5. Tạo và chèn nút bấm điều khiển vào thanh công cụ của YouTube
    this.createControlButton(rightControls);

    // 6. Gắn sự kiện lắng nghe tương tác
    this.attachEventListeners();
  }

  private createControlButton(rightControls: HTMLElement) {
    if (rightControls.querySelector('.livetube-dub-button')) return;

    this.controlBtn = document.createElement('button');
    this.controlBtn.className = 'ytp-button livetube-dub-button';
    this.controlBtn.title = 'LiveTube Dubber V2';
    this.controlBtn.style.width = '46px';
    this.controlBtn.style.height = '100%';
    this.controlBtn.style.display = 'inline-flex';
    this.controlBtn.style.alignItems = 'center';
    this.controlBtn.style.justifyContent = 'center';
    this.controlBtn.style.background = 'none';
    this.controlBtn.style.border = 'none';
    this.controlBtn.style.cursor = 'pointer';
    this.controlBtn.style.padding = '0';
    this.controlBtn.style.verticalAlign = 'top';
    
    // Headphones SVG Icon (Sleek V2 design)
    this.controlBtn.innerHTML = `
      <svg viewBox="0 0 24 24" style="width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round;">
        <path d="M3 14c0-4.97 4.03-9 9-9s9 4.03 9 9"></path>
        <rect x="2" y="12" width="4" height="6" rx="1.5"></rect>
        <rect x="18" y="12" width="4" height="6" rx="1.5"></rect>
        <path d="M6 14v2"></path>
        <path d="M18 14v2"></path>
      </svg>
    `;

    this.controlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePopover();
    });

    const settingsBtn = rightControls.querySelector('.ytp-settings-button');
    if (settingsBtn) {
      settingsBtn.before(this.controlBtn);
    } else {
      rightControls.appendChild(this.controlBtn);
    }
  }

  private togglePopover() {
    if (!this.popover || !this.controlBtn) return;
    
    if (this.popover.style.display === 'block') {
      this.popover.style.display = 'none';
      this.controlBtn.classList.remove('popover-open');
    } else {
      // Xác định tọa độ hiển thị popover chuẩn
      const playerEl = document.querySelector('.html5-video-player');
      if (playerEl) {
        const playerRect = playerEl.getBoundingClientRect();
        const btnRect = this.controlBtn.getBoundingClientRect();
        
        const bottom = playerRect.bottom - btnRect.top + 8;
        const right = playerRect.right - btnRect.right;
        
        this.popover.style.bottom = `${bottom}px`;
        this.popover.style.right = `${right}px`;
      }
      this.popover.style.display = 'block';
      this.controlBtn.classList.add('popover-open');
    }
  }

  private attachEventListeners() {
    if (!this.shadow) return;

    const toggle = this.shadow.querySelector('#dubber-toggle') as HTMLInputElement;
    const voiceSelect = this.shadow.querySelector('#dubber-voice') as HTMLSelectElement;
    const volumeSlider = this.shadow.querySelector('#dubber-volume-slider') as HTMLInputElement;
    const subModeSelect = this.shadow.querySelector('#dubber-sub-mode') as HTMLSelectElement;

    // Toggle Enabled
    toggle.addEventListener('change', () => {
      this.onToggleCallback(toggle.checked);
    });

    // Config thay đổi
    const triggerConfigChange = () => {
      this.onConfigChangeCallback({
        voice: voiceSelect.value,
        volume: parseFloat(volumeSlider.value),
        subMode: subModeSelect.value as 'vi' | 'bilingual' | 'off'
      });
    };

    voiceSelect.addEventListener('change', triggerConfigChange);
    subModeSelect.addEventListener('change', triggerConfigChange);

    volumeSlider.addEventListener('input', () => {
      const volVal = this.shadow?.querySelector('#dubber-volume-value');
      if (volVal) {
        volVal.textContent = Math.round(parseFloat(volumeSlider.value) * 100) + '%';
      }
      triggerConfigChange();
    });

    // Bắt sự kiện click ra ngoài để tự động đóng popover
    document.addEventListener('click', (e) => {
      if (this.popover && this.popover.style.display === 'block') {
        const path = e.composedPath();
        if (!path.includes(this.popover) && this.controlBtn && !path.includes(this.controlBtn)) {
          this.popover.style.display = 'none';
          this.controlBtn.classList.remove('popover-open');
        }
      }
    });
  }

  /**
   * Cập nhật trạng thái kết nối server hiển thị trên badge
   */
  public updateStatusBadge(status: 'offline' | 'ready' | 'active', text: string) {
    if (!this.shadow) return;
    const badge = this.shadow.querySelector('#dubber-status');
    const toggle = this.shadow.querySelector('#dubber-toggle') as HTMLInputElement;

    if (badge) {
      badge.textContent = text;
      badge.className = `status-badge ${status}`;
    }

    if (toggle) {
      if (status === 'offline') {
        toggle.disabled = true;
        toggle.checked = false;
      } else if (status === 'ready') {
        toggle.disabled = false;
        toggle.checked = false;
      } else if (status === 'active') {
        toggle.disabled = false;
        toggle.checked = true;
      }
    }

    // Cập nhật trạng thái màu sắc cho nút Headphones ở YouTube control bar
    if (this.controlBtn) {
      if (status === 'active') {
        this.controlBtn.classList.add('dubbing-on');
      } else {
        this.controlBtn.classList.remove('dubbing-on');
      }
    }
  }

  /**
   * Cập nhật hoạt ảnh visualizer cột sóng nhạc
   */
  public updateVisualizer(active: boolean) {
    if (!this.shadow) return;
    const visualizer = this.shadow.querySelector('#dubber-visualizer');
    if (visualizer) {
      if (active) {
        visualizer.classList.add('active');
      } else {
        visualizer.classList.remove('active');
      }
    }
  }

  /**
   * Hiển thị phụ đề trên Overlay đồng bộ theo timeline
   */
  public updateSubtitles(
    subMode: 'vi' | 'bilingual' | 'off',
    enText: string | null,
    viText: string | null
  ) {
    if (!this.shadow) return;
    
    const enEl = this.shadow.querySelector('#livetube-sub-en') as HTMLParagraphElement;
    const viEl = this.shadow.querySelector('#livetube-sub-vi') as HTMLParagraphElement;

    if (!enEl || !viEl) return;

    if (subMode === 'off' || (!enText && !viText)) {
      enEl.style.display = 'none';
      viEl.style.display = 'none';
      return;
    }

    if (subMode === 'vi' && viText) {
      enEl.style.display = 'none';
      viEl.textContent = viText;
      viEl.style.display = 'block';
    } else if (subMode === 'bilingual') {
      if (enText) {
        enEl.textContent = enText;
        enEl.style.display = 'block';
      } else {
        enEl.style.display = 'none';
      }

      if (viText) {
        viEl.textContent = viText;
        viEl.style.display = 'block';
      } else {
        viEl.style.display = 'none';
      }
    }
  }

  public destroy() {
    if (this.shadowHost && this.shadowHost.parentNode) {
      this.shadowHost.parentNode.removeChild(this.shadowHost);
    }
    if (this.controlBtn && this.controlBtn.parentNode) {
      this.controlBtn.parentNode.removeChild(this.controlBtn);
    }
    this.shadowHost = null;
    this.shadow = null;
    this.popover = null;
    this.subOverlay = null;
    this.controlBtn = null;
  }
}
