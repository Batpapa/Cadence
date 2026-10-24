import { signal, type Signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { render } from 'preact';
import type { ComponentChild } from 'preact';
import { t } from '../services/i18nService';
import { focusIfDesktop } from '../utils';
import { modalMaxH, modalMaxW } from '../services/zoomService';
import { ExpandIcon, CollapseIcon } from './icons';
import { registerOverlay } from './overlayStack';

// ── Modal infrastructure (Preact — 2026-08-26) ──────────────────────────────────
// The shell (overlay, dialog frame, header, footer, stacking, outside-click
// dismiss) is real Preact now, portaled into document.body via ModalHost —
// mount <ModalHost/> once per Preact root (appRoot.tsx's AppRoot AND
// UserSelector, since they're two independent roots and either one can be
// the only thing mounted at boot).
//
// showModal()'s `body` parameter is still a raw HTMLElement, on purpose:
// every caller (settingsModal.ts, theSessionImport.ts, card.tsx, …) still
// builds its modal content with vanilla DOM or its own render() call — this
// is Tier 0 of the Preact migration (converting the shared infrastructure
// everything else sits on), not a rewrite of every caller. BodyMount below
// bridges that raw element into the new JSX shell exactly like sidebar.ts
// already bridges into AppRoot.

export interface ModalAction {
  label: string;
  primary?: boolean;
  danger?: boolean;
  icon?: Element;
  align?: 'start';
  /** A signal rather than a plain boolean because the footer buttons are
   *  declared up front, outside the body's Preact tree: a body that decides
   *  whether its action would do anything (nothing ticked, empty field) writes
   *  here, and ModalDialog re-renders on it by virtue of reading `.value`. */
  disabled?: Signal<boolean>;
  onClick: () => void | Promise<void>;
}

/** A control in the modal header, beside the close button. For what belongs
 *  to the whole modal rather than to its content — settings for what is being
 *  shown, say — which a footer button would misrepresent as an outcome. */
export interface ModalHeaderAction {
  icon: Element;
  title: string;
  onClick: () => void;
}

/** Everything about a modal beyond its title, body and footer buttons.
 *
 *  An object rather than the tail of a positional list, which is what this was
 *  until 2026-09-05: the seventh parameter had reached the point where a
 *  caller's `showModal(a, b, [], true, w, onDismiss, {…})` said nothing about
 *  what those arguments were, and a grep for `headerAction` genuinely missed
 *  the one call site using it. */
export interface ModalOptions {
  /** Default true. False removes the ✕, Escape and the click-outside at once. */
  dismissable?: boolean;
  /** Default '28rem'. Capped by the viewport, and ignored while expanded. */
  maxWidth?: string;
  onDismiss?: () => void;
  /** Header controls, left to right, before the expand toggle and the ✕. */
  headerActions?: ModalHeaderAction[];
  /** Offers a toggle that gives the dialog the whole page. Opt-in, because
   *  most modals hold a form that gains nothing from the room and would only
   *  look lost in it. Deliberately NOT remembered between openings: it is a
   *  way to look closer at what is on screen now, not a preference. */
  expandable?: boolean;
  /** Called with the expanded state, at opening and on every toggle. For a
   *  body that sizes something against the dialog — a score capped at half the
   *  viewport, which must take the room the expansion just gave it rather than
   *  leaving it empty. The body renders in its own tree and cannot see this
   *  state any other way. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Turns the header title into a second level: a back arrow appears before
   *  it, and the caller decides what going back means. For a modal whose body
   *  navigates — an export picker whose formats open a sub-choice — so the
   *  way out sits where every other modal puts its chrome, rather than as a
   *  link the body has to draw for itself.
   *  Set it after opening with `updateTopModal`, which is how a body that owns
   *  the navigation state drives its own header. */
  onBack?: () => void;
  /** Makes the title renamable in place: a click turns it into a field holding
   *  the title minus `suffix`, which stays fixed after the field — a file's
   *  extension, say, that must not change. `onCommit` receives what was typed;
   *  the caller decides whether it is a new name, persists it, and shows it with
   *  `updateTopModal`. */
  titleEdit?: { suffix: string; onCommit: (value: string) => void };
  /** Asked before a USER dismissal (✕, Escape, the back gesture, a click
   *  outside) goes through. Return true to hold it — an edit not yet saved,
   *  typically, whose owner asks first — and call `dismiss` once the answer
   *  allows it; the dialog stays open, and nothing has been torn down, until
   *  then. False lets the dismissal happen now.
   *
   *  Not consulted by `closeModal` / `closeAllModals`: those are the code's
   *  own way of closing, and a body that calls them knows what it is doing. */
  guardDismiss?: (dismiss: () => void) => boolean;
  /** Default false. Once the user has pressed anything in the dialog, its TOP
   *  stays where it is and only the bottom moves as the content changes — see
   *  usePinnedTop. For a dialog pressed several times at the same place while
   *  its height changes under the finger. */
  pinTop?: boolean;
}

/** A centred dialog moves when its height changes: half the change goes on
 *  top. In a dialog pressed several times in a row at the same place, the
 *  second press then lands beside the control — and, when the dialog has just
 *  shrunk, on the backdrop, which closes it. Reported 2026-10-23 on the score
 *  viewer: a version of two lines after one of twenty, the arrows jumped down,
 *  and a quick second tap on → went back to the card.
 *
 *  Centred until the first press inside it, because what a dialog shows at its
 *  opening is not always its size: the score viewer draws after abcjs has
 *  loaded. From that press the top is held, and only the bottom follows the
 *  content — past the bottom of the screen if need be, the backdrop then
 *  scrolls (the user's call: "tant pis, les gens scrolleront"). A width change
 *  of the window — a phone turned — centres it again; a height change alone,
 *  which is a keyboard opening, does not.
 *
 *  Measured and written in layout pixels (clientHeight, offsetHeight, a
 *  margin), the one pixel space that the app's CSS zoom does not split. */
export function usePinnedTop(
  enabled: boolean,
  overlayRef: { current: HTMLElement | null },
  dialogRef: { current: HTMLElement | null },
) {
  const [top, setTop] = useState<number | null>(null);
  const pinned = enabled && top !== null;
  useEffect(() => {
    if (!pinned) return;
    const width = window.innerWidth;
    const onResize = () => { if (window.innerWidth !== width) setTop(null); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [pinned]);
  const pin = () => {
    if (!enabled || top !== null) return;
    const overlay = overlayRef.current, dialog = dialogRef.current;
    if (!overlay || !dialog) return;
    setTop(Math.max(0, (overlay.clientHeight - dialog.offsetHeight) / 2));
  };
  return {
    unpin: () => setTop(null),
    /** For the backdrop, in place of its `items-center`. */
    overlayClass: pinned ? 'items-start overflow-y-auto' : 'items-center',
    /** Merged into the dialog's own style. The bottom margin is the room left
     *  under it once it runs past the screen and the backdrop scrolls. */
    dialogStyle: pinned ? { marginTop: `${top}px`, marginBottom: '1rem' } : {},
    /** On the dialog, capture phase: the press is measured before whatever it
     *  does changes the height. */
    onPointerDownCapture: pin,
    onKeyDownCapture: pin,
  };
}

interface ModalEntry {
  id: number;
  title: string;
  body: HTMLElement;
  actions: ModalAction[];
  dismissable: boolean;
  maxWidth: string;
  onDismiss?: () => void;
  headerActions: ModalHeaderAction[];
  expandable: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onBack?: () => void;
  titleEdit?: ModalOptions['titleEdit'];
  guardDismiss?: ModalOptions['guardDismiss'];
  pinTop: boolean;
}

let nextId = 0;
const modalStack = signal<ModalEntry[]>([]);
/** Modal id → its overlay registration. Keyed by id rather than kept on the
 *  entry because ModalEntry is what the shell renders from, and this is
 *  bookkeeping the renderer has no business seeing. */
const _unregisterByModalId = new Map<number, () => void>();

// anyModalOpen() lived here until 2026-09-10. It existed so an overlay outside
// this stack could ask whether a dialog was covering it before acting on its
// own Escape — a workaround for there being no single answer to "what is on
// top". The overlay registry is that answer now, and nothing needs the
// question any more.

export function closeModal(): void {
  const top = modalStack.value[modalStack.value.length - 1];
  if (top) { _unregisterByModalId.get(top.id)?.(); _unregisterByModalId.delete(top.id); }
  modalStack.value = modalStack.value.slice(0, -1);
}

/** Pops the whole stack, running every entry's `onDismiss`. For the rare
 *  action inside a modal that navigates elsewhere: popping one would leave the
 *  dialogs below it hanging over a view they have nothing to do with. */
export function closeAllModals(): void {
  const open = modalStack.value;
  for (const e of open) { _unregisterByModalId.get(e.id)?.(); _unregisterByModalId.delete(e.id); }
  modalStack.value = [];
  for (const entry of open) entry.onDismiss?.();
}

/** Changes the open modal's header after the fact. The body is mounted as a
 *  detached element and renders in its own tree, so a body that navigates has
 *  no other way to keep the shell's title and back arrow in step with what it
 *  is showing. Only the header is patchable on purpose: the id, body and
 *  actions are what the shell is keyed and laid out on. */
export function updateTopModal(patch: { title?: string; onBack?: (() => void) | undefined }): void {
  const stack = modalStack.value;
  const top = stack[stack.length - 1];
  if (!top) return;
  modalStack.value = [...stack.slice(0, -1), { ...top, ...patch }];
}

/** Closes modal `id` the way a USER dismissal does — which is not what
 *  `closeModal` alone does: that one pops the stack and stops there, while a
 *  dismissal also runs `onDismiss`, and `onDismiss` is where a Preact body
 *  unmounts itself (renderModalBody). The back gesture used to take the first
 *  path and leaked a mounted tree per dialog it closed.
 *
 *  Refuses — returns false — for anything but the topmost dialog, and for one
 *  declared `dismissable: false`: those exist to hold a decision (a Drive
 *  conflict, an account switch) and have no way out on purpose. */
function dismissModalById(id: number): boolean {
  const stack = modalStack.value;
  const top = stack[stack.length - 1];
  if (!top || top.id !== id || !top.dismissable) return false;
  // Held: still open, and whatever its guard put on top is the topmost layer
  // now. Counted as a refusal, so the gesture goes no further.
  if (top.guardDismiss?.(() => completeDismiss(top))) return false;
  completeDismiss(top);
  return true;
}

/** The end of a user dismissal, by id rather than by "the top": a guarded one
 *  completes after a question of its own has been opened and closed above it,
 *  and possibly after a save that asked something too — by then nothing says
 *  the dialog is still on top, only that it is still there. */
function completeDismiss(entry: ModalEntry): void {
  if (!modalStack.value.some(e => e.id === entry.id)) return;
  _unregisterByModalId.get(entry.id)?.();
  _unregisterByModalId.delete(entry.id);
  modalStack.value = modalStack.value.filter(e => e.id !== entry.id);
  entry.onDismiss?.();
}

export function showModal(title: string, body: HTMLElement, actions: ModalAction[], opts: ModalOptions = {}): void {
  // Registered as the topmost overlay, so the back gesture and Escape both
  // close THIS rather than navigating behind it or reaching past it. The
  // unregister runs from closeModal and from every dismissal path below,
  // which all go through it.
  const id = nextId;
  const unregister = registerOverlay(() => dismissModalById(id));
  _unregisterByModalId.set(nextId, unregister);
  modalStack.value = [...modalStack.value, {
    id: nextId++,
    title,
    body,
    actions,
    dismissable: opts.dismissable ?? true,
    maxWidth: opts.maxWidth ?? '28rem',
    titleEdit: opts.titleEdit,
    onDismiss: opts.onDismiss,
    headerActions: opts.headerActions ?? [],
    expandable: opts.expandable ?? false,
    onExpandedChange: opts.onExpandedChange,
    onBack: opts.onBack,
    guardDismiss: opts.guardDismiss,
    pinTop: opts.pinTop ?? false,
  }];
}

export function promptModal(title: string, label: string, defaultValue: string, onConfirm: (value: string) => void): void {
  const body = document.createElement('div');
  body.className = 'space-y-1';
  const lbl = document.createElement('label');
  lbl.className = 'label';
  lbl.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = defaultValue;
  input.className = 'input';
  body.append(lbl, input);
  const confirm = () => { const val = input.value.trim(); if (!val) return; closeModal(); onConfirm(val); };
  // Enter only: Escape is the shell's business now (main.ts → overlay stack),
  // and closing here as well would let one keypress take this dialog AND
  // whatever it was opened from.
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); });
  showModal(title, body, [{ label: t('common.cancel'), onClick: closeModal }, { label: t('common.confirm'), primary: true, onClick: confirm }]);
  focusIfDesktop(input);
}

/** "Unsaved changes": save, discard, or stay — for a dialog holding an edit
 *  that leaving would lose (ModalOptions.guardDismiss is how it asks).
 *  `proceed` runs after a save that went through or after a discard; a save
 *  that did not (refused, failed) and Cancel both leave everything where it
 *  was. Escape and the ✕ are Cancel. `message` names what was being edited. */
export function askUnsavedChanges({ message, save, discard, proceed, canSave = true, saveLabel }: {
  message: string;
  /** The keeping button's word: the dialog's own, so "Add" where the dialog
   *  adds. Default "Save". */
  saveLabel?: string;
  save: () => Promise<boolean>;
  discard: () => void;
  proceed: () => void;
  /** False when what is on screen could not be saved as it is (a link with
   *  no name): the question then offers only to drop it or to stay. */
  canSave?: boolean;
}): void {
  const body = document.createElement('p');
  body.className = 'text-sm text-muted leading-relaxed';
  body.textContent = message;
  // Save, Discard, Cancel, left to right (the user's order, 2026-10-13): the
  // one that keeps the work first.
  showModal(t('unsaved.title'), body, [
    ...(canSave ? [{
      label: saveLabel ?? t('common.save'), primary: true,
      // Closed first: a save may ask a question of its own (a TheSession score
      // is saved as a copy), which must not open under this one.
      onClick: async () => { closeModal(); if (await save()) proceed(); },
    }] : []),
    { label: t('unsaved.discard'), danger: true, onClick: () => { closeModal(); discard(); proceed(); } },
    { label: t('common.cancel'), onClick: closeModal },
  ]);
}

export function confirmModal(title: string, message: string, confirmLabel: string, onConfirm: () => void): void {
  const body = document.createElement('p');
  body.className = 'text-sm text-muted leading-relaxed';
  body.textContent = message;
  showModal(title, body, [
    { label: t('common.cancel'), onClick: closeModal },
    { label: confirmLabel, danger: true, onClick: () => { closeModal(); onConfirm(); } },
  ]);
}

/** A message with nothing to decide — one dismissal, no cancel. Same body
 *  styling as confirmModal, so a refusal reads like the question that led to it. */
export function alertModal(title: string, message: string): void {
  const body = document.createElement('p');
  body.className = 'text-sm text-muted leading-relaxed';
  body.textContent = message;
  showModal(title, body, [{ label: t('common.close'), primary: true, onClick: closeModal }]);
}

export function confirmModalWithOption(
  title: string,
  message: string,
  confirmLabel: string,
  optionLabel: string,
  onConfirm: (optionChecked: boolean) => void
): void {
  const body = document.createElement('div');
  body.className = 'space-y-3';

  const msg = document.createElement('p');
  msg.className = 'text-sm text-muted leading-relaxed';
  msg.textContent = message;

  const label = document.createElement('label');
  label.className = 'flex items-center gap-2 cursor-pointer select-none text-sm text-primary';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'card-checkbox';
  const optionText = document.createElement('span');
  optionText.textContent = optionLabel;
  label.append(checkbox, optionText);

  body.append(msg, label);

  showModal(title, body, [
    { label: t('common.cancel'), onClick: closeModal },
    { label: confirmLabel, danger: true, onClick: () => { const checked = checkbox.checked; closeModal(); onConfirm(checked); } },
  ]);
}

/** Renders a Preact tree into a fresh detached DOM node, for imperative
 *  `show*Modal()` call sites (help.tsx, studyModal.tsx, …) that need to pass
 *  real JSX content into showModal()'s `body: HTMLElement` param instead of
 *  building it with vanilla DOM — same idea as icons.tsx's iconElement(),
 *  but returning the wrapper itself (not just its first child) plus a
 *  cleanup to unmount the tree, since this content has its own state/effects
 *  (unlike a static icon). Pass `cleanup` as showModal()'s onDismiss —
 *  BodyMount only detaches the node when the modal closes, it doesn't know
 *  to unmount whatever Preact tree lives inside it. */
export function renderModalBody(node: ComponentChild): { el: HTMLElement; cleanup: () => void } {
  const el = document.createElement('div');
  render(node, el);
  return { el, cleanup: () => render(null, el) };
}

// ── Shell ────────────────────────────────────────────────────────────────────

/** Bridges a raw (vanilla-built) DOM node into the JSX tree — appended
 *  post-commit (useLayoutEffect, not useEffect) so it's there before the
 *  browser paints, same reasoning as sidebar.ts/trending.tsx's identical
 *  pattern: an effect-mounted node would flash in one frame late. */
function BodyMount({ el }: { el: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current!.appendChild(el);
    return () => { el.remove(); };
  }, [el]);
  return <div ref={ref} class="px-5 py-4 overflow-y-auto flex-1" />;
}

function IconMount({ el }: { el: Element }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => { ref.current!.appendChild(el); }, [el]);
  return <span ref={ref} class="inline-flex items-center" />;
}

const TITLE_CLASS = 'text-xs font-semibold text-muted uppercase tracking-widest truncate';

/** The header title, renamable in place when the modal asked for it (see
 *  ModalOptions.titleEdit). Module scope, not declared inside ModalDialog: a
 *  component defined during a render is a new type on every render, and its
 *  field would be torn down mid-typing. */
function ModalTitle({ title, titleEdit }: { title: string; titleEdit?: ModalOptions['titleEdit'] }) {
  const [draft, setDraft] = useState<string | null>(null);
  // Enter commits and unmounts the field, and the unmount blurs it: without
  // this, the blur would commit the same name a second time.
  const settled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  // Focused and selected on opening — `autoFocus` only works at page load.
  useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [editing]);
  if (!titleEdit) return <h2 class={TITLE_CLASS}>{title}</h2>;

  const { suffix, onCommit } = titleEdit;
  const base = suffix && title.endsWith(suffix) ? title.slice(0, -suffix.length) : title;
  if (draft === null) {
    return (
      <h2
        class={`${TITLE_CLASS} cursor-pointer hover:text-primary transition-colors`}
        title={t('common.clickToRename')}
        onClick={() => { settled.current = false; setDraft(base); }}
      >{title}</h2>
    );
  }
  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    setDraft(null);
    if (commit) onCommit(draft);
  };
  return (
    <div class="flex items-center gap-1 min-w-0 flex-1">
      <input
        ref={inputRef}
        class="input text-sm py-0.5 min-w-0 flex-1"
        value={draft}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true);
          // Marked handled, so the shell's Escape (main.ts) leaves the modal open.
          if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        }}
        onBlur={() => finish(true)}
      />
      {suffix && <span class="text-sm text-dim shrink-0">{suffix}</span>}
    </div>
  );
}

function ModalDialog({ entry }: { entry: ModalEntry }) {
  const mouseDownOnOverlay = useRef(false);
  // Local, so it dies with the dialog — see ModalOptions.expandable on why
  // this is not remembered. ModalHost keys on entry.id, so the state survives
  // every re-render of the stack and only that.
  const [expanded, setExpanded] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Not while expanded: the dialog is the whole page then, with no top to hold.
  const pinned = usePinnedTop(entry.pinTop && !expanded, overlayRef, dialogRef);
  const dismiss = () => {
    if (entry.guardDismiss?.(() => completeDismiss(entry))) return;
    completeDismiss(entry);
  };

  // Before the browser paints, not after: the body sizes itself against this,
  // and an effect-driven answer would show one frame at the wrong height.
  const notifyExpanded = entry.onExpandedChange;
  useLayoutEffect(() => { notifyExpanded?.(expanded); }, [expanded, notifyExpanded]);

  // No Escape listener here any more (2026-09-10). Every dialog used to run
  // its own, each re-deriving "am I the topmost?" from this stack — which was
  // right for modals and blind to everything else on screen: a lightbox over a
  // modal, a context menu over that. One listener in main.ts now asks the
  // overlay registry, which is the only thing that knows the real order, and
  // it lands back here through this modal's registered closer.

  return (
    <div
      ref={overlayRef}
      class={`fixed inset-0 z-50 flex ${pinned.overlayClass} justify-center bg-black/75 backdrop-blur-sm`}
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (entry.dismissable && e.target === e.currentTarget && mouseDownOnOverlay.current) dismiss(); }}
    >
      <div
        ref={dialogRef}
        class={`bg-elevated shadow-2xl overflow-hidden flex flex-col ${
          expanded ? 'w-full h-full safe-area-pad' : 'border border-border rounded-xl w-full mx-4'
        }`}
        style={expanded ? undefined : { maxWidth: `min(${modalMaxW(0.9)}, ${entry.maxWidth})`, maxHeight: modalMaxH(0.85), ...pinned.dialogStyle }}
        onPointerDownCapture={pinned.onPointerDownCapture}
        onKeyDownCapture={pinned.onKeyDownCapture}
      >
        <div class="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          {/* Same shape as the card export modal, which is the reference:
              arrow and title share a row, the title truncates, the arrow
              never shrinks. */}
          <div class="flex items-center gap-2 min-w-0">
            {entry.onBack && (
              <button
                class="text-dim hover:text-primary transition-colors cursor-pointer shrink-0"
                title={t('modal.back')}
                onClick={entry.onBack}
              >←</button>
            )}
            <ModalTitle title={entry.title} titleEdit={entry.titleEdit} />
          </div>
          <div class="flex items-center gap-3 shrink-0">
            {entry.headerActions.map((action, i) => (
              <button
                key={i}
                class="text-dim hover:text-primary transition-colors cursor-pointer flex items-center"
                title={action.title}
                onClick={action.onClick}
              >
                <IconMount el={action.icon} />
              </button>
            ))}
            {/* After the caller's own controls and before the ✕: those act on
                what is shown, these two act on the window itself. */}
            {entry.expandable && (
              <button
                class="text-dim hover:text-primary transition-colors cursor-pointer flex items-center"
                title={t(expanded ? 'modal.collapse' : 'modal.expand')}
                // Centred again on the way back: the held top was for the
                // dialog as it was before.
                onClick={() => { pinned.unpin(); setExpanded(e => !e); }}
              >
                {expanded ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
              </button>
            )}
            {entry.dismissable && (
              <button class="text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer" onClick={dismiss}>✕</button>
            )}
          </div>
        </div>

        <BodyMount el={entry.body} />

        {entry.actions.length > 0 && (
          <div class="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
            {entry.actions.map((action, i) => (
              <button
                key={i}
                class={(action.primary ? 'btn-primary' : action.danger ? 'btn-danger px-2' : 'btn-ghost') + (action.align === 'start' ? ' mr-auto' : '')}
                disabled={action.disabled?.value}
                onClick={async () => { await action.onClick(); }}
              >
                {action.icon && <IconMount el={action.icon} />}
                {action.label && <span>{action.label}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Mount once per Preact root — see this file's top doc for why there are
 *  two mount points (AppRoot + UserSelector). Renders nothing of its own
 *  when the stack is empty; portals every open modal into document.body
 *  when not, stacked in open order (topmost = most recently opened, matching
 *  the old array-as-stack behavior). */
export function ModalHost() {
  if (modalStack.value.length === 0) return null;
  return createPortal(
    <>{modalStack.value.map(entry => <ModalDialog key={entry.id} entry={entry} />)}</>,
    document.body,
  );
}
