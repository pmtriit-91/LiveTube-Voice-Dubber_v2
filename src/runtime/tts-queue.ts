import { EventEmitter } from 'events';
import { Readable } from 'stream';
import {
  AudioCache,
  AudioCacheKeyParts,
  audioCache,
  buildAudioCacheKey
} from './audio-cache';
import { createTTSStream } from './tts-stream';

export type QueueJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'SKIPPED';

export interface QueueJobInput extends AudioCacheKeyParts {
  text: string;
  priority: number;
  timeoutMs?: number;
}

export interface QueueJob extends QueueJobInput {
  id: string;
  cacheKey: string;
  status: QueueJobStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface TTSQueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  activeWorkers: number;
  maxConcurrent: number;
  baseMaxConcurrent: number;
  currentMaxConcurrent: number;
  maxSessionConcurrent: number;
  isThrottled: boolean;
  recentFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

export interface TTSQueueOptions {
  cache?: AudioCache;
  maxConcurrent?: number;
  maxSessionConcurrent?: number;
}

export class TTSQueueV3 extends EventEmitter {
  private readonly cache: AudioCache;
  private readonly baseMaxConcurrent: number;
  private readonly maxSessionConcurrent: number;
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly recoveryDelayMs: number;
  private readonly jobs: QueueJob[] = [];
  private readonly sessionActiveCounts = new Map<string, number>();
  private activeWorkers = 0;
  private completedJobs = 0;
  private failedJobs = 0;
  private cancelledJobs = 0;
  private isProcessing = false;
  private currentMaxConcurrent: number;
  private isThrottled = false;
  private failureTimestamps: number[] = [];
  private lastFailureAt = 0;
  private lastSuccessAt = 0;
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(options: TTSQueueOptions = {}) {
    super();
    this.cache = options.cache || audioCache;
    this.baseMaxConcurrent = readPositiveInteger(options.maxConcurrent, readPositiveInteger(process.env.TTS_MAX_CONCURRENT, 3));
    this.currentMaxConcurrent = this.baseMaxConcurrent;
    this.maxSessionConcurrent = readPositiveInteger(
      options.maxSessionConcurrent,
      readPositiveInteger(process.env.TTS_MAX_SESSION_CONCURRENT, 3)
    );
    this.failureThreshold = readPositiveInteger(process.env.TTS_THROTTLE_FAILURE_THRESHOLD, 3);
    this.failureWindowMs = readPositiveInteger(process.env.TTS_THROTTLE_FAILURE_WINDOW_MS, 30_000);
    this.recoveryDelayMs = readPositiveInteger(process.env.TTS_THROTTLE_RECOVERY_MS, 120_000);

    this.on('job:added', () => this.triggerProcessing());
    this.on('job:finished', () => this.triggerProcessing());
  }

  public enqueue(input: QueueJobInput): QueueJob {
    const cacheKey = buildAudioCacheKey(input);
    const cacheEntry = this.cache.getOrCreate(input);

    if (cacheEntry.status === 'READY' || cacheEntry.status === 'GENERATING') {
      return this.createSkippedJob(input, cacheKey, cacheEntry.status);
    }

    const existingJob = this.jobs.find((job) => job.cacheKey === cacheKey && job.status === 'PENDING');
    if (existingJob) {
      existingJob.priority = Math.min(existingJob.priority, input.priority);
      existingJob.text = input.text;
      existingJob.timeoutMs = input.timeoutMs;
      existingJob.updatedAt = Date.now();
      this.sortJobs();
      this.emit('job:added', existingJob);
      return existingJob;
    }

    const now = Date.now();
    const job: QueueJob = {
      ...input,
      id: this.createJobId(input.sessionId, input.segmentIndex),
      cacheKey,
      status: 'PENDING',
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };

    this.jobs.push(job);
    this.sortJobs();
    this.emit('job:added', job);
    return job;
  }

  public cancelOutsideWindow(sessionId: string, anchorIndex: number, windowSize: number): number {
    const minIndex = Math.max(1, anchorIndex - 1);
    const maxIndex = anchorIndex + windowSize;
    let cancelled = 0;

    for (const job of this.jobs) {
      const outsideWindow = job.segmentIndex < minIndex || job.segmentIndex > maxIndex;
      if (job.sessionId === sessionId && job.status === 'PENDING' && outsideWindow) {
        job.status = 'CANCELLED';
        job.updatedAt = Date.now();
        cancelled++;
      }
    }

    if (cancelled > 0) {
      this.cancelledJobs += cancelled;
      this.pruneFinishedJobs();
      this.emit('job:cancelled', { sessionId, anchorIndex, windowSize, cancelled });
    }

    return cancelled;
  }

  public triggerProcessing(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.activeWorkers < this.currentMaxConcurrent) {
        const nextJob = this.takeNextEligibleJob();
        if (!nextJob) {
          break;
        }

        this.runJob(nextJob);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  public stats(): TTSQueueStats {
    let pending = 0;
    let running = 0;

    for (const job of this.jobs) {
      if (job.status === 'PENDING') pending++;
      if (job.status === 'RUNNING') running++;
    }

    return {
      pending,
      running,
      completed: this.completedJobs,
      failed: this.failedJobs,
      cancelled: this.cancelledJobs,
      activeWorkers: this.activeWorkers,
      maxConcurrent: this.currentMaxConcurrent,
      baseMaxConcurrent: this.baseMaxConcurrent,
      currentMaxConcurrent: this.currentMaxConcurrent,
      maxSessionConcurrent: this.maxSessionConcurrent,
      isThrottled: this.isThrottled,
      recentFailures: this.getRecentFailureCount(Date.now()),
      lastFailureAt: this.lastFailureAt > 0 ? this.lastFailureAt : null,
      lastSuccessAt: this.lastSuccessAt > 0 ? this.lastSuccessAt : null
    };
  }

  private takeNextEligibleJob(): QueueJob | null {
    this.sortJobs();

    const index = this.jobs.findIndex((job) => {
      if (job.status !== 'PENDING') {
        return false;
      }

      const sessionActiveCount = this.sessionActiveCounts.get(job.sessionId) || 0;
      return sessionActiveCount < this.maxSessionConcurrent;
    });

    if (index === -1) {
      return null;
    }

    const job = this.jobs[index];
    job.status = 'RUNNING';
    job.attempts += 1;
    job.updatedAt = Date.now();
    return job;
  }

  private runJob(job: QueueJob): void {
    this.activeWorkers++;
    this.sessionActiveCounts.set(job.sessionId, (this.sessionActiveCounts.get(job.sessionId) || 0) + 1);
    this.cache.markGenerating(job.cacheKey);
    this.emit('job:started', job);

    let stream: Readable;
    try {
      stream = createTTSStream({
        text: job.text,
        voice: job.voice,
        rate: job.rate,
        volume: job.volume,
        timeoutMs: job.timeoutMs
      });
    } catch (error) {
      this.handleJobFailure(job, error as Error);
      return;
    }

    let finished = false;
    let receivedBytes = 0;

    const finishOnce = (finish: () => void): void => {
      if (finished) {
        return;
      }

      finished = true;
      finish();
    };

    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      this.cache.appendChunk(job.cacheKey, buffer);
    });

    stream.once('end', () => {
      finishOnce(() => {
        if (receivedBytes === 0) {
          this.handleJobFailure(job, new Error('Edge-TTS completed without emitting audio bytes.'));
          return;
        }

        job.status = 'COMPLETED';
        job.updatedAt = Date.now();
        this.completedJobs++;
        this.recordJobSuccess(job);
        this.cache.markReady(job.cacheKey);
        this.releaseWorker(job);
        this.emit('job:completed', job);
        this.emit('job:finished', job);
        this.pruneFinishedJobs();
      });
    });

    stream.once('error', (error) => {
      finishOnce(() => {
        this.handleJobFailure(job, error as Error);
      });
    });
  }

  private handleJobFailure(job: QueueJob, error: Error): void {
    job.status = 'FAILED';
    job.error = error.message;
    job.updatedAt = Date.now();
    this.failedJobs++;
    this.recordJobFailure(job, error);
    this.cache.markFailed(job.cacheKey, error);
    this.releaseWorker(job);
    this.emit('job:failed', job);
    this.emit('job:finished', job);
    this.pruneFinishedJobs();
  }

  private releaseWorker(job: QueueJob): void {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);

    const currentCount = this.sessionActiveCounts.get(job.sessionId) || 0;
    if (currentCount <= 1) {
      this.sessionActiveCounts.delete(job.sessionId);
    } else {
      this.sessionActiveCounts.set(job.sessionId, currentCount - 1);
    }
  }

  private sortJobs(): void {
    this.jobs.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }

      return a.createdAt - b.createdAt;
    });
  }

  private pruneFinishedJobs(): void {
    for (let index = this.jobs.length - 1; index >= 0; index--) {
      if (
        this.jobs[index].status === 'CANCELLED' ||
        this.jobs[index].status === 'COMPLETED' ||
        this.jobs[index].status === 'FAILED'
      ) {
        this.jobs.splice(index, 1);
      }
    }
  }

  private recordJobSuccess(job: QueueJob): void {
    const now = Date.now();
    this.lastSuccessAt = now;
    this.failureTimestamps = [];

    this.logQueueEvent('job.completed', {
      sessionId: job.sessionId,
      segmentIndex: job.segmentIndex,
      rate: job.rate,
      bytesStatus: 'ready'
    });

    if (this.isThrottled) {
      this.scheduleRecovery();
    }
  }

  private recordJobFailure(job: QueueJob, error: Error): void {
    const now = Date.now();
    this.lastFailureAt = now;
    this.failureTimestamps.push(now);
    this.pruneFailureWindow(now);
    this.clearRecoveryTimer();

    this.logQueueEvent('job.failed', {
      sessionId: job.sessionId,
      segmentIndex: job.segmentIndex,
      rate: job.rate,
      recentFailures: this.failureTimestamps.length,
      error: error.message
    });

    if (this.failureTimestamps.length >= this.failureThreshold) {
      this.activateThrottle();
    }
  }

  private activateThrottle(): void {
    if (this.isThrottled && this.currentMaxConcurrent === 1) {
      return;
    }

    this.isThrottled = true;
    this.currentMaxConcurrent = 1;

    this.logQueueEvent('throttle.enabled', {
      recentFailures: this.failureTimestamps.length,
      failureWindowMs: this.failureWindowMs,
      baseMaxConcurrent: this.baseMaxConcurrent,
      currentMaxConcurrent: this.currentMaxConcurrent
    });
  }

  private scheduleRecovery(): void {
    this.clearRecoveryTimer();

    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;

      const now = Date.now();
      const noRecentFailures = now - this.lastFailureAt >= this.recoveryDelayMs;
      if (!this.isThrottled || !noRecentFailures || this.lastSuccessAt === 0) {
        return;
      }

      this.isThrottled = false;
      this.currentMaxConcurrent = this.baseMaxConcurrent;
      this.failureTimestamps = [];

      this.logQueueEvent('throttle.recovered', {
        recoveryDelayMs: this.recoveryDelayMs,
        currentMaxConcurrent: this.currentMaxConcurrent
      });

      this.triggerProcessing();
    }, this.recoveryDelayMs);
    this.recoveryTimer.unref?.();
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer === null) {
      return;
    }

    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private getRecentFailureCount(now: number): number {
    this.pruneFailureWindow(now);
    return this.failureTimestamps.length;
  }

  private pruneFailureWindow(now: number): void {
    const threshold = now - this.failureWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter((timestamp) => timestamp >= threshold);
  }

  private logQueueEvent(event: string, payload: Record<string, unknown>): void {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      component: 'tts-queue',
      event,
      ...payload
    }));
  }

  private createSkippedJob(input: QueueJobInput, cacheKey: string, reason: 'READY' | 'GENERATING'): QueueJob {
    const now = Date.now();
    return {
      ...input,
      id: this.createJobId(input.sessionId, input.segmentIndex),
      cacheKey,
      status: 'SKIPPED',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      error: `Audio cache already ${reason}.`
    };
  }

  private createJobId(sessionId: string, segmentIndex: number): string {
    return `${sessionId}:${segmentIndex}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  }
}

export const ttsQueue = new TTSQueueV3();

function readPositiveInteger(value: number | string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
