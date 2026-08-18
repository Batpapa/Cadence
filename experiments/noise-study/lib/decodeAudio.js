'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');

const SAMPLE_RATE = 48000;

/** Decode any audio file to mono Float32 PCM at 48kHz via ffmpeg. Writes to a
 *  temp file rather than piping to stdout — long recordings (multi-hour, e.g.
 *  Tocane) decode to multiple GB of raw f32 PCM, well past what a spawnSync
 *  stdout pipe buffer can safely hold in memory at once. */
function decodeToFloat32Mono48k(audioPath) {
  const tmpFile = path.join(os.tmpdir(), `noise-study-pcm-${Date.now()}-${Math.random().toString(36).slice(2)}.raw`);
  try {
    const result = spawnSync(ffmpegPath, [
      '-i', audioPath,
      '-f', 'f32le',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-v', 'error',
      '-y', tmpFile,
    ]);

    if (result.status !== 0) {
      throw new Error(`ffmpeg failed (${result.status}): ${result.stderr?.toString()}`);
    }
    // fs.readFileSync refuses anything over 2 GiB (Node's Buffer allocation
    // cap) — a multi-hour session's raw f32 PCM blows past that (e.g. ~2.6GB
    // for a ~3.7h recording). Read in 64MB chunks via the lower-level
    // fs.readSync API instead, straight into a preallocated Float32Array's
    // backing bytes — no such cap applies there.
    const { size } = fs.statSync(tmpFile);
    const pcm = new Float32Array(size / 4);
    const bytes = new Uint8Array(pcm.buffer);
    const fd = fs.openSync(tmpFile, 'r');
    const CHUNK = 64 * 1024 * 1024;
    let offset = 0;
    try {
      while (offset < size) {
        const toRead = Math.min(CHUNK, size - offset);
        const bytesRead = fs.readSync(fd, bytes, offset, toRead, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
    } finally {
      fs.closeSync(fd);
    }
    return pcm;
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

module.exports = { decodeToFloat32Mono48k, SAMPLE_RATE };
