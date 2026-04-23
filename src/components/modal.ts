import { t } from '../services/i18nService';
import { focusIfDesktop } from '../utils';

export interface ModalAction {
  label: string;
  primary?: boolean;
  danger?: boolean;
  icon?: SVGSVGElement;
  align?: 'start';
  onClick: () => void | Promise<void>;
}

let activeModal: HTMLElement | null = null;

export function closeModal(): void {
  if (activeModal) { activeModal.remove(); activeModal = null; }
}

export function showModal(title: string, body: HTMLElement, actions: ModalAction[]): void {
  closeModal();

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden flex flex-col max-h-[85vh]';

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-4 border-b border-border shrink-0';

  const titleEl = document.createElement('h2');
  titleEl.className = 'text-xs font-semibold text-muted uppercase tracking-widest';
  titleEl.textContent = title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer';
  closeBtn.textContent = '✕';
  closeBtn.onclick = closeModal;
  header.append(titleEl, closeBtn);

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'px-5 py-4 overflow-y-auto flex-1';
  bodyWrap.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'flex items-center gap-2 px-5 py-4 border-t border-border shrink-0';

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = (action.primary ? 'btn-primary' : action.danger ? 'btn-danger px-2' : 'btn-ghost')
      + (action.align === 'start' ? ' mr-auto' : '');
    if (action.icon) {
      btn.appendChild(action.icon);
      if (action.label) { const lbl = document.createElement('span'); lbl.textContent = action.label; btn.appendChild(lbl); }
    } else {
      btn.textContent = action.label;
    }
    btn.onclick = async () => { await action.onClick(); };
    footer.appendChild(btn);
  }

  dialog.append(header, bodyWrap, footer);
  overlay.appendChild(dialog);
  let mouseDownOnOverlay = false;
  overlay.addEventListener('mousedown', (e) => { mouseDownOnOverlay = e.target === overlay; });
  overlay.onclick = (e) => { if (e.target === overlay && mouseDownOnOverlay) closeModal(); };
  document.body.appendChild(overlay);
  activeModal = overlay;
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

