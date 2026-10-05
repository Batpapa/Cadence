import { registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { arrayBufferToBase64 } from '../utils';

/**
 * The Android app's "download": a WebView ignores `<a download>` on a blob:
 * URL, so the file is written to the app's cache and handed to the system's
 * save dialog (android/…/FileExportPlugin.java).
 *
 * Written in chunks because everything crossing the bridge is a base64 string:
 * a three-hour recording in one call would need its size several times over
 * in memory, on phones where that is exactly what runs out. 3 MiB is a
 * multiple of 3, so every chunk encodes without padding — not required, since
 * each append is decoded on its own, but it keeps the chunks honest.
 *
 * Imported dynamically, and only when isNative().
 */
interface FileExportPlugin {
  saveAs(options: { path: string; filename: string; mimeType: string }): Promise<{ saved: boolean }>;
}

const FileExport = registerPlugin<FileExportPlugin>('FileExport');

const CHUNK_BYTES = 3 * 1024 * 1024;

/** Resolves true once saved, false if the user dismissed the dialog. */
export async function saveBlobNative(blob: Blob, filename: string): Promise<boolean> {
  const path = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    // The first write creates (or truncates) the file, even for an empty blob.
    await Filesystem.writeFile({
      path, directory: Directory.Cache,
      data: arrayBufferToBase64(await blob.slice(0, CHUNK_BYTES).arrayBuffer()),
    });
    for (let offset = CHUNK_BYTES; offset < blob.size; offset += CHUNK_BYTES) {
      await Filesystem.appendFile({
        path, directory: Directory.Cache,
        data: arrayBufferToBase64(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer()),
      });
    }
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    // The plugin deletes the cached copy whatever happens from here.
    const { saved } = await FileExport.saveAs({
      path: uri, filename, mimeType: blob.type || 'application/octet-stream',
    });
    return saved;
  } catch (err) {
    await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => { /* never written */ });
    throw err;
  }
}
