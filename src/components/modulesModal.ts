import type { AppContext } from '../types';
import { t } from '../services/i18nService';
import { modalMaxW, modalMaxH } from '../services/zoomService';
import { iconElement, WaveformIcon } from './icons';
import { renderSessionModule, isSessionRecording } from '../session/ui/sessionModule';

type Screen = 'list' | 'sessions';

export function showModulesModal(ctx: AppContext): void {
  // Land straight on the live screen when a recording is running in the background.
  let screen: Screen = isSessionRecording() ? 'sessions' : 'list';

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm';

  const dialog = document.createElement('div');
  dialog.className = 'bg-elevated border border-border rounded-xl shadow-2xl w-full mx-4 overflow-hidden flex flex-col';
  dialog.style.maxWidth = `min(${modalMaxW(0.9)}, 30rem)`;
  dialog.style.maxHeight = modalMaxH(0.85);

  const header = document.createElement('div');
  header.className = 'flex items-center justify-between px-5 py-4 border-b border-border shrink-0';

  const body = document.createElement('div');
  body.className = 'px-5 py-4 overflow-y-auto flex-1';

  const cleanups: (() => void)[] = [];

  const close = () => {
    cleanups.forEach(fn => fn());
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  let mouseDownOnOverlay = false;
  overlay.addEventListener('mousedown', e => { mouseDownOnOverlay = e.target === overlay; });
  overlay.addEventListener('click', e => { if (e.target === overlay && mouseDownOnOverlay) close(); });

  const makeCloseBtn = () => {
    const btn = document.createElement('button');
    btn.className = 'text-dim hover:text-primary transition-colors text-lg leading-none cursor-pointer';
    btn.textContent = '✕';
    btn.onclick = close;
    return btn;
  };

  const render = () => {
    header.innerHTML = '';
    body.innerHTML = '';
    if (screen === 'sessions') {
      renderSessionModule({
        header, body, ctx,
        onBack: () => { screen = 'list'; render(); },
        closeModal: close,
        makeCloseBtn,
        registerCleanup: fn => cleanups.push(fn),
      });
    } else {
      renderList();
    }
  };

  // ── Module list ───────────────────────────────────────────────────────────

  const renderList = () => {
    const titleEl = document.createElement('h2');
    titleEl.className = 'text-xs font-semibold text-muted uppercase tracking-widest';
    titleEl.textContent = t('modules.title');
    header.append(titleEl, makeCloseBtn());

    const card = document.createElement('button');
    card.className = 'w-full text-left p-4 rounded-lg border border-border bg-bg hover:border-accent/50 hover:bg-accent/5 transition-colors cursor-pointer flex items-center gap-3';
    card.onclick = () => { screen = 'sessions'; render(); };

    const iconWrap = document.createElement('div');
    iconWrap.className = 'w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 text-accent';
    iconWrap.appendChild(iconElement(WaveformIcon, 20));

    const textArea = document.createElement('div');
    textArea.className = 'flex-1 min-w-0';

    const cardTitle = document.createElement('div');
    cardTitle.className = 'text-sm font-semibold text-primary mb-0.5 flex items-center gap-2';
    cardTitle.textContent = t('sessions.moduleTitle');
    if (isSessionRecording()) {
      const dot = document.createElement('span');
      dot.className = 'w-2 h-2 rounded-full bg-danger animate-pulse inline-block';
      cardTitle.appendChild(dot);
    }

    const cardDesc = document.createElement('div');
    cardDesc.className = 'text-xs text-muted';
    cardDesc.textContent = t('sessions.moduleDesc');

    textArea.append(cardTitle, cardDesc);
    card.append(iconWrap, textArea);
    body.appendChild(card);
  };

  dialog.append(header, body);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  render();
}
