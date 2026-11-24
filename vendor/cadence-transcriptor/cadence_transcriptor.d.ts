/* tslint:disable */
/* eslint-disable */
/**
* The whole recording at once (the benches): an Analyzer fed it in one chunk.
* @param {Float32Array} pcm
* @param {number} rate
* @param {number} size
* @param {number} hop
* @param {number} floor_db
* @param {number} fmin
* @param {number} fmax
* @param {number} hpss_time
* @param {number} hpss_freq
* @param {boolean} acf
* @param {number} acf_every
* @param {boolean} want_peaks
* @param {number} flux_lag
* @param {number} max_peaks
* @returns {Spectrum}
*/
export function analyse(pcm: Float32Array, rate: number, size: number, hop: number, floor_db: number, fmin: number, fmax: number, hpss_time: number, hpss_freq: number, acf: boolean, acf_every: number, want_peaks: boolean, flux_lag: number, max_peaks: number): Spectrum;
/**
* The analysis fed a chunk at a time: a frame is analysed as soon as its samples are in, its
* peaks once the frames its harmonic mask reads are.
*/
export class Analyzer {
  free(): void;
/**
* @param {number} rate
* @param {number} size
* @param {number} hop
* @param {number} floor_db
* @param {number} fmin
* @param {number} fmax
* @param {number} hpss_time
* @param {number} hpss_freq
* @param {boolean} acf
* @param {number} acf_every
* @param {boolean} want_peaks
* @param {number} flux_lag
* @param {number} max_peaks
*/
  constructor(rate: number, size: number, hop: number, floor_db: number, fmin: number, fmax: number, hpss_time: number, hpss_freq: number, acf: boolean, acf_every: number, want_peaks: boolean, flux_lag: number, max_peaks: number);
/**
* More samples.
* @param {Float32Array} chunk
*/
  push(chunk: Float32Array): void;
/**
* The analysis of everything pushed.
* @returns {Spectrum}
*/
  finish(): Spectrum;
}
/**
* One analysis: per frame, energy and onset value; the autocorrelation (frames x 61) and
* the peaks (frame t's from start[t] to start[t + 1]) when asked for.
*/
export class Spectrum {
  free(): void;
/**
* @returns {Float32Array}
*/
  acf(): Float32Array;
/**
* @returns {Float32Array}
*/
  mag(): Float32Array;
/**
* @returns {Float32Array}
*/
  flux(): Float32Array;
/**
* @returns {Float32Array}
*/
  freq(): Float32Array;
/**
* @returns {Uint32Array}
*/
  start(): Uint32Array;
/**
* @returns {Float32Array}
*/
  energy(): Float32Array;
/**
* @returns {number}
*/
  frames(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_analyzer_free: (a: number) => void;
  readonly __wbg_spectrum_free: (a: number) => void;
  readonly analyse: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => number;
  readonly analyzer_finish: (a: number) => number;
  readonly analyzer_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => number;
  readonly analyzer_push: (a: number, b: number, c: number) => void;
  readonly spectrum_acf: (a: number, b: number) => void;
  readonly spectrum_energy: (a: number, b: number) => void;
  readonly spectrum_flux: (a: number, b: number) => void;
  readonly spectrum_frames: (a: number) => number;
  readonly spectrum_freq: (a: number, b: number) => void;
  readonly spectrum_mag: (a: number, b: number) => void;
  readonly spectrum_start: (a: number, b: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
