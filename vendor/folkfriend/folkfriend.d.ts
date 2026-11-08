/* tslint:disable */
/* eslint-disable */
/**
*/
export class FolkFriendWASM {
  free(): void;
/**
* Pitch-class mode: recognise a tune whatever the key and the tuning it is played in (on),
* or at the index's own pitch (off, the default). See FolkFriend::set_any_pitch.
* @param {boolean} on
*/
  set_any_pitch(on: boolean): void;
/**
* @returns {Float32Array}
*/
  take_features(): Float32Array;
/**
* @param {string} contour_string
* @returns {string}
*/
  contour_to_abc(contour_string: string): string;
/**
* @param {string} query
* @returns {string}
*/
  run_name_query(query: string): string;
/**
* Settings re-aligned by Needleman-Wunsch after the n-gram pass.
* Default ff_config::QUERY_REPASS_SIZE (2000).
* @param {number} num_repass
*/
  set_num_repass(num_repass: number): void;
/**
* Notes weaker than `min_power` or shorter than `min_duration_frames`
* frames are dropped before quantisation. Default 0.10 / 3.
* @param {number} min_power
* @param {number} min_duration_frames
*/
  set_note_filter(min_power: number, min_duration_frames: number): void;
/**
* @param {number} sample_rate
* @returns {boolean}
*/
  set_sample_rate(sample_rate: number): boolean;
/**
* Tempo selection model: per-note score `intercept - slope * quavers`.
* Default 3.0 / 0.5.
* @param {number} intercept
* @param {number} slope
*/
  set_tempo_model(intercept: number, slope: number): void;
/**
* Tempo search range, crotchets per minute, upper bound exclusive, step 5.
* Default 60 / 240.
* @param {number} low_bpm
* @param {number} high_bpm
*/
  set_tempo_range(low_bpm: number, high_bpm: number): void;
/**
*/
  flush_pcm_buffer(): void;
/**
* The cleaned frames fed since the last call (frames x 48, as take_features): each note
* minus its median over `drone_frames` frames (centred, or the frames up to it when
* `causal`; 0 = nothing removed), the median taken every `stride` frames, then the
* `top_k` strongest notes of each frame kept (0 = all). Flushes.
* @param {number} drone_frames
* @param {boolean} causal
* @param {number} stride
* @param {number} top_k
* @returns {Float32Array}
*/
  take_clean_features(drone_frames: number, causal: boolean, stride: number, top_k: number): Float32Array;
/**
* @param {string} tune_id
* @returns {string}
*/
  aliases_from_tune_id(tune_id: string): string;
/**
* Queries shorter than this many contour symbols return no candidates.
* Default 0.
* @param {number} min_query_length
*/
  set_min_query_length(min_query_length: number): void;
/**
* Pitch-class recognition (Cadence, 2026-11-07), one-way: see
* FolkFriend::set_pitch_class_mode. Contours this instance returns are then
* pitch classes ('a' = C ... 'l' = B) and its index is folded to match.
*/
  set_pitch_class_mode(): void;
/**
* Score following (Cadence, 2026-11-07, feature/clean.rs): from now on this instance
* streams the frames it is fed into cleaned 48-note energies — the harmonic part, as the
* pitch-class engine reads it — instead of take_features'. Measured on Cadence's
* annotated sessions (experiments/score-follow): with take_clean_features(10 s of
* frames, false, 1 s, 3), 17 tunes followed over less than 80 % of their span instead of
* 20, the ends nearer the annotations, the passes more regular, and a wrong score
* claiming 12 % of a span at the 90th percentile instead of 89 % — in a long recording,
* half as many tunes found that were never played.
*/
  enable_clean_features(): void;
/**
* @param {string} tune_id
* @returns {string}
*/
  settings_from_tune_id(tune_id: string): string;
/**
* @returns {string}
*/
  transcribe_pcm_buffer(): string;
/**
*/
  feed_entire_pcm_signal(): void;
/**
* @param {number} ptr
*/
  feed_single_pcm_window(ptr: number): void;
/**
* @returns {number}
*/
  alloc_single_pcm_window(): number;
/**
* @param {string} contour_string
* @returns {string}
*/
  run_transcription_query(contour_string: string): string;
/**
* @param {number} ptr
* @returns {Float32Array}
*/
  get_allocated_pcm_window(ptr: number): Float32Array;
/**
* @param {any} js_value
*/
  load_index_from_json_obj(js_value: any): void;
/**
* @returns {string}
*/
  transcribe_pcm_buffer_debug(): string;
/**
* @param {string} contour_string
* @returns {string}
*/
  run_transcription_query_debug(contour_string: string): string;
/**
*/
  constructor();
/**
* @returns {string}
*/
  version(): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_folkfriendwasm_free: (a: number) => void;
  readonly folkfriendwasm_aliases_from_tune_id: (a: number, b: number, c: number, d: number) => void;
  readonly folkfriendwasm_alloc_single_pcm_window: (a: number) => number;
  readonly folkfriendwasm_contour_to_abc: (a: number, b: number, c: number, d: number) => void;
  readonly folkfriendwasm_enable_clean_features: (a: number) => void;
  readonly folkfriendwasm_feed_entire_pcm_signal: (a: number) => void;
  readonly folkfriendwasm_feed_single_pcm_window: (a: number, b: number) => void;
  readonly folkfriendwasm_flush_pcm_buffer: (a: number) => void;
  readonly folkfriendwasm_get_allocated_pcm_window: (a: number, b: number) => number;
  readonly folkfriendwasm_load_index_from_json_obj: (a: number, b: number) => void;
  readonly folkfriendwasm_new: () => number;
  readonly folkfriendwasm_run_name_query: (a: number, b: number, c: number, d: number) => void;
  readonly folkfriendwasm_run_transcription_query: (a: number, b: number, c: number, d: number) => void;
  readonly folkfriendwasm_run_transcription_query_debug: (a: number, b: number, c: number, d: number) => void;
  readonly folkfriendwasm_set_any_pitch: (a: number, b: number) => void;
  readonly folkfriendwasm_set_min_query_length: (a: number, b: number) => void;
  readonly folkfriendwasm_set_note_filter: (a: number, b: number, c: number) => void;
  readonly folkfriendwasm_set_num_repass: (a: number, b: number) => void;
  readonly folkfriendwasm_set_pitch_class_mode: (a: number) => void;
  readonly folkfriendwasm_set_sample_rate: (a: number, b: number) => number;
  readonly folkfriendwasm_set_tempo_model: (a: number, b: number, c: number) => void;
  readonly folkfriendwasm_set_tempo_range: (a: number, b: number, c: number) => void;
  readonly folkfriendwasm_settings_from_tune_id: (a: number, b: number, c: number, d: number) => void;
  readonly folkfriendwasm_take_clean_features: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly folkfriendwasm_take_features: (a: number) => number;
  readonly folkfriendwasm_transcribe_pcm_buffer: (a: number, b: number) => void;
  readonly folkfriendwasm_transcribe_pcm_buffer_debug: (a: number, b: number) => void;
  readonly folkfriendwasm_version: (a: number, b: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_exn_store: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {SyncInitInput} module
*
* @returns {InitOutput}
*/
export function initSync(module: SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {InitInput | Promise<InitInput>} module_or_path
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: InitInput | Promise<InitInput>): Promise<InitOutput>;
