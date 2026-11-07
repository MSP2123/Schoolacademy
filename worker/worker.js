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

const WORKER_VERSION = "v12";

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

// Core authenticated JSON GET. Returns { ok, resp, debug } so callers can
// retry with other parameters instead of failing on the first non-2xx.
async function schoolGet(request, targetPath) {
  const sessionCookie = request.headers.get("X-Session-Cookie");
  if (!sessionCookie) {
    return { ok: false, early: jsonResponse({ error: "Missing X-Session-Cookie header. Log in first." }, 401) };
  }

  const incomingUrl = new URL(request.url);
  const params = new URLSearchParams();
  for (const [k, v] of incomingUrl.searchParams) {
    if (k === "student_id" || k === "week" || k === "page") continue;
    params.set(k, v);
  }
  if (!params.has("timestamp")) params.set("timestamp", Date.now().toString());

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
  if (resp.ok) return { ok: true, resp };

  const bodySnippet = (await resp.text()).slice(0, 500);
  return {
    ok: false,
    debug: {
      debug_status: resp.status,
      debug_target_url: targetUrl.replace(/timestamp=\d+/, "timestamp=…"),
      debug_body_snippet: bodySnippet,
    },
  };
}

async function proxyGet(request, targetPath) {
  const r = await schoolGet(request, targetPath);
  if (r.early) return r.early;
  if (r.ok) return withCors(r.resp);
  return jsonResponse({ error: "Request to school server failed.", worker_version: WORKER_VERSION, ...r.debug }, 401);
}

function htmlUnescape(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// The home page ("/") embeds the logged-in account as JSON in
// <app-header :header_data="..."> (HTML-escaped). That has the active
// child's id and the children list, so no scraping of daybook pages needed.
async function handleDiscover(request) {
  const sessionCookie = request.headers.get("X-Session-Cookie");
  if (!sessionCookie) {
    return jsonResponse({ error: "Missing X-Session-Cookie header. Log in first." }, 401);
  }
  const r = await fetch(`${SCHOOL_BASE}/`, {
    headers: commonSchoolHeaders({ Cookie: sessionCookie, Accept: "text/html" }),
  });
  const page = await r.text();
  const m = page.match(/:header_data="([^"]+)"/);
  if (!m) {
    return jsonResponse(
      { error: "header_data not found on home page", debug_status: r.status, debug_length: page.length },
      502
    );
  }
  let data;
  try {
    data = JSON.parse(htmlUnescape(m[1]));
  } catch (err) {
    return jsonResponse({ error: "Could not parse header_data: " + err.message }, 502);
  }
  const user = data.user || {};
  const classes = user.children_classes || {};
  const names = user.children || {};
  const children = Object.keys({ ...names, ...classes }).map((id) => ({
    student_id: id,
    name: typeof names[id] === "string" ? names[id] : "",
    class_name: (classes[id] && classes[id].name) || "",
  }));
  const current = user.current_child && user.current_child.id;
  return jsonResponse({
    worker_version: WORKER_VERSION,
    group: user.group || null,
    current_student_id: current ? String(current) : children[0] ? children[0].student_id : null,
    children,
  });
}

function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

// Week number counted from the week containing 1 September of the current
// school year (Sep-Dec -> this year's Sept, Jan-Aug -> last year's Sept).
function schoolYearWeek(d = new Date()) {
  const startYear = d.getUTCMonth() >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const sep1 = new Date(Date.UTC(startYear, 8, 1));
  const monday = new Date(sep1);
  monday.setUTCDate(sep1.getUTCDate() - ((sep1.getUTCDay() + 6) % 7));
  return Math.floor((d - monday) / (7 * 86400000)) + 1;
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
        if (!studentId) {
          return jsonResponse({ error: "student_id is required" }, 400);
        }
        // Route is daybook/get/{student}/{week?}; the school wants a week
        // inside the school year. Try: explicit ?week, none (server picks
        // from timestamp), school-year week, ISO week - first success wins.
        const explicit = url.searchParams.get("week");
        const candidates = explicit
          ? [explicit]
          : [null, String(schoolYearWeek()), String(isoWeek())];
        const attempts = [];
        for (const w of candidates) {
          const r = await schoolGet(request, `/daybook/get/${studentId}${w ? "/" + w : ""}`);
          if (r.early) return r.early;
          if (r.ok) return withCors(r.resp);
          attempts.push({ week: w, ...r.debug });
        }
        return jsonResponse(
          { error: "Daybook request failed for every week format tried.", worker_version: WORKER_VERSION, attempts },
          401
        );
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
