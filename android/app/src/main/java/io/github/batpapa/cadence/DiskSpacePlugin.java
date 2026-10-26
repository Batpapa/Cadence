package io.github.batpapa.cadence;

import android.os.StatFs;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The free space of the partition the WebView keeps Cadence's data on.
 *
 * 2026-10-25: a tester's phone, at about 3 GB free, lost Cadence's whole
 * IndexedDB, with no warning from Android. Chromium evicts an origin once
 * free space falls under 2 GiB, and in the app Cadence is the only origin, so
 * all of it goes. The page cannot see this coming: navigator.storage.estimate()
 * reports a made-up quota (usage + 10 GiB) whatever the disk holds.
 *
 * StatFs.getAvailableBytes() is statvfs's f_bavail, the very figure Chromium
 * compares to its threshold (base::SysInfo::AmountOfFreeDiskSpace), read on the
 * same partition: the app's files directory and the WebView's data both live
 * under /data. No permission is needed for it on Android.
 */
@CapacitorPlugin(name = "DiskSpace")
public class DiskSpacePlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        try {
            StatFs stat = new StatFs(getContext().getFilesDir().getAbsolutePath());
            JSObject ret = new JSObject();
            ret.put("free", stat.getAvailableBytes());
            ret.put("total", stat.getTotalBytes());
            call.resolve(ret);
        } catch (IllegalArgumentException e) {
            call.reject("statfs failed", e);
        }
    }
}
