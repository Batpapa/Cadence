package io.github.batpapa.cadence;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins must be registered before the bridge is built.
        registerPlugin(GoogleDriveAuthPlugin.class);
        registerPlugin(LiveRendererPlugin.class);
        registerPlugin(FileExportPlugin.class);
        registerPlugin(LiveNotificationPlugin.class);
        registerPlugin(PullToRefreshPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
