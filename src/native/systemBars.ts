import { registerPlugin } from '@capacitor/core';

/**
 * Android's status and navigation bars in the theme's header colour — see
 * android/…/SystemBarsColorPlugin.java for why the app paints them itself.
 * Imported dynamically, and only when isNative().
 */
interface SystemBarsColorPlugin {
  set(options: { color: string; light: boolean }): Promise<void>;
}

const SystemBarsColor = registerPlugin<SystemBarsColorPlugin>('SystemBarsColor');

/** The header and the bottom nav are `bg-surface`: the bars take that colour,
 *  read from the theme just applied, with icons dark on a light one. */
export function syncSystemBars(): void {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim();
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return;
  const [r, g, b] = [m[1], m[2], m[3]].map(h => parseInt(h!, 16) / 255) as [number, number, number];
  // Relative luminance, close enough to choose an icon colour.
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
  void SystemBarsColor.set({ color, light }).catch(() => { /* older APK without the plugin */ });
}
