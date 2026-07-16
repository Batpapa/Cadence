/* tslint:disable */
/* eslint-disable */
/**
*/
export class FolkFriendWASM {
  free(): void;
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
* @param {number} sample_rate
* @returns {boolean}
*/
  set_sample_rate(sample_rate: number): boolean;
/**
*/
  flush_pcm_buffer(): void;
/**
* @param {string} tune_id
* @returns {string}
*/
  aliases_from_tune_id(tune_id: string): string;
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
  readonly folkfriendwasm_feed_entire_pcm_signal: (a: number) => void;
  readonly folkfriendwasm_feed_single_pcm_window: (a: number, b: number) => void;
  readonly folkfriendwasm_flush_pcm_buffer: (a: number) => void;
  readonly folkfriendwasm_get_allocated_pcm_window: (a: number, b: number) => number;
  readonly folkfriendwasm_load_index_from_json_obj: (a: number, b: number) => void;
  readonly folkfriendwasm_new: () => number;
  readonly folkfriendwasm_run_name_query: (a: number, b: number, c: number, d: number) => void;
  readonly folkfriendwasm_run_transcription_query: (a: number, b: number, c: number, d: number) => void;
  readonly folkfriendwasm_set_sample_rate: (a: number, b: number) => number;
  readonly folkfriendwasm_settings_from_tune_id: (a: number, b: number, c: number, d: number) => void;
  readonly folkfriendwasm_transcribe_pcm_buffer: (a: number, b: number) => void;
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
