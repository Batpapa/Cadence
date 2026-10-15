// ── Picking files from the device, back in the folder used last (2026-10-15) ─
// A tester adding MP3s from a laptop had to walk down the same five folders
// every time. The File System Access picker remembers the last folder per
// `id` on its own — Chrome, Edge, Brave on a computer. Everywhere else (Firefox,
// Safari, every phone, the Android app's WebView) it does not exist, and the
// plain file input opens wherever the system decides, as before.

/** Each use its own memory: the folder of the recordings is not the folder of
 *  the scores. */
export type PickerId = 'attachments' | 'analysis-import';

/** The few members of the picker used here — not in TypeScript's DOM types. */
type OpenFilePicker = (opts: {
  id?: string;
  multiple?: boolean;
  startIn?: 'music' | 'documents' | 'downloads' | 'desktop';
}) => Promise<{ getFile: () => Promise<File> }[]>;

/** The files chosen, none when the picker was closed. Call it from the
 *  gesture: both pickers need one. */
export async function pickFiles(opts: {
  id: PickerId;
  multiple?: boolean;
  /** Where the picker opens before it has a folder to remember. */
  startIn?: 'music';
}): Promise<File[]> {
  const native = (window as unknown as { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker;
  if (native) {
    try {
      const handles = await native({ id: opts.id, multiple: opts.multiple ?? false, startIn: opts.startIn });
      return await Promise.all(handles.map(h => h.getFile()));
    } catch (e) {
      // Closed without a choice.
      if (e instanceof DOMException && e.name === 'AbortError') return [];
      // Refused (a frame, a policy): the plain input below, which may still
      // open while the gesture lasts.
      console.warn('[filePicker] falling back to the file input', e);
    }
  }
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = opts.multiple ?? false;
    inp.onchange = () => resolve(Array.from(inp.files ?? []));
    // Closed without a choice: nothing will ever arrive. Not every browser
    // fires it, and an unsettled promise holds nothing.
    inp.addEventListener('cancel', () => resolve([]));
    inp.click();
  });
}
