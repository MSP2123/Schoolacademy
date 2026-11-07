package ua.academy.school;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.OutputStream;

/** Full-screen shell around the school diary web app. The icon, window colours and file saving are native. */
public class MainActivity extends Activity {

    private static final String HOME = "https://msp2123.github.io/Schoolacademy/";
    private static final String HOST = "msp2123.github.io";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // the app keeps its login and theme in localStorage
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.addJavascriptInterface(new Bridge(), "AndroidApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;         // stay inside the app
                try {                                                // Zoom, school site, test links... open outside
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                            + "<body style='font-family:sans-serif;text-align:center;padding:64px 24px;color:#46464F'>"
                            + "<h2>Немає з'єднання</h2><p>Перевірте інтернет і спробуйте ще раз.</p>"
                            + "<button style='font-size:17px;padding:12px 24px;border:0;border-radius:24px;background:#4355B9;color:#fff' "
                            + "onclick=\"location.href='" + HOME + "'\">Спробувати знову</button></body></html>";
                    view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
                }
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(HOME);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    /** Methods the web page can call as window.AndroidApp.* */
    private class Bridge {

        /** Save a file the page produced (blob downloads do not work in a WebView) to Downloads. */
        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime);
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                Uri item = getContentResolver().insert(collection, v);
                if (item == null) throw new IllegalStateException("insert failed");
                try (OutputStream out = getContentResolver().openOutputStream(item)) {
                    out.write(data);
                }
                v.clear();
                v.put(MediaStore.Downloads.IS_PENDING, 0);
                getContentResolver().update(item, v, null, null);
                toast("Збережено в «Завантаження»: " + name);
            } catch (Exception e) {
                toast("Не вдалося зберегти файл");
            }
        }

        /** Match the system bars to the app theme (status bar = page background, navigation bar = tab bar). */
        @JavascriptInterface
        public void setBars(final String bg, final String nav, final boolean dark) {
            runOnUiThread(new Runnable() {
                @Override @SuppressWarnings("deprecation")
                public void run() {
                    try {
                        int bgC = Color.parseColor(bg), navC = Color.parseColor(nav);
                        getWindow().setStatusBarColor(bgC);
                        getWindow().setNavigationBarColor(navC);
                        web.setBackgroundColor(bgC);
                        int flags = getWindow().getDecorView().getSystemUiVisibility();
                        if (dark) {
                            flags &= ~(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
                        } else {
                            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                        }
                        getWindow().getDecorView().setSystemUiVisibility(flags);
                    } catch (Exception ignored) { }
                }
            });
        }

        private void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override public void run() { Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show(); }
            });
        }
    }
}
