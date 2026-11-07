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

const WORKER_VERSION = "v19";

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

  // The school gives EVERY visitor a session cookie, so having one proves
  // nothing. Check that the account is really logged in by loading the home
  // page: a guest gets redirected to /login or sees the login form.
  const homeResp = await fetch(`${SCHOOL_BASE}/`, {
    headers: commonSchoolHeaders({ Cookie: jarToCookieHeader(jar), Accept: "text/html" }),
    redirect: "manual",
  });
  mergeCookies(jar, extractAllCookies(homeResp));
  const homeLoc = homeResp.headers.get("location") || "";
  const homeHtml = homeResp.status >= 300 && homeResp.status < 400 ? "" : await homeResp.text();
  const looksLoggedIn =
    homeResp.status === 200 &&
    !/<input[^>]+name=["']password["']/i.test(homeHtml) &&
    (/name=["']user-id["']/i.test(homeHtml) || /header[_-]?data/i.test(homeHtml));
  if (!looksLoggedIn) {
    // Find out why: re-open the login page with this session and read any error message.
    let reason = "";
    try {
      const lp = await fetch(`${SCHOOL_BASE}/login`, {
        headers: commonSchoolHeaders({ Cookie: jarToCookieHeader(jar), Accept: "text/html" }),
      });
      const lh = await lp.text();
      const msgs = [];
      const re = /<(?:div|span|p|li|strong)[^>]*class=["'][^"']*(?:alert|error|invalid|danger|help-block|message)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p|li|strong)>/gi;
      let m;
      while ((m = re.exec(lh)) && msgs.length < 4) {
        const t = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (t && t.length < 300) msgs.push(t);
      }
      reason = msgs.join(" | ");
    } catch {}
    return jsonResponse(
      {
        error:
          "Вхід не вдався: школа не прийняла ці дані." + (reason ? ` Повідомлення школи: ${reason}` : " Перевірте email і пароль."),
        worker_version: WORKER_VERSION,
        debug_auth_status: authResp.status,
        debug_auth_location: location || "",
        debug_home_status: homeResp.status,
        debug_home_location: homeLoc,
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
    if (["student_id", "week", "page", "date", "mode", "path"].includes(k)) continue;
    params.set(k, v);
  }
  // `date` (unix ms) picks which week to load; timestamp is what the school reads.
  const dateParam = incomingUrl.searchParams.get("date");
  if (dateParam && /^\d+$/.test(dateParam)) params.set("timestamp", dateParam);
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
  const m = page.match(/[:\w-]*header[_-]?data\s*=\s*"([^"]*)"/i);
  let data = null;
  if (m) {
    try { data = JSON.parse(htmlUnescape(m[1])); } catch (err) { /* fall through to fallback */ }
  }
  if (!data) {
    // No embedded account JSON (e.g. a student account): fall back to the page's user-id meta tag.
    const meta = page.match(/<meta[^>]+name=["']user-id["'][^>]+content=["'](\d+)["']/i) ||
      page.match(/<meta[^>]+content=["'](\d+)["'][^>]+name=["']user-id["']/i);
    if (!meta && /<input[^>]+name=["']password["']/i.test(page)) {
      // The school is showing us the login form: this session is only a guest session.
      return jsonResponse({ error: "Unauthenticated. Сесія недійсна — увійдіть знову.", worker_version: WORKER_VERSION }, 401);
    }
    if (!meta) {
      const tag = (page.match(/<app-header[^>]{0,300}/i) || [""])[0];
      return jsonResponse(
        {
          error: "Не вдалося визначити акаунт на головній сторінці школи.",
          worker_version: WORKER_VERSION,
          debug_status: r.status,
          debug_length: page.length,
          debug_has_login_form: /name=["']password["']/i.test(page),
          debug_app_header_tag: tag,
          debug_title: (page.match(/<title>([^<]*)/i) || [])[1] || "",
        },
        502
      );
    }
    data = { user: { id: Number(meta[1]), group: "unknown" } };
  }
  const user = data.user || {};
  const isId = (v) => /^\d+$/.test(String(v == null ? "" : v));
  const classes = user.children_classes && !Array.isArray(user.children_classes) ? user.children_classes : {};
  const names = user.children && !Array.isArray(user.children) ? user.children : {};
  // Parent account: children listed. Student account: the user is the student.
  let children = Object.keys({ ...names, ...classes })
    .filter(isId)
    .map((id) => ({
      student_id: id,
      name: typeof names[id] === "string" ? names[id] : "",
      class_name: (classes[id] && classes[id].name) || "",
    }));
  const cc = user.current_child || {};
  let current = isId(cc.id) ? String(cc.id) : children[0] ? children[0].student_id : null;
  let studentName = cc.name || (children.find((c) => c.student_id === current) || {}).name || "";
  let cls = current && classes[current] ? classes[current] : {};
  let canteenBalance = cc.canteen_balance != null ? cc.canteen_balance : user.canteen_balance != null ? user.canteen_balance : null;
  if (!current && isId(user.id)) {
    // student logging in directly
    current = String(user.id);
    studentName = user.name || "";
    children = [{ student_id: current, name: studentName, class_name: "" }];
    const sc = user.student_class || user.studentClass || user.class || {};
    cls = { id: user.student_class_id || user.class_id || sc.id || null, name: sc.name || user.class_name || "" };
  }
  return jsonResponse({
    worker_version: WORKER_VERSION,
    group: user.group || null,
    student_name: studentName,
    class_id: cls.id || null,
    class_name: cls.name || "",
    canteen_balance: canteenBalance,
    current_student_id: current,
    children,
    debug: {
      user_keys: Object.keys(user).slice(0, 40),
      children_keys: Object.keys(names),
      classes_keys: Object.keys(classes),
      current_child_id: cc.id == null ? null : String(cc.id),
    },
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

// Allowlisted read-only passthrough for the school's JSON endpoints
// (schedule, journal, canteen...). Only these paths can be requested.
const API_ALLOW = [
  /^\/schedule\/(student|class)\/get(\/\d+){0,2}$/,
  /^\/studentparent\/journal\/get(\/[\w.-]+){0,2}$/,
  /^\/canteen\/get(\/[\w.-]+){0,4}$/,
  /^\/daybook\/get(\/\d+){1,2}$/,
  /^\/feed\/get\/\d+$/,
];

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

      if (url.pathname === "/file" && request.method === "GET") {
        // Attachments (homework files etc.) live behind the school's login, so they
        // are fetched here with the user's own session and streamed back.
        const path = url.searchParams.get("path") || "";
        if (!/^\/storage\/[\w\-./%]+$/.test(path) || path.includes("..")) {
          return jsonResponse({ error: "Path not allowed", path }, 403);
        }
        const cookie = request.headers.get("X-Session-Cookie");
        if (!cookie) return jsonResponse({ error: "Missing X-Session-Cookie header. Log in first." }, 401);
        const r = await fetch(`${SCHOOL_BASE}${path}`, {
          headers: commonSchoolHeaders({ Cookie: cookie, Accept: "*/*" }),
          redirect: "manual",
        });
        if (r.status >= 300 && r.status < 400) {
          return jsonResponse({ error: "Unauthenticated. Сесія недійсна — увійдіть знову." }, 401);
        }
        if (!r.ok) return jsonResponse({ error: "File request failed", debug_status: r.status }, r.status === 404 ? 404 : 502);
        const h = new Headers();
        h.set("Content-Type", r.headers.get("content-type") || "application/octet-stream");
        h.set("Cache-Control", "private, max-age=3600");
        return withCors(new Response(r.body, { status: 200, headers: h }));
      }

      if (url.pathname === "/api" && request.method === "GET") {
        const path = url.searchParams.get("path") || "";
        if (!API_ALLOW.some((re) => re.test(path))) {
          return jsonResponse({ error: "Path not allowed", path }, 403);
        }
        return await proxyGet(request, path);
      }

      if (url.pathname === "/discover" && request.method === "GET") {
        return await handleDiscover(request);
      }

      if (url.pathname === "/daybook" && request.method === "GET") {
        let studentId = url.searchParams.get("student_id");
        // Self-heal: an old/cached frontend may send "null" or nothing. Work it out
        // from the logged-in account instead of asking the school for student "null".
        if (!/^\d+$/.test(studentId || "")) {
          const found = await (await handleDiscover(request)).json().catch(() => ({}));
          studentId = found && found.current_student_id;
          if (!/^\d+$/.test(studentId || "")) {
            return jsonResponse({ error: "Could not determine the student for this account.", worker_version: WORKER_VERSION, debug: found && found.debug }, 400);
          }
        }
        // Route is daybook/get/{student}/{week?}; the school wants a week
        // inside the school year. Try: explicit ?week, none (server picks
        // from timestamp), school-year week, ISO week - first success wins.
        const explicit = url.searchParams.get("week");
        const dateParam = url.searchParams.get("date");
        const when = dateParam && /^\d+$/.test(dateParam) ? new Date(Number(dateParam)) : new Date();
        const options = {
          school: String(schoolYearWeek(when)),
          iso: String(isoWeek(when)),
          none: null,
        };
        // Order: the format that worked last time (?mode=), then the rest.
        // When browsing other weeks, "none" goes last: the server may ignore
        // the timestamp then and hand back the current week.
        const mode = url.searchParams.get("mode");
        let order = dateParam ? ["school", "iso", "none"] : ["none", "school", "iso"];
        if (mode && order.includes(mode)) order = [mode, ...order.filter((m) => m !== mode)];
        const candidates = explicit ? [["explicit", explicit]] : order.map((m) => [m, options[m]]);
        const attempts = [];
        for (const [name, w] of candidates) {
          const r = await schoolGet(request, `/daybook/get/${studentId}${w ? "/" + w : ""}`);
          if (r.early) return r.early;
          if (r.ok) {
            const out = withCors(r.resp);
            out.headers.set("X-Week-Mode", name);
            out.headers.set("Access-Control-Expose-Headers", "X-Week-Mode");
            return out;
          }
          attempts.push({ mode: name, week: w, ...r.debug });
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
