import { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import { CLEAN_VIEW, classView } from '../../../transcriptor/src/folkfriendView.ts';
import type { ClassView } from '../../../transcriptor/src/decoder.ts';
import { FF_PCM_WINDOW } from '../sessionConfig';

// ── FolkFriend's cleaned energies, the note decoder's extra view ──────────────
// (2026-11-26) The one place that runs FolkFriend for transcriptor/'s class view
// (transcriptor/src/folkfriendView.ts: the settings, the folding): the
// recognition's windows (transcriptorEngine.ts) and the Transcription module
// (scoreFollowWorker.ts) both hear through it. The module must be initialised
// (folkfriendInit.ts) before one is made.

export class FolkFriendView {
  private readonly ff: FolkFriendWASM;
  private readonly ptr: number;

  /** `rate`: the samples' rate — the decoder's (transcriptor's RATE), as measured. */
  constructor(rate: number) {
    this.ff = new FolkFriendWASM();
    this.ff.set_sample_rate(rate);
    this.ff.enable_clean_features();
    this.ptr = this.ff.alloc_single_pcm_window();
  }

  /** The view of `pcm`: its whole frames fed, their cleaned energies folded to classes. */
  of(pcm: Float32Array): ClassView {
    for (let i = 0; i + FF_PCM_WINDOW <= pcm.length; i += FF_PCM_WINDOW) {
      // Re-acquired every time: memory growth stales the view.
      this.ff.get_allocated_pcm_window(this.ptr).set(pcm.subarray(i, i + FF_PCM_WINDOW));
      this.ff.feed_single_pcm_window(this.ptr);
    }
    return classView(this.ff.take_clean_features(CLEAN_VIEW.drone, false, CLEAN_VIEW.stride, 0));
  }

  free(): void {
    this.ff.free();
  }
}
