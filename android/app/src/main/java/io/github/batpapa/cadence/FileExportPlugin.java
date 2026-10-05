package io.github.batpapa.cadence;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * "Save as" for the app's downloads: a WebView does nothing with an
 * `<a download>` pointing at a blob: URL, so every export used to vanish.
 *
 * The page writes the file into the app's cache first, in chunks (see
 * src/native/saveFile.ts — a recording of several hours cannot cross the
 * bridge in one piece), then hands its path here. This opens Android's own
 * save dialog (Storage Access Framework: no storage permission, the user picks
 * the folder, Downloads by default) and copies the file there natively. The
 * cached copy is deleted either way.
 */
@CapacitorPlugin(name = "FileExport")
public class FileExportPlugin extends Plugin {

    private ActivityResultLauncher<Intent> saveLauncher;
    private PluginCall pendingCall;
    private File pendingFile;

    @Override
    public void load() {
        saveLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(),
            this::onSaveResult
        );
    }

    /** { path (file:// URI in the cache), filename, mimeType } → { saved } */
    @PluginMethod
    public void saveAs(PluginCall call) {
        String path = call.getString("path");
        String filename = call.getString("filename", "cadence");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        File file = path == null ? null : new File(Uri.parse(path).getPath());
        if (file == null || !file.exists()) {
            call.reject("missing_file", "missing_file");
            return;
        }
        if (pendingCall != null) {
            file.delete();
            call.reject("busy", "busy");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        pendingCall = call;
        pendingFile = file;
        saveLauncher.launch(intent);
    }

    private void onSaveResult(ActivityResult result) {
        PluginCall call = pendingCall;
        File file = pendingFile;
        pendingCall = null;
        pendingFile = null;
        if (call == null || file == null) return;

        Uri target = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || target == null) {
            file.delete();
            JSObject ret = new JSObject();
            ret.put("saved", false);
            call.resolve(ret);
            return;
        }
        // Off the main thread: a long recording is hundreds of megabytes.
        new Thread(() -> {
            try (
                InputStream in = new FileInputStream(file);
                OutputStream out = getContext().getContentResolver().openOutputStream(target)
            ) {
                if (out == null) throw new java.io.IOException("no output stream");
                byte[] buffer = new byte[1 << 16];
                int n;
                while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
                JSObject ret = new JSObject();
                ret.put("saved", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(String.valueOf(e.getMessage()), "write_failed", e);
            } finally {
                file.delete();
            }
        }).start();
    }
}
