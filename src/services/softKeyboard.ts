import { signal } from '@preact/signals';

/**
 * Whether a phone's on-screen keyboard is up.
 *
 * Wanted so that the keyboard covers the bottom nav instead of carrying it up
 * (2026-10-06). The Android app resizes the page above the keyboard (Android
 * ≤ 14), so the nav, pinned to the bottom, rode on top of it; Chrome and
 * Android 15+ shrink only the visual viewport, but still bring the nav back
 * into view when they scroll a low field above the keyboard. The nav hides
 * while this is true, in both, and so does the legal footer
 * (`html.soft-keyboard-open`, styles.css).
 *
 * No browser says when the keyboard is up. Read here: the visible height has
 * dropped well below the tallest seen at this width, while a text field has
 * the focus. The visual viewport's height times its scale stays the layout
 * height under pinch-zoom, which therefore never counts. Browser toolbars
 * moving in and out stay under the threshold.
 */
export const softKeyboardOpen = signal(false);

/** Smaller than any phone keyboard, larger than a browser toolbar. */
const THRESHOLD_PX = 150;

let tallest = 0;
let tallestAtWidth = 0;

function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

function measure(): void {
  const vv = window.visualViewport;
  const height = vv ? vv.height * vv.scale : window.innerHeight;
  // A new width is a rotation (or a resized window): start over from there.
  if (window.innerWidth !== tallestAtWidth) { tallestAtWidth = window.innerWidth; tallest = height; }
  tallest = Math.max(tallest, height);
  const open = tallest - height > THRESHOLD_PX && isTextField(document.activeElement);
  if (open === softKeyboardOpen.value) return;
  softKeyboardOpen.value = open;
  document.documentElement.classList.toggle('soft-keyboard-open', open);
}

if (typeof window !== 'undefined') {
  measure();
  window.visualViewport?.addEventListener('resize', measure);
  window.addEventListener('resize', measure);
  // Focus moves before the keyboard has finished opening or closing; the
  // resize that follows settles it. These catch a focus change with no resize.
  document.addEventListener('focusin', () => setTimeout(measure, 0));
  document.addEventListener('focusout', () => setTimeout(measure, 0));
}
