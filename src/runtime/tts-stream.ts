import { spawn } from 'child_process';
import fs from 'fs';
import { Readable } from 'stream';

const DEFAULT_TIMEOUT_MS = 15_000;
const V1_VENV_CLI = '/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber/venv/bin/edge-tts';

export interface TTSStreamOptions {
  text: string;
  voice: string;
  rate: string;
  volume: string;
  timeoutMs?: number;
}

export class TTSStreamError extends Error {
  public readonly stderr: string;
  public readonly exitCode?: number;
  public readonly signal?: NodeJS.Signals;

  constructor(
    message: string,
    options: {
      stderr?: string;
      exitCode?: number;
      signal?: NodeJS.Signals;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = 'TTSStreamError';
    this.stderr = options.stderr || '';
    this.exitCode = options.exitCode;
    this.signal = options.signal;

    if (options.cause) {
      Object.defineProperty(this, 'cause', {
        value: options.cause,
        enumerable: false
      });
    }
  }
}

export function resolveEdgeTTSCliPath(): string {
  const configuredPath = process.env.EDGE_TTS_CLI;
  if (configuredPath && configuredPath.trim().length > 0) {
    return configuredPath;
  }

  if (fs.existsSync(V1_VENV_CLI)) {
    return V1_VENV_CLI;
  }

  return 'edge-tts';
}

function normalizeProsodyValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('+') || trimmed.startsWith('-')) {
    return trimmed;
  }

  return `+${trimmed}`;
}

export function createTTSStream(options: TTSStreamOptions): Readable {
  if (!options.text.trim()) {
    throw new TTSStreamError('Cannot create TTS stream for empty text.');
  }

  if (!options.voice.trim()) {
    throw new TTSStreamError('Cannot create TTS stream without a voice.');
  }

  const cliPath = resolveEdgeTTSCliPath();
  const args = [
    '--voice',
    options.voice,
    '--rate',
    normalizeProsodyValue(options.rate),
    '--volume',
    normalizeProsodyValue(options.volume),
    '--text',
    options.text,
    '--write-media',
    '-'
  ];

  const child = spawn(cliPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });

  if (!child.stdout) {
    throw new TTSStreamError('Edge-TTS stdout stream was not created.');
  }

  const stdout = child.stdout;
  const stderrChunks: Buffer[] = [];
  let timeout: NodeJS.Timeout | null = null;

  const readStderr = (): string => Buffer.concat(stderrChunks).toString('utf8').trim();

  const destroyStdout = (error: TTSStreamError): void => {
    if (!stdout.destroyed) {
      stdout.destroy(error);
    }
  };

  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  timeout = setTimeout(() => {
    child.kill('SIGTERM');
    destroyStdout(
      new TTSStreamError(`Edge-TTS timed out after ${options.timeoutMs || DEFAULT_TIMEOUT_MS}ms.`, {
        stderr: readStderr()
      })
    );
  }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

  child.once('error', (error) => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }

    destroyStdout(
      new TTSStreamError(`Failed to start Edge-TTS CLI: ${(error as Error).message}`, {
        stderr: readStderr(),
        cause: error
      })
    );
  });

  child.once('close', (code, signal) => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }

    if (code !== 0) {
      destroyStdout(
        new TTSStreamError(`Edge-TTS exited with code ${code ?? 'null'}.`, {
          stderr: readStderr(),
          exitCode: code ?? undefined,
          signal: signal ?? undefined
        })
      );
    }
  });

  return stdout;
}
