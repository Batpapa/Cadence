import { describe, it, expect } from 'vitest';
import { analyserModuleOf, editAnalyserModule, TUNE_ANALYSER_MODULE_KEY, type TuneAnalyserModuleData } from './model';

describe('analyserModuleOf', () => {
  it('is undefined for someone who never used the analyser, with or without modules', () => {
    expect(analyserModuleOf({})).toBeUndefined();
    expect(analyserModuleOf({ modules: {} })).toBeUndefined();
  });

  it('gives the stored slice itself, not a copy', () => {
    const mod: TuneAnalyserModuleData = { sessions: {}, experimentalSets: false };
    expect(analyserModuleOf({ modules: { [TUNE_ANALYSER_MODULE_KEY]: mod } })).toBe(mod);
  });
});

describe('editAnalyserModule', () => {
  it('creates the slice as { sessions: {} } when absent, and attaches it', () => {
    const user: { modules?: Record<string, unknown> } = {};
    editAnalyserModule(user, m => { m.detectionsOnCards = false; });
    expect(user.modules).toEqual({ [TUNE_ANALYSER_MODULE_KEY]: { sessions: {}, detectionsOnCards: false } });
  });

  it('edits the existing slice in place, keeping its other fields and the other modules', () => {
    const mod: TuneAnalyserModuleData = { sessions: {}, nameTemplate: 'x', syncAudioByDefault: false };
    const other = { anything: 1 };
    const user = { modules: { trending: other, [TUNE_ANALYSER_MODULE_KEY]: mod } as Record<string, unknown> };
    editAnalyserModule(user, m => { delete m.nameTemplate; });
    expect(user.modules[TUNE_ANALYSER_MODULE_KEY]).toBe(mod);
    expect(mod).toEqual({ sessions: {}, syncAudioByDefault: false });
    expect(user.modules.trending).toBe(other);
  });
});
