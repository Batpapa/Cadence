'use strict';
// FolkFriend features for score following: the engine built with
// `take_features` and the cleaned features (folkfriend-src/rust/pkg-node-align),
// plus ffmpeg decoding of a time span of a recording.
//
// Two kinds since 2026-11-07, as in the app: `featuresOf` (take_features —
// the Play-along's follower and the live tempo) and `alignFeaturesOf` (the
// cleaned ones scoreFollowWorker.ts aligns on: harmonic part, each note minus
// its 10-second median, the 3 strongest notes).
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

let ffClean = null, ptrClean = 0;
/** Frames × 48 cleaned pitch energies, as scoreFollowWorker.ts reads them
 *  (take_clean_features(10 s, centred, every second, 3 strongest)). */
function alignFeaturesOf(pcm) {
  if (!ffClean) {
    ffClean = new FolkFriendWASM();
    ffClean.set_sample_rate(RATE);
    ffClean.enable_clean_features();
    ptrClean = ffClean.alloc_single_pcm_window();
  }
  ffClean.flush_pcm_buffer();
  const n = Math.floor(pcm.length / WINDOW);
  for (let i = 0; i < n; i++) {
    ffClean.get_allocated_pcm_window(ptrClean).set(pcm.subarray(i * WINDOW, (i + 1) * WINDOW));
    ffClean.feed_single_pcm_window(ptrClean);
  }
  const fps = RATE / WINDOW;
  return ffClean.take_clean_features(Math.round(10 * fps), false, Math.round(fps), 3);
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

module.exports = { featuresOf, alignFeaturesOf, decodeSpan, RATE };
