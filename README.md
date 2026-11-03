# Tempu Tracker Server

Express API for **Tempu Tracker** (Chattogram verified tempu routes, driver-shared live GPS, Meta AI travel assistant).

Companion repo: [tempu-tracker-client](https://github.com/jotika-meaw/tempu-tracker-client) (Vite + React frontend).

## Local dev

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

API at `http://localhost:3001`. Needs MongoDB Atlas for persistent mode (blank `MONGODB_URI` = explicit memory mode) and `MODEL_API_KEY` for the assistant.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Database + AI health, no secrets |
| `GET` | `/api/tracking/active?routeNumber=01` | Fresh public vehicle positions |
| `POST` | `/api/tracking/start` | Create session (journey + consent + GPS) |
| `POST` | `/api/tracking/location` | Update one session (`Authorization: Bearer <token>`) |
| `POST` | `/api/tracking/stop` | Delete the session |
| `POST` | `/api/ai-test` | Route-grounded Meta AI answer |

## Deploy (Vercel, zero-configuration Express)

`server.ts` default-exports the Express app, which the Vercel Express preset
detects and serves as a single Function (Fluid compute). No `api/` adapter or
`vercel.json` rewrites are needed. Local dev keeps using `index.ts`
(`tsx watch`, `app.listen`); shared startup lives in `bootstrap.ts`.

```powershell
vercel --prod
```

Required production env vars (Vercel dashboard or `vercel env add`): `MONGODB_URI` (direct shard-host form, not `+srv`), `MONGODB_DB_NAME`, `MODEL_API_KEY`, `CORS_ORIGINS` (include the client deployment URL).

## Checks

```powershell
npm run typecheck
npm test
npm run verify:meta
```
