# Cloud features on Vercel (accounts, cloud saves, friends, co-op, ranking)

The game and its API deploy together to Vercel:

- **The game** is served as static files, the same files as on GitHub Pages.
- **The API** is one serverless function, `api/v1.js` (code in `server/api.js`),
  that replaces Firebase. It handles accounts, cloud saves, friends and invites,
  co-op rooms and the ranking.
- **The database** is Postgres. The easiest option is **Neon**, added from
  Vercel's Marketplace in two clicks. The tables are created automatically on
  the first request, so there's no SQL to run.

Everything here fits the free plans (Vercel Hobby + Neon Free). Without a
database, the game still works and saves only in the browser, as before.

## 1. Deploy the project

1. Go to <https://vercel.com/new> and **import** this GitHub repository.
2. *Framework Preset*: **Other**. Leave the build and output settings empty
   (`vercel.json` already sets them).
3. **Deploy**. The game opens at `https://<your-project>.vercel.app`, but in
   browser-only mode until step 2 is done.

## 2. Add the database

1. In the Vercel project: **Storage → Create Database → Neon** (Serverless Postgres).
2. Region: **Frankfurt (eu-central-1)**. It's next to the function region set
   in `vercel.json` (`cdg1`, Paris). If you move one, move the other.
3. **Connect** it to the project for all environments. This sets
   `DATABASE_URL` (and `POSTGRES_URL`) automatically.
4. **Deployments → ⋯ → Redeploy** so the function picks up the new variable.

Check it works: the login screen should say *"Tu partida se guarda en la
nube"* / *"Your game is saved in the cloud"*, with no "Google" button.

Any other Postgres works too (Supabase, Railway, your own). Set
`DATABASE_URL` under **Settings → Environment Variables** and redeploy. With
a connection pooler (Supabase port 6543, Neon `-pooler` hosts), use the pooled
URL.

## 3. (Optional) Game on GitHub Pages, API on Vercel

If you'd rather keep serving the game from GitHub Pages or your own domain:

1. In `js/core/cloud-config.js` set the full API address:
   `G.CLOUD_API = 'https://<your-project>.vercel.app/api/v1';`
   then run `node tools/build.js` (it rebuilds `js/app.min.js`).
2. In Vercel, **Settings → Environment Variables**: add
   `ALLOWED_ORIGINS` = `https://<you>.github.io` (comma-separated for several
   sites), then redeploy.

## How it maps from Firebase

| Feature | Before (Firebase) | Now |
|---|---|---|
| Accounts | Firebase Auth (name + password, Google) | Name + password, scrypt-hashed on the server; session token in the browser. 8 wrong passwords in a row → 5 min lock. |
| Cloud save | Firestore transaction + merge | `saves` table with a version number. If another computer saved first, the server returns its copy, the browser merges (`G.DB.merge`, same rules as before) and retries. |
| Friends / online / invites | Firestore + live listeners | One `poll` request every 30 s (and immediately when opening Friends) |
| Co-op rooms | Realtime Database | `rooms` tables, polled every 1.5 s in the lobby, every 4 s in game. A player who stops responding for 75 s is removed; when the host leaves, the room closes. |
| Co-op connection | WebRTC, signaling and relay over the Realtime Database | Same WebRTC. Signaling and the relay fallback go through the API (`roomSend` / `roomPoll`). |
| Ranking + anti-cheat | Firestore rules | Checked on the server: a score can't be longer than the real time since `runStart`, and level/kills must fit the time. |
| Delete account | Client deleted each piece | One request; the database deletes everything that belongs to the account. |

**Not carried over:** Google sign-in, and accounts in the original author's
Firebase project. Browser-only saves still upload to a new cloud account,
as they did before (create the account with the same name and password).

## Free-plan limits

Vercel Hobby includes about 1M function calls a month (and is for
non-commercial projects). Rough cost per player:

| Activity | Calls per hour |
|---|---|
| Menus, friends list | ~130 |
| In a room (lobby) | ~2,400 |
| Co-op game, direct connection (normal) | ~900 |
| Co-op game through the relay (only when a direct connection fails) | ~30,000 |

Neon Free: 0.5 GB of storage (thousands of players) and enough compute for a
small game. The database sleeps when idle, so the first request after a quiet
period takes about a second longer.

## Local development

You need Node 20+ and a local Postgres:

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/ps npm run dev
```

Open <http://localhost:8000>. API tests (they wipe the tables, so they only
run against a local database):

```
DATABASE_URL=postgres://user:pass@localhost:5432/ps_test npm run test:api
```
