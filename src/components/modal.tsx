import { signal, type Signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { render } from 'preact';
import type { ComponentChild } from 'preact';
import { t } from '../services/i18nService';
import { focusIfDesktop } from '../utils';
import { modalMaxH, modalMaxW } from '../services/zoomService';

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

interface ModalEntry {
  id: number;
  title: string;
  body: HTMLElement;
  actions: ModalAction[];
  dismissable: boolean;
  maxWidth: string;
  onDismiss?: () => void;
  headerAction?: ModalHeaderAction;
}

let nextId = 0;
const modalStack = signal<ModalEntry[]>([]);

export function closeModal(): void {
  modalStack.value = modalStack.value.slice(0, -1);
}

/** Pops the whole stack, running every entry's `onDismiss`. For the rare
 *  action inside a modal that navigates elsewhere: popping one would leave the
 *  dialogs below it hanging over a view they have nothing to do with. */
export function closeAllModals(): void {
  const open = modalStack.value;
  modalStack.value = [];
  for (const entry of open) entry.onDismiss?.();
}

export function showModal(
  title: string, body: HTMLElement, actions: ModalAction[], dismissable = true, maxWidth = '28rem',
  onDismiss?: () => void, headerAction?: ModalHeaderAction,
): void {
  modalStack.value = [...modalStack.value, { id: nextId++, title, body, actions, dismissable, maxWidth, onDismiss, headerAction }];
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
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') closeModal(); });
  showModal(title, body, [{ label: t('common.cancel'), onClick: closeModal }, { label: t('common.confirm'), primary: true, onClick: confirm }]);
  focusIfDesktop(input);
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

function ModalDialog({ entry }: { entry: ModalEntry }) {
  const mouseDownOnOverlay = useRef(false);
  const dismiss = () => { closeModal(); entry.onDismiss?.(); };

  // Escape closes only the TOPMOST modal — checked fresh on every keydown
  // (not captured once) since another modal can open/close while this one
  // is still mounted, changing who's actually on top.
  useEffect(() => {
    if (!entry.dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const top = modalStack.value[modalStack.value.length - 1];
      if (top?.id === entry.id) dismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line
  }, [entry.id, entry.dismissable]);

  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (entry.dismissable && e.target === e.currentTarget && mouseDownOnOverlay.current) dismiss(); }}
    >
      <div
        class="bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 overflow-hidden flex flex-col"
        style={{ maxWidth: `min(${modalMaxW(0.9)}, ${entry.maxWidth})`, maxHeight: modalMaxH(0.85) }}
      >
        <div class="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 class="text-xs font-semibold text-muted uppercase tracking-widest truncate">{entry.title}</h2>
          <div class="flex items-center gap-3 shrink-0">
            {entry.headerAction && (
              <button
                class="text-dim hover:text-primary transition-colors cursor-pointer flex items-center"
                title={entry.headerAction.title}
                onClick={entry.headerAction.onClick}
              >
                <IconMount el={entry.headerAction.icon} />
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
