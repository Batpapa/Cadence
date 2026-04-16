export interface ModalAction {
  label: string;
  primary?: boolean;
  danger?: boolean;
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
  footer.className = 'flex justify-end gap-2 px-5 py-4 border-t border-border shrink-0';

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.className = action.primary ? 'btn-primary' : action.danger ? 'btn-danger' : 'btn-ghost';
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
  showModal(title, body, [{ label: 'Cancel', onClick: closeModal }, { label: 'Confirm', primary: true, onClick: confirm }]);
  setTimeout(() => input.focus(), 30);
}

export function confirmModal(title: string, message: string, confirmLabel: string, onConfirm: () => void): void {
  const body = document.createElement('p');
  body.className = 'text-sm text-muted leading-relaxed';
  body.textContent = message;
  showModal(title, body, [
    { label: 'Cancel', onClick: closeModal },
    { label: confirmLabel, danger: true, onClick: () => { closeModal(); onConfirm(); } },
  ]);
}

export function formModal(
  title: string,
  fields: Array<{ label: string; id: string; type?: string; value?: string; min?: string; max?: string; step?: string }>,
  onConfirm: (values: Record<string, string>) => void
): void {
  const body = document.createElement('div');
  body.className = 'space-y-3';
  const inputs: Record<string, HTMLInputElement> = {};
  for (const field of fields) {
    const wrap = document.createElement('div');
    const lbl = document.createElement('label');
    lbl.className = 'label';
    lbl.textContent = field.label;
    const input = document.createElement('input');
    input.type = field.type ?? 'text';
    input.value = field.value ?? '';
    input.className = 'input';
    if (field.min)  input.min  = field.min;
    if (field.max)  input.max  = field.max;
    if (field.step) input.step = field.step;
    inputs[field.id] = input;
    wrap.append(lbl, input);
    body.appendChild(wrap);
  }
  const confirm = () => {
    const values: Record<string, string> = {};
    for (const [id, input] of Object.entries(inputs)) values[id] = input.value.trim();
    if (Object.values(values).some(v => !v)) return;
    closeModal();
    onConfirm(values);
  };
  Object.values(inputs).forEach(i => {
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') closeModal(); });
  });
  showModal(title, body, [{ label: 'Cancel', onClick: closeModal }, { label: 'Confirm', primary: true, onClick: confirm }]);
  setTimeout(() => Object.values(inputs)[0]?.focus(), 30);
}
