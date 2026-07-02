export function mkCustomSelect(
  opts: Array<{ value: string; label: string }>,
  initial: string,
  onChange: (v: string) => void,
  triggerClass: string,
): { el: HTMLElement; getValue: () => string } {
  let selected = initial;
  let isOpen = false;

  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.style.flex = '1';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = triggerClass;

  const labelSpan = document.createElement('span');
  labelSpan.style.cssText = 'flex:1; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';

  const chevron = document.createElement('span');
  chevron.style.cssText = 'display:flex; align-items:center; flex-shrink:0; transition:transform 0.15s;';
  chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  trigger.append(labelSpan, chevron);

  const dropdown = document.createElement('div');
  dropdown.className = 'absolute left-0 top-full z-40 mt-1 bg-elevated border border-border rounded-lg shadow-xl py-1 min-w-full max-h-52 overflow-y-auto';
  dropdown.style.display = 'none';

  const renderLabel = () => {
    labelSpan.textContent = opts.find(o => o.value === selected)?.label ?? '';
  };

  const renderItems = () => {
    dropdown.innerHTML = '';
    for (const opt of opts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `w-full text-left px-3 py-1.5 text-sm cursor-pointer truncate ${opt.value === selected ? 'text-accent bg-accent/5' : 'text-muted hover:bg-surface'}`;
      btn.textContent = opt.label;
      btn.onclick = () => {
        selected = opt.value;
        close();
        renderLabel();
        renderItems();
        onChange(selected);
      };
      dropdown.appendChild(btn);
    }
  };

  const open = () => { isOpen = true; dropdown.style.display = 'block'; chevron.style.transform = 'rotate(180deg)'; };
  const close = () => { isOpen = false; dropdown.style.display = 'none'; chevron.style.transform = ''; };

  trigger.onclick = (e) => { e.stopPropagation(); isOpen ? close() : open(); };

  const onOutside = (e: MouseEvent) => {
    if (!wrap.isConnected) { document.removeEventListener('mousedown', onOutside); return; }
    if (!wrap.contains(e.target as Node)) close();
  };
  document.addEventListener('mousedown', onOutside);

  renderLabel();
  renderItems();
  wrap.append(trigger, dropdown);
  return { el: wrap, getValue: () => selected };
}
