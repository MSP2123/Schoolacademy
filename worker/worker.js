/**
 * school.academy.com.ua CORS proxy - Cloudflare Worker
 *
 * Stateless: never stores passwords or sessions. Each request from the
 * browser carries what it needs (credentials for /login, or a session
 * cookie for /daybook and /feed), and this worker just forwards it to
 * school.academy.com.ua and relays the response back with CORS headers
 * added so the browser is allowed to read it.
 *
 * v5: fixes vs v4-debug, based on diffing against the working Python
 * prototype (school_client.py):
 *   - SCHOOL_BASE was missing from this file entirely - added back.
 *   - Now keeps the FULL cookie jar (every Set-Cookie, not just
 *     a_school_session/XSRF-TOKEN), same as requests.Session() does.
 *   - Chases the post-login redirect manually (Workers' automatic
 *     `redirect: "follow"` hides intermediate Set-Cookie headers), and
 *     merges in any cookies set along the way - mirrors
 *     requests.post(..., allow_redirects=True).
 *   - Sends a consistent desktop Chrome User-Agent on every outbound
 *     request (login page, auth, and data calls) - Workers' default UA
 *     looks nothing like a browser.
 *   - Sends X-Requested-With: XMLHttpRequest + Referer on every request,
 *     which is what commonly makes Laravel-style apps return JSON auth
 *     errors instead of redirecting, and can affect how the auth guard
 *     resolves the session.
 *   - Auto-injects the `timestamp` query param the data endpoints expect,
 *     if the caller didn't already supply one.
 *
 * Deploy: paste this into a new Worker in the Cloudflare dashboard
 * (Workers & Pages -> Create -> "Hello World" template -> replace all code).
 */

const WORKER_VERSION = "v10";

const SCHOOL_BASE = "https://school.academy.com.ua";

// Match the Python prototype's UA so the school server sees consistent
// browser-like requests across the whole login -> data flow.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Session-Cookie",
};

function withCors(response) {
  const newHeaders = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    newHeaders.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}

function jsonResponse(obj, status = 200) {
  return withCors(
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

function extractCsrfToken(html) {
  // Tolerant: any <input|meta ...> tag mentioning _token / csrf-token, any
  // attribute order, single or double quotes.
  const tags = html.match(/<(?:input|meta)\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/name\s*=\s*["']?(?:_token|csrf-token)["']?/i.test(tag)) continue;
    const m = tag.match(/(?:value|content)\s*=\s*["']([^"']+)["']/i);
    if (m) return m[1];
  }
  const js = html.match(/csrf[-_]?token["']?\s*[:=]\s*["']([A-Za-z0-9]{20,})["']/i);
  return js ? js[1] : null;
}

// Returns every Set-Cookie header as an array of "name=value" strings,
// same shape as what requests.Session() accumulates internally.
function extractAllCookies(response) {
  let setCookieHeaders = [];
  if (typeof response.headers.getSetCookie === "function") {
    setCookieHeaders = response.headers.getSetCookie();
  } else {
    const single = response.headers.get("set-cookie");
    if (single) setCookieHeaders = [single];
  }
  return setCookieHeaders
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean);
}

// Merge new cookie pairs into an existing jar (object keyed by name),
// letting new values overwrite old ones for the same name - mirrors
// how a real cookie jar updates on each response.
function mergeCookies(jar, cookiePairs) {
  for (const pair of cookiePairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq);
    jar[name] = pair;
  }
  return jar;
}

function jarToCookieHeader(jar) {
  return Object.values(jar).join("; ");
}

// Plain browser-like headers (what the Python client sends). Used for the
// login page + auth: adding X-Requested-With there makes the school answer
// 401 JSON instead of the login page.
function commonSchoolHeaders(extra = {}) {
  return {
    "User-Agent": USER_AGENT,
    ...extra,
  };
}

// XHR-style headers, only for the JSON data endpoints.
function xhrSchoolHeaders(extra = {}) {
  return commonSchoolHeaders({
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${SCHOOL_BASE}/`,
    ...extra,
  });
}

async function handleLogin(request) {
  const { email, password, remember } = await request.json();

  if (!email || !password) {
    return jsonResponse({ error: "email and password are required" }, 400);
  }

  const jar = {};

  // Step 1: get login page for a fresh CSRF token + initial cookies
  const loginPageResp = await fetch(`${SCHOOL_BASE}/login`, {
    headers: commonSchoolHeaders(),
  });
  const loginPageHtml = await loginPageResp.text();
  const token = extractCsrfToken(loginPageHtml);

  if (!token) {
    return jsonResponse(
      {
        error:
          "Could not find CSRF token on login page. [" + WORKER_VERSION +
          "] status=" + loginPageResp.status +
          " server=" + (loginPageResp.headers.get("server") || "?") +
          " len=" + loginPageHtml.length +
          " url=" + loginPageResp.url +
          " body=" + loginPageHtml.slice(0, 400).replace(/\s+/g, " "),
        worker_version: WORKER_VERSION,
        debug_status: loginPageResp.status,
        debug_final_url: loginPageResp.url,
        debug_content_type: loginPageResp.headers.get("content-type") || "",
        debug_server: loginPageResp.headers.get("server") || "",
        debug_length: loginPageHtml.length,
        debug_body_snippet: loginPageHtml.slice(0, 600),
      },
      502
    );
  }

  mergeCookies(jar, extractAllCookies(loginPageResp));

  // Step 2: submit credentials
  const form = new URLSearchParams();
  form.set("_token", token);
  form.set("email", email);
  form.set("password", password);
  form.set("remember", remember ? "on" : "");
  form.set("login", "");

  const authResp = await fetch(`${SCHOOL_BASE}/auth`, {
    method: "POST",
    headers: commonSchoolHeaders({
      Origin: SCHOOL_BASE,
      Referer: `${SCHOOL_BASE}/login`,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: jarToCookieHeader(jar),
    }),
    body: form.toString(),
    redirect: "manual", // inspect the redirect response's cookies before following it
  });

  mergeCookies(jar, extractAllCookies(authResp));

  // Step 3: if Laravel redirected us (normal post-login behavior), chase
  // that redirect manually so we don't miss any cookies it sets along the
  // way (e.g. session regeneration after auth) - this is what
  // requests.Session(allow_redirects=True) does for you automatically.
  const location = authResp.headers.get("location");
  if (authResp.status >= 300 && authResp.status < 400 && location) {
    const redirectUrl = location.startsWith("http")
      ? location
      : `${SCHOOL_BASE}${location.startsWith("/") ? "" : "/"}${location}`;
    const followResp = await fetch(redirectUrl, {
      headers: commonSchoolHeaders({ Cookie: jarToCookieHeader(jar) }),
      redirect: "manual",
    });
    mergeCookies(jar, extractAllCookies(followResp));
  }

  if (!jar["a_school_session"]) {
    return jsonResponse(
      {
        error: "Login failed - no session cookie received. Check credentials.",
        debug_jar_keys: Object.keys(jar),
      },
      401
    );
  }

  // Hand the FULL cookie jar back to the browser, not just two names.
  // The browser stores this string and resends it verbatim via
  // X-Session-Cookie on later requests.
  return jsonResponse({
    success: true,
    session_cookie: jarToCookieHeader(jar),
  });
}

async function proxyGet(request, targetPath) {
  const sessionCookie = request.headers.get("X-Session-Cookie");
  if (!sessionCookie) {
    return jsonResponse({ error: "Missing X-Session-Cookie header. Log in first." }, 401);
  }

  const incomingUrl = new URL(request.url);
  const params = new URLSearchParams(incomingUrl.search);
  if (!params.has("timestamp")) {
    params.set("timestamp", Date.now().toString());
  }

  // Pull XSRF-TOKEN out of the stored jar (if present) so we can also send
  // it as X-XSRF-TOKEN - some Laravel/Sanctum setups expect this header
  // even on GET requests to resolve the session correctly.
  let xsrfHeader = {};
  const xsrfMatch = sessionCookie.match(/XSRF-TOKEN=([^;]+)/);
  if (xsrfMatch) {
    try {
      xsrfHeader = { "X-XSRF-TOKEN": decodeURIComponent(xsrfMatch[1]) };
    } catch {
      xsrfHeader = { "X-XSRF-TOKEN": xsrfMatch[1] };
    }
  }

  const targetUrl = `${SCHOOL_BASE}${targetPath}?${params.toString()}`;

  const resp = await fetch(targetUrl, {
    headers: xhrSchoolHeaders({
      Cookie: sessionCookie,
      Accept: "application/json",
      ...xsrfHeader,
    }),
  });

  if (!resp.ok) {
    // DEBUG MODE: surface full diagnostic info on any failure, JSON or not.
    const bodySnippet = (await resp.text()).slice(0, 500);
    return jsonResponse(
      {
        error: "Request to school server failed.",
        worker_version: WORKER_VERSION,
        debug_status: resp.status,
        debug_content_type: resp.headers.get("content-type") || "",
        debug_target_url: targetUrl,
        debug_cookie_names_sent: sessionCookie.split(";").map((c) => c.split("=")[0].trim()),
        debug_xsrf_header_sent: xsrfHeader["X-XSRF-TOKEN"] || null,
        debug_body_snippet: bodySnippet,
      },
      401
    );
  }

  return withCors(resp);
}

// Fetch a few authenticated HTML pages and scan for /daybook/get/{student}/{class}
// links (or student_id / class_id fields) so the frontend doesn't hardcode ids.
async function handleDiscover(request) {
  const sessionCookie = request.headers.get("X-Session-Cookie");
  if (!sessionCookie) {
    return jsonResponse({ error: "Missing X-Session-Cookie header. Log in first." }, 401);
  }
  const pages = ["/", "/daybook", "/diary", "/feed"];
  const found = [];
  const tried = [];
  for (const path of pages) {
    try {
      const r = await fetch(`${SCHOOL_BASE}${path}`, {
        headers: commonSchoolHeaders({ Cookie: sessionCookie, Accept: "text/html" }),
      });
      const html = await r.text();
      const snippets = [];
      const sre = /(student|pupil|class|daybook|diary|child)[^<\n]{0,90}/gi;
      let sm;
      while ((sm = sre.exec(html)) && snippets.length < 25) {
        snippets.push(html.slice(Math.max(0, sm.index - 40), sm.index + 100).replace(/\s+/g, " "));
      }
      const links = [...html.matchAll(/(?:href|src|action)=["']([^"']+)["']/gi)].map((x) => x[1]).filter((u) => !/\.(css|png|jpg|svg|ico|woff2?)(\?|$)/i.test(u)).slice(0, 40);
      tried.push({ path, status: r.status, length: html.length, title: (html.match(/<title>([^<]*)/i) || [])[1], links, snippets });
      const re = /daybook\/get\/(\d+)\/(\d+)/g;
      let m;
      while ((m = re.exec(html))) found.push({ student_id: m[1], class_id: m[2], from: path });
      const s = html.match(/student[_-]?id["'\s:=\/]+(\d+)/i);
      const c = html.match(/class[_-]?id["'\s:=\/]+(\d+)/i);
      if (s && c) found.push({ student_id: s[1], class_id: c[1], from: path });
      if (found.length) break;
    } catch (err) {
      tried.push({ path, error: err.message });
    }
  }
  return jsonResponse({ worker_version: WORKER_VERSION, found, tried });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/login" && request.method === "POST") {
        return await handleLogin(request);
      }

      if (url.pathname === "/discover" && request.method === "GET") {
        return await handleDiscover(request);
      }

      if (url.pathname === "/daybook" && request.method === "GET") {
        const studentId = url.searchParams.get("student_id");
        const classId = url.searchParams.get("class_id");
        if (!studentId || !classId) {
          return jsonResponse({ error: "student_id and class_id are required" }, 400);
        }
        return await proxyGet(request, `/daybook/get/${studentId}/${classId}`);
      }

      if (url.pathname === "/feed" && request.method === "GET") {
        const page = url.searchParams.get("page") || "1";
        return await proxyGet(request, `/feed/get/${page}`);
      }

      return jsonResponse({ error: "Not found. Use /login, /daybook, or /feed." }, 404);
    } catch (err) {
      return jsonResponse({ error: `Worker error: ${err.message}` }, 500);
    }
  },
};
