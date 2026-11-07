# Handoff: school.academy.com.ua grades app (for Claude Code)

## Goal
Pull grades / homework / comments / feed from the school portal (school.academy.com.ua) and eventually ship an Android app (iOS later). Low-stakes data (grades + school messages only).

## Site facts (confirmed)
- Custom Laravel-style app (aniart.com.ua), session-cookie auth.
- Login: `GET /login` -> scrape `_token` from HTML -> `POST /auth` with form fields `_token, email, password, remember ("on"/""), login ("")`.
- Success sets cookies `a_school_session` and `XSRF-TOKEN`.
- JSON endpoints:
  - `GET /daybook/get/{student_id}/{class_id}?timestamp={unix_ms}` -> `data.week_days[].lessons[]` with `subject_name, teacher_name, homework, topic, grades[] {grade_value, grade_type_name, comment}`
  - `GET /feed/get/{page}?timestamp={unix_ms}` -> `data.items[]` with `title, description, time_formatted, icon, link` (grade sometimes in icon filename, e.g. `/images/icons/grades/8.png`)
- student_id=2556, class_id=41 came from one browser session. Should be discovered dynamically per user (find which endpoint/page exposes them).

## Files in this folder
- `school_client.py` - Python prototype, works standalone with `requests` (login + daybook + feed). Reference for correct behavior.
- `worker.js` - Cloudflare Worker CORS proxy, **v5 (rewritten this session, untested against live site)**.
- `index.html` - single-file frontend (login + grades + feed), talks to the Worker. Worker URL hardcoded near top of `<script>` (`WORKER_URL`). Currently points at the OLD account's worker: `https://sweet-sound-6a5b.marksmurfik.workers.dev` - change after redeploying on the new account.

## Original blocker
Login succeeds through the Worker, but `/daybook` and `/feed` return `{"message":"Unauthenticated."}`. Python client works fine.

## What was done this session (worker.js v4-debug -> v5)
Diffed Worker vs. Python client and fixed:
1. `SCHOOL_BASE` constant was missing from the pasted worker.js (may have just been trimmed in the paste - verify the deployed one).
2. Worker only kept 2 cookies; now keeps the whole cookie jar like `requests.Session()`.
3. Added desktop Chrome User-Agent on every outbound request (same as Python).
4. Post-login redirect is now chased manually and its Set-Cookie headers merged (Python used allow_redirects=True).
5. Auto-injects `timestamp` query param (frontend never sent it).
6. Sends `X-Requested-With: XMLHttpRequest`, `Referer`, and `X-XSRF-TOKEN` (decoded from XSRF cookie) on data calls.
7. Debug output kept: on non-2xx, returns `debug_status, debug_cookie_sent, debug_target_url, debug_xsrf_header_sent, debug_body_snippet`; on login failure returns `debug_jar_keys`.

## Status / next steps
1. Redeploy `worker.js` (v5) to Cloudflare (new account), update `WORKER_URL` in `index.html`, redeploy Pages.
2. Log in via frontend, read `debug_*` fields if still `Unauthenticated`.
3. If still failing: remaining theory is session binding to IP/UA (Worker's outbound IP differs). Test by comparing with `school_client.py` run locally. If IP-bound, the proxy approach is dead - a native Android app calling the site directly from the phone avoids it (and CORS entirely, no Worker needed).
4. Discover student_id / class_id dynamically instead of hardcoding.
5. Then build the Android app (Kotlin; OkHttp with a persistent CookieJar, same login flow as `school_client.py`).

## Notes
- Mark's school password was once pasted in plaintext in an earlier chat, and a session cookie appeared in a screenshot. Treat both as compromised - change the password, don't reuse that cookie.
- Mark prefers: casual/brief, just execute, finished files delivered rather than manual patch instructions, hand-made vector icons (no AI-generated logos/icons).
