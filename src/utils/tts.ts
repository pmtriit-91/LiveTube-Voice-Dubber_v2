import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { promisify } from 'util';

const execPromise = promisify(exec);
const CACHE_DIR = path.join(process.cwd(), 'audio', 'cache');

// Đảm bảo thư mục cache tồn tại
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Đường dẫn mặc định tới edge-tts CLI trong virtualenv của V1
const V1_VENV_CLI = '/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber/venv/bin/edge-tts';

export interface TTSConfig {
  voice: string;
  rate: string;
  volume: string;
}

/**
 * Sinh cache key độc nhất cho từng câu thoại dịch
 */
export function generateCacheKey(
  videoId: string,
  text: string,
  config: TTSConfig
): string {
  const textHash = crypto.createHash('sha256').update(text.trim()).digest('hex');
  const rawKey = `${videoId}_${config.voice}_${config.rate}_${config.volume}_${textHash}`;
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Lấy đường dẫn file cache
 */
export function getCacheFilePath(cacheKey: string): string {
  return path.join(CACHE_DIR, `${cacheKey}.mp3`);
}

/**
 * Gọi CLI edge-tts sinh âm thanh thông qua subprocess
 */
export async function generateTTS(
  text: string,
  outputPath: string,
  config: TTSConfig
): Promise<boolean> {
  // 1. Lựa chọn file thực thi edge-tts CLI
  let cliPath = 'edge-tts'; // mặc định nếu đã cài globally
  if (fs.existsSync(V1_VENV_CLI)) {
    cliPath = V1_VENV_CLI;
  }

  // 2. Định dạng tham số prosody rate/volume cho Edge-TTS CLI
  // CLI yêu cầu format: --rate="+10%" hoặc --volume="-5%"
  const rateArg = config.rate.startsWith('+') || config.rate.startsWith('-') ? config.rate : `+${config.rate}`;
  const volumeArg = config.volume.startsWith('+') || config.volume.startsWith('-') ? config.volume : `+${config.volume}`;

  // 3. Xây dựng command line
  // Escape các ký tự đặc biệt trong text để tránh lỗi shell injection
  const escapedText = text.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  const command = `"${cliPath}" --voice "${config.voice}" --rate "${rateArg}" --volume "${volumeArg}" --text "${escapedText}" --write-media "${outputPath}"`;

  try {
    await execPromise(command);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return true;
    }
  } catch (error) {
    console.error('[TTS CLI ERROR] Lỗi khi chạy edge-tts CLI:', error);
  }
  return false;
}

/**
 * Hàm gọi sinh TTS có cơ chế kiểm tra cache (Idempotency) và retry 3 lần
 */
export async function generateTTSWithCache(
  videoId: string,
  text: string,
  sentenceIndex: number,
  config: TTSConfig,
  retries = 3
): Promise<{ success: boolean; cacheKey: string; audioPath: string }> {
  
  const cacheKey = generateCacheKey(videoId, text, config);
  const audioPath = getCacheFilePath(cacheKey);

  // 1. Kiểm tra tính trùng lặp (Idempotent check)
  if (fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0) {
    return { success: true, cacheKey, audioPath };
  }

  // 2. Sinh mới với cơ chế thử lại nếu lỗi
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Dọn dẹp tệp tin rác nếu có từ lần chạy lỗi trước
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }

      const success = await generateTTS(text, audioPath, config);
      if (success && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0) {
        return { success: true, cacheKey, audioPath };
      }
    } catch (err) {
      console.warn(`[TTS WARNING] Thử sinh câu #${sentenceIndex} lần ${attempt} thất bại. Lỗi: ${(err as Error).message}`);
    }

    // Chờ trước khi retry (Exponential backoff)
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }

  console.error(`[TTS ERROR] Sinh giọng nói thất bại hoàn toàn sau ${retries} lần thử cho câu #${sentenceIndex}.`);
  return { success: false, cacheKey, audioPath };
}
