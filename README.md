# Donaro

A donation platform with fundraising goals, a Dredits virtual currency, and
Dredit-funded promotion ads — built as a real client/server app with a
persistent database.

## Stack

- **Backend:** plain Node.js (`http` + the built-in `node:sqlite` module).
  No `npm install` required — it runs with just Node 22+.
- **Database:** SQLite, stored at `data/donaro.db` (created automatically on
  first run).
- **Frontend:** a small vanilla-JS single-page app (`public/`), no build step.
- **Auth:** email/password with `scrypt` password hashing and an HTTP-only
  session cookie.

## Running it

```
node server.js
```

Then open **http://localhost:8080**. That's it — no build step, no package
install. (Node ships `node:sqlite` from v22.5+; you'll see an
"experimental feature" warning in the console, which is expected and
harmless.)

Set a custom port with `PORT=3000 node server.js` if 8080 is taken.

## Where the spec logic lives

Every money/Dredit/ad calculation happens server-side in **`lib/money.js`** —
the client never computes or is trusted with these numbers, it only displays
what the server returns:

- `computeGoalTotal` — requested amount → 102% goal total
- `splitDonation` — pools each donation into creator/Donaro shares at exactly
  100/102, so once a goal is fully funded the creator has received precisely
  their requested amount, with cent-level rounding remainders always landing
  in Donaro's fee share (never shorting the creator)
- `computeDredits` — `floor(cents / 200)`, i.e. floor(dollars / 2)
- `noteAllowed` — donations ≥ $100.00 (inclusive) can carry a note
- `computeAdCost` — 100 Dredits/day (min 5 days), 2 appearances per Dredit

`server.js` enforces these server-side on every request (goal creation cost,
free-first-goal tracking, donation splits, note gating, ad affordability) —
the frontend in `public/app.js` only previews numbers via the
`/api/goals/preview` endpoint and always re-validates against what the
server actually returns.

## Data model

`users`, `sessions`, `goals`, `donations`, `dredit_transactions` (a full
ledger, not just a running balance), and `ads`. See `db.js` for the schema.

## What's simulated vs. real

- The database, auth, sessions, and all fee/Dredit math are **real** and
  persist across restarts.
- Dredit *purchases* simulate a successful payment (no payment processor is
  wired up) — in production this endpoint would only credit Dredits after a
  provider like Stripe confirms the charge server-side.
- There's no moderation/reporting UI yet, and ad *placement/rotation* is a
  simple random pick from active ads — the spec notes this is
  developer-configurable, so `GET /api/ads/active` is the hook to build a
  smarter rotation against.

## Design

Visual identity is a corkboard/bulletin-board: goals are pinned index cards,
donations render as torn receipt slips, and the Dredit balance is a "wallet"
card — deliberately not the generic cream/serif/terracotta SaaS look.
