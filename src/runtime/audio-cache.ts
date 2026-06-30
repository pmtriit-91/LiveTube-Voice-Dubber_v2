import { Writable } from 'stream';

export type AudioCacheStatus = 'PENDING' | 'GENERATING' | 'READY' | 'FAILED';

export interface AudioCacheKeyParts {
  sessionId: string;
  segmentIndex: number;
  voice: string;
  rate: string;
  volume: string;
}

export interface AudioCacheEntry {
  key: string;
  sessionId: string;
  segmentIndex: number;
  status: AudioCacheStatus;
  chunks: Buffer[];
  buffer: Buffer | null;
  subscribers: Set<Writable>;
  byteLength: number;
  createdAt: number;
  lastAccessAt: number;
  error?: string;
}

export interface AudioCacheStats {
  entries: number;
  bytes: number;
  pending: number;
  generating: number;
  ready: number;
  failed: number;
  subscribers: number;
}

export interface AudioCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export function buildAudioCacheKey(parts: AudioCacheKeyParts): string {
  return [
    parts.sessionId,
    parts.segmentIndex,
    parts.voice,
    parts.rate,
    parts.volume
  ].join(':');
}

export class AudioCache {
  private readonly entries = new Map<string, AudioCacheEntry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: AudioCacheOptions = {}) {
    this.maxEntries = options.maxEntries || Number(process.env.AUDIO_CACHE_MAX_ENTRIES || 60);
    this.maxBytes = options.maxBytes || Number(process.env.AUDIO_CACHE_MAX_BYTES || 64 * 1024 * 1024);
  }

  public get(key: string): AudioCacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      entry.lastAccessAt = Date.now();
    }
    return entry;
  }

  public getOrCreate(parts: AudioCacheKeyParts): AudioCacheEntry {
    const key = buildAudioCacheKey(parts);
    const existing = this.get(key);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const entry: AudioCacheEntry = {
      key,
      sessionId: parts.sessionId,
      segmentIndex: parts.segmentIndex,
      status: 'PENDING',
      chunks: [],
      buffer: null,
      subscribers: new Set<Writable>(),
      byteLength: 0,
      createdAt: now,
      lastAccessAt: now
    };

    this.entries.set(key, entry);
    this.evictIfNeeded();
    return entry;
  }

  public markGenerating(key: string): void {
    const entry = this.requireEntry(key);
    entry.status = 'GENERATING';
    entry.chunks = [];
    entry.buffer = null;
    entry.byteLength = 0;
    entry.error = undefined;
    entry.lastAccessAt = Date.now();
  }

  public appendChunk(key: string, chunk: Buffer): void {
    const entry = this.requireEntry(key);
    entry.chunks.push(chunk);
    entry.byteLength += chunk.byteLength;
    entry.lastAccessAt = Date.now();

    for (const subscriber of Array.from(entry.subscribers)) {
      this.writeToSubscriber(entry, subscriber, chunk);
    }
  }

  public markReady(key: string): void {
    const entry = this.requireEntry(key);
    entry.status = 'READY';
    entry.buffer = Buffer.concat(entry.chunks, entry.byteLength);
    entry.lastAccessAt = Date.now();

    for (const subscriber of Array.from(entry.subscribers)) {
      this.endSubscriber(entry, subscriber);
    }

    this.evictIfNeeded();
  }

  public markFailed(key: string, error: Error | string): void {
    const entry = this.requireEntry(key);
    const message = typeof error === 'string' ? error : error.message;
    entry.status = 'FAILED';
    entry.error = message;
    entry.lastAccessAt = Date.now();

    for (const subscriber of Array.from(entry.subscribers)) {
      this.failSubscriber(entry, subscriber, new Error(message));
    }

    this.evictIfNeeded();
  }

  public subscribe(key: string, subscriber: Writable): () => void {
    const entry = this.requireEntry(key);
    entry.lastAccessAt = Date.now();

    for (const chunk of entry.chunks) {
      this.writeToSubscriber(entry, subscriber, chunk);
    }

    if (entry.status === 'READY') {
      subscriber.end();
      return () => undefined;
    }

    if (entry.status === 'FAILED') {
      subscriber.destroy(new Error(entry.error || 'Audio generation failed.'));
      return () => undefined;
    }

    entry.subscribers.add(subscriber);

    const unsubscribe = (): void => {
      entry.subscribers.delete(subscriber);
    };

    subscriber.once('close', unsubscribe);
    subscriber.once('error', unsubscribe);

    return unsubscribe;
  }

  public delete(key: string): boolean {
    return this.entries.delete(key);
  }

  public deleteSession(sessionId: string): number {
    let deleted = 0;

    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId && entry.subscribers.size === 0) {
        this.entries.delete(key);
        deleted++;
      }
    }

    return deleted;
  }

  public stats(): AudioCacheStats {
    const stats: AudioCacheStats = {
      entries: this.entries.size,
      bytes: 0,
      pending: 0,
      generating: 0,
      ready: 0,
      failed: 0,
      subscribers: 0
    };

    for (const entry of this.entries.values()) {
      stats.bytes += entry.byteLength;
      stats.subscribers += entry.subscribers.size;

      if (entry.status === 'PENDING') stats.pending++;
      if (entry.status === 'GENERATING') stats.generating++;
      if (entry.status === 'READY') stats.ready++;
      if (entry.status === 'FAILED') stats.failed++;
    }

    return stats;
  }

  private requireEntry(key: string): AudioCacheEntry {
    const entry = this.get(key);
    if (!entry) {
      throw new Error(`Audio cache entry not found: ${key}`);
    }
    return entry;
  }

  private writeToSubscriber(entry: AudioCacheEntry, subscriber: Writable, chunk: Buffer): void {
    if (subscriber.destroyed || subscriber.writableEnded) {
      entry.subscribers.delete(subscriber);
      return;
    }

    try {
      subscriber.write(chunk);
    } catch (error) {
      entry.subscribers.delete(subscriber);
      subscriber.destroy(error as Error);
    }
  }

  private endSubscriber(entry: AudioCacheEntry, subscriber: Writable): void {
    entry.subscribers.delete(subscriber);

    if (!subscriber.destroyed && !subscriber.writableEnded) {
      subscriber.end();
    }
  }

  private failSubscriber(entry: AudioCacheEntry, subscriber: Writable, error: Error): void {
    entry.subscribers.delete(subscriber);

    if (!subscriber.destroyed) {
      subscriber.destroy(error);
    }
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries || this.stats().bytes > this.maxBytes) {
      const candidate = Array.from(this.entries.values())
        .filter((entry) => entry.subscribers.size === 0 && entry.status !== 'GENERATING')
        .sort((a, b) => a.lastAccessAt - b.lastAccessAt)[0];

      if (!candidate) {
        break;
      }

      this.entries.delete(candidate.key);
    }
  }
}

export const audioCache = new AudioCache();
