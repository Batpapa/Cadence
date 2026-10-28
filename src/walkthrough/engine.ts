import { driver, type Driver, type DriveStep, type PopoverDOM } from 'driver.js';
import 'driver.js/dist/driver.css';
import { getContext } from '../store';
import { t } from '../services/i18nService';
import { updateUser } from '../services/userService';
import { getZoom } from '../services/zoomService';
import { closeAllModals } from '../components/modal';
import { holdOverlays } from '../components/overlayStack';
import { SCENARIOS, type TourStep, type TourAct } from './scenarios';
import { resolve, onScreen, stillOnScreen } from './targets';
import { bubbleTop, type Rect } from './placement';

// ── Running a walkthrough ────────────────────────────────────────────────────
// driver.js (MIT) lights the element and places the bubble; what it does not
// do is keep the rest of the app quiet. Its CSS takes the pointer away from
// everything but the lit element and the bubble — this adds the keyboard
// (shortcuts, Escape, Tab out of the bubble), the back gesture (held in the
// overlay stack) and a second, capture-phase net for the pointer, so that the
// user can do ONLY what the step asks (the author's rule, 2026-10-27).
//
// Loaded on demand: nobody pays for driver.js until a walkthrough starts.

let running = false;

/** The two marks help strings use (help.tsx's Rich), as HTML for the bubble.
 *  Escaped first: these are translations, and nothing in them should be able
 *  to become markup. */
function richHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** The app zooms <html> (zoomService), and driver.js writes the bubble's
 *  position from getBoundingClientRect — window pixels, which the zoom would
 *  scale a second time. Zoomed back to 1, the bubble lives in window pixels
 *  like its measurements; styles.css scales its type up to match the app.
 *  The overlay needs nothing: its viewBox is in window pixels already. */
function unzoom(popover: PopoverDOM): void {
  popover.wrapper.style.setProperty('zoom', String(100 / getZoom()));
}

const stepTarget = (step: TourStep | undefined) =>
  typeof step?.target === 'function' ? step.target() : step?.target;

interface Gate {
  /** A press there goes through. */
  allowed: (node: Node) => boolean;
  inBubble: (node: Node) => boolean;
  /** Keys typed there go through, to the field and its own handlers. */
  typing: (node: Node) => boolean;
  focusables: () => HTMLElement[];
  /** The walkthrough itself pressing something (TourStep.after). */
  bypassed: () => boolean;
  /** A click let through — the one a 'click' step waits for, maybe. */
  clicked: (node: Node) => void;
}

/** Only the bubble, and the lit element on a step that asks for it. */
function installBlocker(gate: Gate): () => void {
  const pointer = (e: Event) => {
    if (gate.bypassed()) return;
    if (e.target instanceof Node && gate.allowed(e.target)) {
      if (e.type === 'click') gate.clicked(e.target);
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  // A press on the bubble reaches driver.js (its own capture listener, on the
  // document) and stops there: the app must not hear it either. An open menu
  // closes on any press outside itself — « Suivant » included, which shut ⋮
  // under the step describing it.
  const bubbleOnly = (e: Event) => {
    if (e.target instanceof Node && gate.inBubble(e.target)) e.stopImmediatePropagation();
  };
  // Not cancelled: a touch that is not let through must still scroll.
  const touch = (e: Event) => {
    if (e.target instanceof Node && gate.allowed(e.target)) return;
    e.stopImmediatePropagation();
  };
  const key = (e: KeyboardEvent) => {
    // Tab goes round the bubble's buttons and the lit element, nowhere else.
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type !== 'keydown') return;
      const list = gate.focusables();
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = at < 0 ? 0 : (at + (e.shiftKey ? list.length - 1 : 1)) % list.length;
      list[next]!.focus();
      return;
    }
    // Typing in the lit field: let through whole, so that the field's own
    // Enter works. Never Escape (it would close the dialog the step is in)
    // and never a shortcut.
    if (e.key !== 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey
        && e.target instanceof Node && gate.typing(e.target)) return;
    // Pressing a focused button: its default (a click, checked above like any
    // click) goes ahead; the app's own shortcuts never hear it.
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Node && gate.allowed(e.target)) {
      e.stopImmediatePropagation();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const pointerTypes = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'dragstart'];
  const touchTypes = ['touchstart', 'touchend'];
  const keyTypes = ['keydown', 'keyup', 'keypress'] as const;
  for (const type of pointerTypes) window.addEventListener(type, pointer, true);
  for (const type of pointerTypes) document.addEventListener(type, bubbleOnly);
  for (const type of touchTypes) window.addEventListener(type, touch, { capture: true, passive: true });
  for (const type of keyTypes) window.addEventListener(type, key, true);
  return () => {
    for (const type of pointerTypes) window.removeEventListener(type, pointer, true);
    for (const type of pointerTypes) document.removeEventListener(type, bubbleOnly);
    for (const type of touchTypes) window.removeEventListener(type, touch, true);
    for (const type of keyTypes) window.removeEventListener(type, key, true);
  };
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** What a 'do' step may have the user press or type in — disabled ones too:
 *  « Créer » is greyed until a name is typed, and must not be covered then. */
const CONTROL = 'button, input, textarea, select, a[href], [role="button"], [contenteditable="true"]';

/** The safe area, in window pixels: what lies under a phone's status bar and
 *  above its gesture bar. Measured, because env() is only readable by CSS. */
function safeInsets(): { top: number; bottom: number } {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;'
    + 'padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const scale = probe.getBoundingClientRect().height / ((parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)) || 1);
  const out = { top: parseFloat(cs.paddingTop) * (scale || 1), bottom: parseFloat(cs.paddingBottom) * (scale || 1) };
  probe.remove();
  return out;
}

const visibleRect = (el: Element): Rect | null => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= innerHeight) return null;
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
};

function markDone(id: string): void {
  void getContext().mutate(s => updateUser(s, { walkthroughs: { ...s.walkthroughs, [id]: Date.now() } }));
}

export function startScenario(id: string): void {
  const scenario = SCENARIOS.find(s => s.id === id);
  if (!scenario || running) return;
  if (scenario.requires && !scenario.requires.met()) return;
  running = true;

  // From where everything starts, with nothing open over it.
  closeAllModals();
  const ctx = getContext();
  ctx.navigate({ view: 'folder', folderId: null });

  const steps: TourStep[] = scenario.steps().filter(s => s.available?.() ?? true);
  let finished = false;
  let bypass = false;
  let d: Driver | null = null;
  /** For TourStep.after: the walkthrough acting for the user, let through
   *  by the blocker while it does. */
  const bypassing = (fn: () => void) => {
    bypass = true;
    try { fn(); } finally { bypass = false; }
  };
  const act: TourAct = {
    click: target => {
      const el = resolve(target)?.el;
      if (el instanceof HTMLElement) bypassing(() => el.click());
    },
    pressOutside: () => bypassing(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }),
    clear: target => {
      const el = resolve(target)?.el;
      if (!(el instanceof HTMLInputElement) || el.value === '') return;
      el.value = '';
      // What typing sends: the field's owner keeps its value in its state.
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
  };
  const activeStep = (): TourStep | undefined => steps[d?.getActiveIndex() ?? -1];
  const popoverEl = () => document.querySelector<HTMLElement>('.driver-popover');
  /** The lit element, when the step lets the user act on it. */
  const actionable = (): Element | null => {
    const action = activeStep()?.action;
    return action === 'click' || action === 'do' ? d?.getActiveElement() ?? null : null;
  };
  const denied = (node: Node): boolean =>
    (activeStep()?.deny ?? []).some(name =>
      Array.from(document.querySelectorAll(`[data-tour="${name}"]`)).some(el => el.contains(node)));

  const inBubble = (node: Node): boolean => !!popoverEl()?.contains(node);
  /** A list hanging from the lit field but drawn outside it — suggestions
   *  under a search field — marked `data-tour-float`: lifted over the veil
   *  by styles.css, and pickable while the step has the user act. */
  const inFloat = (node: Node): boolean =>
    activeStep()?.action === 'do' && !!(node instanceof Element ? node : node.parentElement)?.closest('[data-tour-float]');
  const gate: Gate = {
    inBubble,
    allowed: node => inBubble(node) || inFloat(node) || (!!actionable()?.contains(node) && !denied(node)),
    typing: node => activeStep()?.action === 'do' && !!actionable()?.contains(node) && !denied(node),
    focusables: () => {
      const lit = actionable();
      return [
        ...Array.from(popoverEl()?.querySelectorAll<HTMLElement>('button') ?? []),
        ...(lit instanceof HTMLElement && lit.matches(FOCUSABLE) ? [lit] : []),
        ...Array.from(lit?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(el => !denied(el)),
      ];
    },
    bypassed: () => bypass,
    // Seen here, on the way down, and not by driver.js's own advanceOnClick:
    // that one looks on the way back up, after the button's handler has run —
    // and Preact redraws in between. The pencil of a card's notes became the
    // save icon under the finger, the node clicked was no longer inside the
    // lit button, and the step never moved on (2026-10-27). The step moves on
    // once the click has done what it does.
    clicked: node => {
      if (activeStep()?.action === 'click' && d?.getActiveElement()?.contains(node)) setTimeout(advance, 0);
    },
  };

  const releaseHold = holdOverlays();
  const removeBlocker = installBlocker(gate);

  /** What the bubble must not cover (see placement.ts): on a 'do' step the
   *  controls inside the lit element, and the list hanging from it; on any
   *  other step the lit element whole — a 'click' one is pressed anywhere. */
  const keepRects = (): Rect[] => {
    const lit = d?.getActiveElement();
    if (!lit || lit.id === 'driver-dummy-element') return [];
    const out: Rect[] = [];
    if (activeStep()?.action === 'do') {
      const controls = [lit, ...Array.from(lit.querySelectorAll(CONTROL))].filter(el => el.matches(CONTROL) && !denied(el));
      for (const el of [...controls, ...Array.from(document.querySelectorAll('[data-tour-float]'))]) {
        const r = visibleRect(el);
        if (r) out.push(r);
      }
    }
    if (out.length === 0) {
      const r = visibleRect(lit);
      if (r) out.push(r);
    }
    return out;
  };
  const keepKey = (rects: Rect[]) => rects.map(r => `${r.top},${r.bottom},${r.left},${r.right}`).join(';');

  /** Where the bubble stood when placeBubble last left it — see `watch`. */
  let placedAt = '';
  const posOf = (el: HTMLElement) => `${el.style.top}|${el.style.left}|${el.style.bottom}|${el.style.right}`;

  /** Runs right after driver.js has placed the bubble, never otherwise: the
   *  decision is about ITS place — measured against ours, the bubble would
   *  look clear and be handed back to the spot it was moved off. */
  const placeBubble = () => {
    const popover = popoverEl();
    if (!popover) return;
    try { decide(popover); } finally { placedAt = posOf(popover); }
  };
  const decide = (popover: HTMLElement) => {
    const r = popover.getBoundingClientRect();
    const insets = safeInsets();
    const top = bubbleTop(
      { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      keepRects(),
      { width: innerWidth, height: innerHeight, insetTop: insets.top, insetBottom: insets.bottom },
    );
    // The arrow points at the lit element from a side; detached, it would
    // point at nothing.
    popover.classList.toggle('tour-detached', top !== null);
    if (top === null) return;
    Object.assign(popover.style, { top: `${top}px`, bottom: 'auto', left: `${(innerWidth - r.width) / 2}px`, right: 'auto' });
  };

  /** On to the next step — from « Suivant », a press on the lit element, or
   *  a 'do' step whose result is there. */
  const advance = () => {
    if (!d || !settled) return;
    let next = d.getActiveIndex()! + 1;
    // An optional step whose element the page is not showing is passed over.
    while (next < steps.length && steps[next]!.optional && !resolve(stepTarget(steps[next]))) next++;
    settled = false;
    if (next >= steps.length) { finished = true; d.destroy(); return; }
    d.moveTo(next);
  };

  // The lit box and the bubble follow what moves under them, frame by frame:
  // a page drawn after the step began, the side panel sliding, the window
  // resized. driver.js redraws on `resize` itself, but before the app has
  // laid itself out again for the new size, and never after — so it showed
  // the old layout until something else redrew it (reported 2026-10-27:
  // "très lent à se redessiner"). One rect read per frame, a redraw only when
  // it changed. Not while driver.js is moving from one step to the next: its
  // refresh reads the step it is leaving until the move is over.
  let settled = false;
  let lastBox = '';
  let watcher = 0;
  const watch = () => {
    watcher = requestAnimationFrame(watch);
    const step = activeStep();
    if (!d || !settled || !step) return;
    // A 'do' step is over when what it asked for is done.
    if (step.action === 'do' && step.until?.()) { advance(); return; }
    const el = d.getActiveElement();
    if (!el || el.id === 'driver-dummy-element') return;
    // Redrawn elsewhere — the header puts Home and Library in the bottom bar
    // when it narrows: the step looks for its element again.
    if (!stillOnScreen(el)) {
      const found = resolve(stepTarget(step));
      if (found && found.el !== el) { settled = false; d.moveTo(d.getActiveIndex()!); }
      return;
    }
    const r = el.getBoundingClientRect();
    // What the bubble keeps clear of counts too: a list of matches opening
    // under a field moves nothing the lit box is drawn from.
    const box = `${r.x},${r.y},${r.width},${r.height},${innerWidth},${innerHeight}|${keepKey(keepRects())}`;
    if (box !== lastBox) { lastBox = box; d.refresh(); placeBubble(); return; }
    // driver.js places the bubble again on its own too — on `resize`, which
    // is what a phone's keyboard coming up is, and AFTER this loop had seen
    // the new size (measured 2026-10-27). Its place is then decided again.
    const popover = popoverEl();
    if (popover && posOf(popover) !== placedAt) placeBubble();
  };
  watcher = requestAnimationFrame(watch);

  const driveSteps: DriveStep[] = steps.map(step => ({
    // A function, so the element is looked for when the step begins — after
    // the page the previous step opened has been drawn.
    element: step.target === undefined ? undefined : () => resolve(stepTarget(step))?.el as Element,
    disableActiveInteraction: !step.action,
    ...(step.wait ? { waitForElement: step.wait } : {}),
    popover: {
      title: t(step.titleKey),
      description: richHtml(t(step.textKey)),
      side: step.side,
      // A step done by acting has no « Suivant »: the act is the way on.
      showButtons: step.action === 'click' || (step.action === 'do' && step.until) ? ['close'] : ['next', 'close'],
      onPopoverRender: (popover) => {
        unzoom(popover);
        const extras = (step.extras ?? []).filter(x => onScreen(x.when)).map(x => t(x.textKey));
        if (extras.length) popover.description.innerHTML = richHtml([t(step.textKey), ...extras].join(' '));
      },
    },
  }));

  d = driver({
    steps: driveSteps,
    popoverClass: scenario.extension ? 'cadence-tour cadence-tour-irish' : 'cadence-tour',
    overlayColor: '#000',
    overlayOpacity: 0.6,
    stagePadding: 5,
    stageRadius: 8,
    // The lit box moves first, then the bubble appears beside it, once it is
    // there (onHighlighted). driver.js draws the new bubble half-way through
    // the move: the new words showed before the light had reached their
    // element (2026-10-27). Hidden until then by styles.css.
    duration: 300,
    smoothScroll: false,
    allowKeyboardControl: false,
    overlayClickBehavior: 'none',
    // What the step needs may come with the page a click just opened. Never
    // skipped when still missing (it then sits in the middle): driver.js
    // judges "is this the last step?" against the page on screen, so with
    // skipping on, every step whose page is not open yet would count as gone.
    // Steps that may not apply are left out up front instead (`available`).
    waitForElement: 2500,
    showProgress: true,
    progressText: t('walkthrough.progress'),
    nextBtnText: t('walkthrough.next'),
    doneBtnText: t('walkthrough.finish'),
    closeBtnLabel: t('walkthrough.quit'),
    onHighlightStarted: () => { settled = false; },
    onHighlighted: () => {
      settled = true;
      lastBox = '';
      const popover = popoverEl();
      if (!popover) return;
      placeBubble();
      popover.classList.add('tour-shown');
      // Keyboard users start where the step wants them: in the lit field of
      // a step that has them type, on the way forward otherwise.
      const lit = actionable();
      const field = activeStep()?.action === 'do'
        ? (lit?.matches('input, textarea') ? lit : lit?.querySelector('input:not([type=hidden]), textarea')) as HTMLElement | null
        : null;
      const next = popover.querySelector<HTMLElement>('.driver-popover-next-btn');
      const close = popover.querySelector<HTMLElement>('.driver-popover-close-btn');
      (field ?? (next?.offsetParent ? next : close))?.focus({ preventScroll: true });
    },
    onNextClick: () => {
      activeStep()?.after?.(act);
      advance();
    },
    onCloseClick: (_el, _step, { driver: dr }) => dr.destroy(),
    onDestroyed: () => {
      cancelAnimationFrame(watcher);
      removeBlocker();
      releaseHold();
      running = false;
      if (finished) markDone(scenario.id);
    },
  });
  // After the Home page the navigation above has asked for is drawn.
  requestAnimationFrame(() => requestAnimationFrame(() => d!.drive()));
}
