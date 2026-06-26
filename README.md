# LiveTube Voice Dubber V2

A real-time Vietnamese voice dubbing system for YouTube videos, consisting of a Node.js Backend Service and a Chrome Extension. The system translates YouTube English subtitles and generates high-quality Vietnamese audio using Text-to-Speech (TTS) technology, synchronized directly with the video playback.

---

## 🌟 Key Features

*   **Real-time Subtitle Translation**: Automatically fetches English subtitles from YouTube, translates them into Vietnamese on-the-fly, and serves them to the player.
*   **Edge-TTS Voice Generation**: Leverages Microsoft Edge TTS for natural-sounding, high-quality Vietnamese voiceovers.
*   **Dual-Synchronized Playback**:
    *   **Double-Check Audio Lock**: Ensures the Vietnamese audio aligns perfectly with the current video timestamp, preventing sound overlaps and drift.
    *   **Dynamic Seek Buffer**: Intelligently handles video seeking (scrubbing), preparing audio segments around the new timestamp.
    *   **Smart Pause**: Automatically pauses video playback at sentence boundaries if the corresponding audio segment is still being generated, then resumes seamlessly when ready.
*   **Local Caching & Job Queueing**: Implements a SQLite-backed job queue to process TTS generation tasks efficiently and caches generated audio files to optimize network usage and avoid duplicate API calls.

---

## 🏗️ System Architecture

The project is structured into two main components:

### 1. Backend Service (`/src`)
A Node.js & TypeScript service powered by Express and SQLite.
*   **API Server**: Handles session creation, subtitle translation, and audio streaming.
*   **Job Queue Manager**: Manages concurrent TTS synthesis jobs using Python's `edge-tts` CLI.
*   **Database**: Uses `better-sqlite3` to track active sessions, segment states, and worker tasks.
*   **Cache Engine**: Manages physical audio assets (`.mp3` files) using a size-based Least Recently Used (LRU) cache policy.

### 2. Chrome Extension (`/extension`)
A lightweight content script built with TypeScript and bundled using `esbuild`.
*   **YouTube Player Controller**: Directs the native HTML5 player, adjusting volume dynamically to prioritize the Vietnamese voiceover.
*   **State Machine Manager**: Synchronizes audio playback with video events (`play`, `pause`, `seeking`, `ratechange`).
*   **Serial Polling Worker**: Continuously polls the backend for pending segments and fetches them as soon as they become `READY`.

---

## 🚀 Getting Started

### Prerequisites
*   [Bun](https://bun.sh/) (Recommended) or Node.js (v18+)
*   [Python 3](https://www.python.org/) with `edge-tts` package installed in a virtual environment (`venv`).
    *   The backend expects `edge-tts` to be accessible at: `/Users/phamminhtri/Desktop/train/LiveTube-Voice-Dubber/venv/bin/edge-tts` (or falls back to system CLI path).

---

### Installation & Run

#### 1. Start the Backend Server
Navigate to the root directory, install dependencies, and start the development server:

```bash
# Install dependencies
bun install

# Start the server
bun run dev
```
The server will start on [http://localhost:8765](http://localhost:8765).

#### 2. Install the Chrome Extension
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle switch in the top-right corner).
3. Click **Load unpacked** in the top-left corner.
4. Select the `/extension` directory inside this repository.
5. The extension will automatically activate when you open any YouTube video.

---

## 🛠️ Development & Build commands

### Backend
*   `bun run dev` - Runs the server using `ts-node` (hot reload).
*   `bun run build` - Compiles TypeScript files into the `dist/` directory.
*   `bun run clean` - Deletes temporary DB and build files.

### Extension
Navigate to `/extension` folder:
*   `bun run build` - Bundles the content script into `extension/dist/content.js`.
*   `bun run watch` - Starts esbuild in watch mode for development.

---

## 📝 License
This project is for educational and personal use. All rights reserved.
