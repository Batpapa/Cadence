import { describe, it, expect } from 'vitest';
import { formatBytes, formatDiskBytes } from './utils';

// formatBytes is what tells someone a recording is about to be re-uploaded on
// every sync, and what stands between them and the embed budget. A figure that
// reads wrong there is a decision made on wrong information.
describe('formatBytes', () => {
  it('keeps plain bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('drops the decimal once the number is big enough to carry itself', () => {
    // Below ten units a tenth is information; above it, it is noise.
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(42 * 1024 * 1024)).toBe('42 MB');
  });

  it('climbs a unit at a time', () => {
    expect(formatBytes(1024)).toBe('1.0 kB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('reports the embed budget as the round number it is', () => {
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });

  it('speaks octets in French, with the decimal comma', () => {
    expect(formatBytes(999, 'fr')).toBe('999 o');
    expect(formatBytes(1.5 * 1024 * 1024, 'fr')).toBe('1,5 Mo');
    expect(formatBytes(42 * 1024 * 1024 * 1024, 'fr')).toBe('42 Go');
    expect(formatBytes(1024, 'fr')).toBe('1,0 ko');
  });

  it('never groups digits', () => {
    expect(formatBytes(1000 * 1024 * 1024, 'en')).toBe('1000 MB');
    expect(formatBytes(1000 * 1024 * 1024, 'fr')).toBe('1000 Mo');
  });
});

// The free-space figure, held up against Android's Settings → Storage, which
// counts in powers of 1000.
describe('formatDiskBytes', () => {
  it('counts as Android does', () => {
    expect(formatDiskBytes(3_000_000_000, 'fr')).toBe('3,0 Go');
    expect(formatDiskBytes(2_500_000_000, 'en')).toBe('2.5 GB');
    expect(formatDiskBytes(850_000_000, 'fr')).toBe('850 Mo');
  });
});
