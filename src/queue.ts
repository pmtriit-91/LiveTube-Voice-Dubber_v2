import { statements } from './db';
import { generateTTSWithCache, TTSConfig } from './utils/tts';
import { v4 as uuidv4 } from 'uuid';

const MAX_TOTAL_CONCURRENT_WORKERS = 3;
const MAX_SESSION_CONCURRENT_WORKERS = 1;

interface QueueJob {
  id: string;
  session_id: string;
  segment_index: number;
  priority: number; // 1: ON_DEMAND, 2: LOOK_AHEAD
  status: string;
  attempts: number;
  error_message: string | null;
  created_at: number;
}

class TTSQueueManager {
  private activeWorkers = 0;
  private sessionActiveCounts: Map<string, number> = new Map();
  private isProcessing = false;

  constructor() {
    // Tự động kiểm tra và khởi chạy hàng đợi định kỳ phòng trường hợp workers bị trôi
    setInterval(() => {
      this.triggerProcessing();
    }, 3000);
  }

  /**
   * Thêm một job sinh TTS mới vào hàng đợi
   */
  public addJob(sessionId: string, segmentIndex: number, priority: number): string {
    const jobId = uuidv4();
    const now = Date.now();
    
    // Xóa job cũ liên quan đến segment này của session (nếu có) để tránh sinh trùng lặp
    statements.deleteJob.run(sessionId, segmentIndex);
    
    // Sử dụng statement insert/update thông minh (nếu job cũ đã FAILED, reset lại)
    statements.insertJob.run(
      jobId,
      sessionId,
      segmentIndex,
      priority,
      'PENDING',
      0,
      null,
      now,
      now
    );

    console.log(`[Queue] Đã thêm Job: ${jobId} (Session: ${sessionId}, Segment: #${segmentIndex}, Priority: ${priority})`);
    
    // Kích hoạt xử lý ngay lập tức
    this.triggerProcessing();
    
    return jobId;
  }

  /**
   * Kích hoạt xử lý hàng đợi
   */
  public triggerProcessing() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.activeWorkers < MAX_TOTAL_CONCURRENT_WORKERS) {
        const nextJob = this.findNextEligibleJob();
        if (!nextJob) {
          break; // Không còn job nào đủ điều kiện xử lý
        }
        this.runJob(nextJob);
      }
    } catch (err) {
      console.error('[Queue ERROR] Lỗi trong loop xử lý hàng đợi:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Tìm kiếm job tiếp theo tuân thủ quy tắc Fair Scheduling (Round-Robin theo Session)
   */
  private findNextEligibleJob(): QueueJob | null {
    // Lấy toàn bộ jobs đang PENDING xếp theo priority và created_at
    const pendingJobs = statements.getPendingJobsByPriority.all() as QueueJob[];
    if (pendingJobs.length === 0) return null;

    // 1. Ưu tiên tuyệt đối các job khẩn cấp (Priority 1: ON_DEMAND)
    const onDemandJobs = pendingJobs.filter(j => j.priority === 1);
    if (onDemandJobs.length > 0) {
      // Áp dụng Fairness cho cả Priority 1 để tránh 1 tab spam seek làm nghẽn tab khác
      return this.selectFairJob(onDemandJobs);
    }

    // 2. Xử lý các job tải trước (Priority 2: LOOK_AHEAD)
    const lookAheadJobs = pendingJobs.filter(j => j.priority === 2);
    if (lookAheadJobs.length > 0) {
      return this.selectFairJob(lookAheadJobs);
    }

    return null;
  }

  /**
   * Chọn job thỏa mãn giới hạn concurrency của từng session (Fairness Allocation)
   */
  private selectFairJob(jobs: QueueJob[]): QueueJob | null {
    for (const job of jobs) {
      const activeCount = this.sessionActiveCounts.get(job.session_id) || 0;
      
      // Nếu session này chưa vượt quá giới hạn concurrency cho phép của 1 session
      if (activeCount < MAX_SESSION_CONCURRENT_WORKERS) {
        return job;
      }
    }
    
    // Nếu tất cả các session đều đang chạy hết công suất của chúng
    return null;
  }

  /**
   * Khởi chạy một job
   */
  private async runJob(job: QueueJob) {
    this.activeWorkers++;
    const currentSessionCount = this.sessionActiveCounts.get(job.session_id) || 0;
    this.sessionActiveCounts.set(job.session_id, currentSessionCount + 1);

    const now = Date.now();
    // Đánh dấu trạng thái RUNNING trong DB
    statements.updateJobStatus.run('RUNNING', null, now, job.id);
    statements.updateSegmentAudioStatus.run('GENERATING', null, null, now, job.session_id, job.segment_index);

    console.log(`[Worker] Khởi chạy Job: ${job.id} cho Session: ${job.session_id}, Segment: #${job.segment_index}`);

    try {
      // Lấy thông tin cấu hình session (voice, rate, volume) để sinh TTS
      const session = statements.getSession.get(job.session_id) as any;
      const segment = statements.getSegment.get(job.session_id, job.segment_index) as any;

      if (!session || !segment) {
        throw new Error('Không tìm thấy thông tin Session hoặc Segment trong DB');
      }

      const ttsConfig: TTSConfig = {
        voice: session.voice,
        rate: session.rate,
        volume: session.volume
      };

      const result = await generateTTSWithCache(
        session.video_id,
        segment.translated_text || segment.source_text, // Fallback dùng source_text nếu chưa dịch
        job.segment_index,
        ttsConfig
      );

      const updateTime = Date.now();
      if (result.success) {
        // Cập nhật segment thành READY
        statements.updateSegmentAudioStatus.run(
          'READY',
          result.cacheKey,
          result.audioPath,
          updateTime,
          job.session_id,
          job.segment_index
        );
        statements.updateJobStatus.run('COMPLETED', null, updateTime, job.id);
        console.log(`[Worker SUCCESS] Hoàn thành Job: ${job.id}. Audio READY.`);
      } else {
        // Xử lý lỗi sinh TTS
        this.handleJobFailure(job, 'Sinh TTS thất bại', updateTime);
      }
    } catch (error) {
      console.error(`[Worker ERROR] Lỗi khi chạy Job ${job.id}:`, error);
      this.handleJobFailure(job, (error as Error).message, Date.now());
    } finally {
      // Giải phóng tài nguyên worker
      this.activeWorkers--;
      const finalSessionCount = this.sessionActiveCounts.get(job.session_id) || 1;
      this.sessionActiveCounts.set(job.session_id, finalSessionCount - 1);

      // Kích hoạt loop tìm job tiếp theo
      this.triggerProcessing();
    }
  }

  /**
   * Xử lý khi job chạy lỗi (hỗ trợ retry 3 lần)
   */
  private handleJobFailure(job: QueueJob, message: string, timestamp: number) {
    const newAttempts = job.attempts + 1;
    if (newAttempts >= 3) {
      // Đánh dấu thất bại hoàn toàn sau 3 lần thử
      statements.updateJobStatus.run('FAILED', message, timestamp, job.id);
      statements.updateSegmentAudioStatus.run('FAILED', null, null, timestamp, job.session_id, job.segment_index);
      console.error(`[Worker FAILED] Job ${job.id} thất bại hoàn toàn sau 3 lần thử: ${message}`);
    } else {
      // Cho phép xếp hàng chạy lại
      statements.incrementJobAttempts.run(timestamp, job.id);
      statements.updateJobStatus.run('PENDING', message, timestamp, job.id);
      statements.updateSegmentAudioStatus.run('PENDING', null, null, timestamp, job.session_id, job.segment_index);
      console.warn(`[Worker RETRY] Job ${job.id} thất bại, xếp hàng để thử lại (Lần: ${newAttempts}). Lỗi: ${message}`);
    }
  }
}

// Khởi tạo Singleton Queue Manager
export const queueManager = new TTSQueueManager();
