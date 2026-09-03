import { getZoom } from '../services/zoomService';

/** Height the list is allowed before it prefers to open upwards. */
const DROPDOWN_MAX_H = 208; // matches max-h-52

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

  // Fixed and parented to <body>, not absolute inside the trigger: this select
  // is used inside the modal shell, whose dialog clips (`overflow-hidden`) and
  // whose body scrolls. An absolutely-positioned list was cut off there, so
  // reaching the far end of it meant scrolling the modal itself.
  const dropdown = document.createElement('div');
  dropdown.className = 'fixed z-[100] bg-elevated border border-border rounded-lg shadow-xl py-1 max-h-52 overflow-y-auto';
  dropdown.style.display = 'none';

  /** Anchors the list under the trigger, flipping above when the bottom of the
   *  window is nearer than the list is tall. Coordinates are divided by the
   *  zoom: CSS zoom on <html> scales what getBoundingClientRect reports, while
   *  a fixed element is positioned in unscaled pixels (see zoomService). */
  const place = () => {
    const z = getZoom() / 100;
    const r = trigger.getBoundingClientRect();
    const left = r.left / z;
    const width = r.width / z;
    const top = r.bottom / z;
    const bottom = r.top / z;
    const viewportH = window.innerHeight / z;

    dropdown.style.left = `${left}px`;
    dropdown.style.width = `${width}px`;
    if (viewportH - top < DROPDOWN_MAX_H && bottom > viewportH - bottom) {
      dropdown.style.top = '';
      dropdown.style.bottom = `${viewportH - bottom + 4}px`;
      dropdown.style.maxHeight = `${Math.max(80, bottom - 8)}px`;
    } else {
      dropdown.style.bottom = '';
      dropdown.style.top = `${top + 4}px`;
      dropdown.style.maxHeight = `${Math.max(80, viewportH - top - 8)}px`;
    }
  };

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

  const open = () => {
    isOpen = true;
    document.body.appendChild(dropdown);
    dropdown.style.display = 'block';
    place();
    chevron.style.transform = 'rotate(180deg)';
    // A fixed list would otherwise stay put while its trigger scrolled away
    // underneath, so it is re-anchored rather than closed. Closing was the
    // first answer and it was wrong: a score playing back scrolls itself to
    // follow the cursor, which shut the list under the user's hand.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
  };
  const close = () => {
    isOpen = false;
    dropdown.style.display = 'none';
    dropdown.remove();
    chevron.style.transform = '';
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place);
  };

  trigger.onclick = (e) => { e.stopPropagation(); isOpen ? close() : open(); };

  const onOutside = (e: MouseEvent) => {
    if (!wrap.isConnected) { close(); document.removeEventListener('mousedown', onOutside); return; }
    if (!wrap.contains(e.target as Node) && !dropdown.contains(e.target as Node)) close();
  };
  document.addEventListener('mousedown', onOutside);

  renderLabel();
  renderItems();
  wrap.append(trigger);
  return { el: wrap, getValue: () => selected };
}
