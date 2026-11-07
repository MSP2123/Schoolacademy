# School grades app

- `index.html` – frontend (GitHub Pages). Worker URL can be set in the app under "Налаштування сервера".
- `worker/` – Cloudflare Worker CORS proxy (v6). Deploy: `cd worker && npx wrangler deploy`,
  or add repo secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` and run the "Deploy Worker" action.
- `school_client.py` – Python reference client. `portal.html` – old redirect-to-portal page.
- `HANDOFF.md` – background and open issues.
