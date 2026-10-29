'use strict';
// FolkFriend features for score following: the engine built with
// `take_features` (folkfriend-src/rust/pkg-node-align), plus ffmpeg decoding
// of a time span of a recording.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { FolkFriendWASM } = require(path.resolve(__dirname, '../../../../folkfriend-src/rust/pkg-node-align/folkfriend.js'));

const WINDOW = 1024;
const RATE = 48000;

let ff = null, ptr = 0;
function engine() {
  if (!ff) {
    ff = new FolkFriendWASM();
    ff.set_sample_rate(RATE);
    ptr = ff.alloc_single_pcm_window();
  }
  return ff;
}

/** Frames × 48 pitch energies of a mono 48 kHz signal. */
function featuresOf(pcm) {
  const f = engine();
  f.flush_pcm_buffer();
  const n = Math.floor(pcm.length / WINDOW);
  for (let i = 0; i < n; i++) {
    f.get_allocated_pcm_window(ptr).set(pcm.subarray(i * WINDOW, (i + 1) * WINDOW));
    f.feed_single_pcm_window(ptr);
  }
  return f.take_features();
}

/** Mono 48 kHz PCM of [start, start + duration) seconds of a file. */
function decodeSpan(file, start, duration) {
  const tmp = path.join(os.tmpdir(), `score-follow-${process.pid}-${Date.now()}.raw`);
  try {
    const r = spawnSync(ffmpegPath, ['-ss', String(Math.max(0, start)), '-t', String(duration), '-i', file,
      '-f', 'f32le', '-ac', '1', '-ar', String(RATE), '-v', 'error', '-y', tmp]);
    if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr);
    const b = fs.readFileSync(tmp);
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { featuresOf, decodeSpan, RATE };
