// @vitest-environment jsdom
// Not for the DOM: extensions.ts reads the open user through the store, which
// reaches driveService, which reads localStorage at module evaluation.
import { describe, it, expect } from 'vitest';
import { irishTradEnabled, theSessionOffered, irishTuneInfoOffered, tuneAnalyserOffered, trendingOffered, transcriptionOffered, cardTypesOffered, extensionSwitch, newUserExtensions } from './extensions';

describe('extensions', () => {
  it('counts an extension nobody set as on — users from before extensions keep everything', () => {
    const user = {};
    expect(irishTradEnabled(user)).toBe(true);
    expect(theSessionOffered(user)).toBe(true);
    expect(tuneAnalyserOffered(user)).toBe(true);
    expect(trendingOffered(user)).toBe(true);
  });

  it('leaves irishtune.info off until it is ticked', () => {
    expect(irishTuneInfoOffered({})).toBe(false);
    expect(irishTuneInfoOffered({ extensionOptions: { irishTrad: { irishTuneInfo: true } } })).toBe(true);
  });

  it('offers nothing of an extension that is off, whatever its options say', () => {
    const user = { extensions: { irishTrad: false }, extensionOptions: { irishTrad: { irishTuneInfo: true, trending: true } } };
    expect(theSessionOffered(user)).toBe(false);
    expect(irishTuneInfoOffered(user)).toBe(false);
    expect(tuneAnalyserOffered(user)).toBe(false);
    expect(trendingOffered(user)).toBe(false);
  });

  it('keeps TheSession on with its extension, even if a stored value says otherwise', () => {
    expect(theSessionOffered({ extensionOptions: { irishTrad: { theSession: false } } })).toBe(true);
  });

  it('follows a module option switched off', () => {
    const user = { extensionOptions: { irishTrad: { tuneAnalyser: false } } };
    expect(tuneAnalyserOffered(user)).toBe(false);
    expect(trendingOffered(user)).toBe(true);
  });

  it('starts a new user with every extension written out as off', () => {
    const user = { extensions: newUserExtensions() };
    expect(user.extensions).toEqual({ music: false, irishTrad: false });
    expect(irishTradEnabled(user)).toBe(false);
    expect(transcriptionOffered(user)).toBe(false);
    expect(cardTypesOffered(user)).toBe(false);
  });

  // Music came after the Irish extension, which sits under it (2026-11-28):
  // its absence reads as the Irish one's own state, so whoever had that one
  // has Music — the card types and the Transcription module — unasked.
  it('gives Music to whoever has the Irish extension, and nothing to whoever has not', () => {
    expect(cardTypesOffered({})).toBe(true);
    expect(transcriptionOffered({})).toBe(true);
    expect(transcriptionOffered({ extensions: { irishTrad: true } })).toBe(true);
    expect(transcriptionOffered({ extensions: { irishTrad: false } })).toBe(false);
    expect(transcriptionOffered({ extensions: { irishTrad: false, music: true } })).toBe(true);
  });

  it('counts the Irish extension only while Music is on, keeping its own switch', () => {
    const user = { extensions: { music: false, irishTrad: true } };
    expect(irishTradEnabled(user)).toBe(false);
    expect(tuneAnalyserOffered(user)).toBe(false);
    expect(extensionSwitch('irishTrad', user)).toBe(true);
    expect(irishTradEnabled({ extensions: { music: true, irishTrad: true } })).toBe(true);
  });

  it('lets the Transcription module be switched off on its own', () => {
    const user = { extensions: { music: true }, extensionOptions: { music: { transcription: false } } };
    expect(transcriptionOffered(user)).toBe(false);
    expect(cardTypesOffered(user)).toBe(true);
  });
});
