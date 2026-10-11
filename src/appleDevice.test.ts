import { describe, it, expect, afterEach, vi } from 'vitest';
import { isAppleTouchDevice, isMacSafariInstallable, ownFormatAccept } from './utils';

// Real user agents, as each device sends them.
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  // iPadOS's Safari asks for desktop sites: a Mac, by its user agent.
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  macSafari17: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  macSafari16: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; SM-A225F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

function device(userAgent: string, maxTouchPoints: number): void {
  vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
}

afterEach(() => vi.unstubAllGlobals());

describe('telling Apple devices apart', () => {
  it('knows an iPhone, and an iPad that claims to be a Mac', () => {
    device(UA.iphone, 5);
    expect(isAppleTouchDevice()).toBe(true);
    device(UA.ipad, 5);
    expect(isAppleTouchDevice()).toBe(true);
  });

  it('does not take a Mac or an Android phone for one', () => {
    device(UA.macSafari17, 0);
    expect(isAppleTouchDevice()).toBe(false);
    device(UA.android, 5);
    expect(isAppleTouchDevice()).toBe(false);
  });

  it('offers the Dock install to Safari 17+ on a Mac only', () => {
    device(UA.macSafari17, 0);
    expect(isMacSafariInstallable()).toBe(true);
    device(UA.macSafari16, 0);
    expect(isMacSafariInstallable()).toBe(false);
    device(UA.macChrome, 0);
    expect(isMacSafariInstallable()).toBe(false);
    device(UA.ipad, 5);
    expect(isMacSafariInstallable()).toBe(false);
  });

  it('drops the picker filter for our own formats on iOS alone', () => {
    device(UA.iphone, 5);
    expect(ownFormatAccept('.cdb,.cdbf')).toBeUndefined();
    device(UA.android, 5);
    expect(ownFormatAccept('.cdb,.cdbf')).toBe('.cdb,.cdbf');
  });
});
