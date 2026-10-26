import { registerPlugin } from '@capacitor/core';
import { hasNativePlugin } from './platform';

/**
 * The app's own native plugin (android/…/DiskSpacePlugin.java): the free space
 * of the partition holding Cadence's data, as Chromium measures it to decide
 * on eviction — see services/storageService.ts. Imported dynamically, and only
 * when isNative().
 */
interface DiskSpacePlugin {
  get(): Promise<{ free: number; total: number }>;
}

const DiskSpace = registerPlugin<DiskSpacePlugin>('DiskSpace');

/** Bytes free, or null when it cannot be known. An app installed before the
 *  plugin existed runs this code too, through an over-the-air update: there,
 *  nothing is measured, so nothing is claimed either way. */
export async function deviceFreeBytes(): Promise<number | null> {
  if (!hasNativePlugin('DiskSpace')) return null;
  try {
    const { free } = await DiskSpace.get();
    return typeof free === 'number' && free >= 0 ? free : null;
  } catch {
    return null;
  }
}
