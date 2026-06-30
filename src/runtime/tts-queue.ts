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
  maxSessionConcurrent: number;
}

export interface TTSQueueOptions {
  cache?: AudioCache;
  maxConcurrent?: number;
  maxSessionConcurrent?: number;
}

export class TTSQueueV3 extends EventEmitter {
  private readonly cache: AudioCache;
  private readonly maxConcurrent: number;
  private readonly maxSessionConcurrent: number;
  private readonly jobs: QueueJob[] = [];
  private readonly sessionActiveCounts = new Map<string, number>();
  private activeWorkers = 0;
  private completedJobs = 0;
  private failedJobs = 0;
  private cancelledJobs = 0;
  private isProcessing = false;

  constructor(options: TTSQueueOptions = {}) {
    super();
    this.cache = options.cache || audioCache;
    this.maxConcurrent = options.maxConcurrent || Number(process.env.TTS_MAX_CONCURRENT || 3);
    this.maxSessionConcurrent = options.maxSessionConcurrent || Number(process.env.TTS_MAX_SESSION_CONCURRENT || 3);

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
      while (this.activeWorkers < this.maxConcurrent) {
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
      maxConcurrent: this.maxConcurrent,
      maxSessionConcurrent: this.maxSessionConcurrent
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
