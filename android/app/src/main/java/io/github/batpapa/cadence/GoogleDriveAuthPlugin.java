package io.github.batpapa.cadence;

import android.accounts.Account;
import android.app.Activity;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationClient;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.auth.api.identity.RevokeAccessRequest;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import java.util.Collections;
import java.util.List;

/**
 * Google Drive access tokens for the Android app, through Google Play services'
 * AuthorizationClient — the replacement for GIS's popup, which cannot work in a
 * WebView (its token comes back by postMessage to an opener the WebView does
 * not have).
 *
 * The point of the whole exercise: once the user has granted the scope, every
 * later authorize() returns a fresh token WITHOUT any UI. No refresh token, no
 * backend, no client secret — Play services holds the grant, and the app is
 * identified by its package name and signing certificate (the Android OAuth
 * client in the Cloud project).
 *
 * Errors use the codes driveService already reasons about:
 *   - "needs_auth"   a silent call found no grant; only a gesture can ask;
 *   - "popup_closed" the consent screen was dismissed;
 *   - "access_denied" consent finished without the Drive scope.
 */
@CapacitorPlugin(name = "GoogleDriveAuth")
public class GoogleDriveAuthPlugin extends Plugin {

    private static final String DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
    private static final List<Scope> SCOPES = Collections.singletonList(new Scope(DRIVE_FILE));

    private ActivityResultLauncher<IntentSenderRequest> consentLauncher;
    /** The interactive call waiting on the consent screen. One at a time:
     *  driveService already funnels every request through a single in-flight
     *  promise, so a second one here would be a bug upstream. */
    private PluginCall pendingConsent;

    @Override
    public void load() {
        // Registered here because load() runs during the activity's onCreate —
        // the only time an activity-result launcher may be registered.
        consentLauncher = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(),
            this::onConsentResult
        );
    }

    private AuthorizationClient client() {
        return Identity.getAuthorizationClient(getActivity());
    }

    private static Account account(String email) {
        return email == null || email.isEmpty() ? null : new Account(email, "com.google");
    }

    /** { interactive?: boolean, account?: string, selectAccount?: boolean } → { accessToken }
     *
     *  `selectAccount` is the explicit Connect: without it Play services quietly
     *  reuses whichever account was granted last, so a second local user — or
     *  the welcome screen's recovery — could never pick another one. */
    @PluginMethod
    public void authorize(PluginCall call) {
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", false));
        boolean selectAccount = interactive && Boolean.TRUE.equals(call.getBoolean("selectAccount", false));
        AuthorizationRequest.Builder builder = AuthorizationRequest.builder().setRequestedScopes(SCOPES);
        if (selectAccount) {
            builder.setPrompt(AuthorizationRequest.Prompt.SELECT_ACCOUNT);
        } else {
            Account account = account(call.getString("account"));
            if (account != null) builder.setAccount(account);
        }

        client()
            .authorize(builder.build())
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    resolveWith(call, result);
                    return;
                }
                if (!interactive) {
                    call.reject("needs_auth", "needs_auth");
                    return;
                }
                if (pendingConsent != null) {
                    call.reject("busy", "busy");
                    return;
                }
                pendingConsent = call;
                consentLauncher.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
            })
            .addOnFailureListener(e -> call.reject(String.valueOf(e.getMessage()), "auth_error", e));
    }

    private void onConsentResult(ActivityResult activityResult) {
        PluginCall call = pendingConsent;
        pendingConsent = null;
        if (call == null) return;
        if (activityResult.getResultCode() != Activity.RESULT_OK || activityResult.getData() == null) {
            call.reject("popup_closed", "popup_closed");
            return;
        }
        try {
            resolveWith(call, client().getAuthorizationResultFromIntent(activityResult.getData()));
        } catch (ApiException e) {
            call.reject("popup_closed", "popup_closed", e);
        }
    }

    private void resolveWith(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        // Granular consent lets the user untick Drive and still "succeed".
        boolean granted = result.getGrantedScopes() != null && result.getGrantedScopes().contains(DRIVE_FILE);
        if (token == null || !granted) {
            call.reject("access_denied", "access_denied");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("accessToken", token);
        call.resolve(ret);
    }

    /** { token } — drops a token Drive rejected from Play services' cache, so
     *  the next authorize() mints a new one instead of handing it back. */
    @PluginMethod
    public void clearToken(PluginCall call) {
        String token = call.getString("token");
        if (token == null) {
            call.resolve();
            return;
        }
        client()
            .clearToken(ClearTokenRequest.builder().setToken(token).build())
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject(String.valueOf(e.getMessage()), "auth_error", e));
    }

    /** { account? } — the Disconnect button: the next connect asks consent again. */
    @PluginMethod
    public void revoke(PluginCall call) {
        RevokeAccessRequest.Builder builder = RevokeAccessRequest.builder().setScopes(SCOPES);
        Account account = account(call.getString("account"));
        if (account != null) builder.setAccount(account);
        client()
            .revokeAccess(builder.build())
            .addOnSuccessListener(v -> call.resolve())
            .addOnFailureListener(e -> call.reject(String.valueOf(e.getMessage()), "auth_error", e));
    }
}
