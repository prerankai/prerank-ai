# PreRank AI — Live App (deployable version)

Zero-dependency Node.js app: landing page + real accounts + report engine +
AI thumbnail generator + channel audit/feed/optimize + plans, test-mode
checkout, orders, and a full owner Admin Panel.

## Run locally
```
node server.js          # http://localhost:3000
```
Admin (seeded on first run): owner@prerankai.com / Prerank@2026
(change it in Account & Billing after first login, or set ADMIN_PASSWORD).

## Deploy FREE on Render (Phase 0)
1. Create a free GitHub account (owner's email) and a new repository.
2. Upload this folder's contents to the repository (or `git push`).
3. Create a free Render account (render.com) → New → Web Service →
   connect the repository. Render reads `render.yaml` automatically.
4. Set the ADMIN_PASSWORD environment variable in Render → Deploy.
5. Your live URL looks like: https://prerank-ai.onrender.com
   (free tier sleeps when idle — first load can take ~30 seconds.)

Data is stored in `data/db.json` on the server's disk. On Render's free tier
the disk is ephemeral (data resets on redeploy) — move to the paid tier
(persistent disk) or Supabase/Postgres when real customers arrive; the API
layer is the only place that touches storage, so the swap is contained.

## AI thumbnails
Generation uses the free Pollinations image API (no key needed), proxied
through `/api/img` so downloads work. Quality/speed vary at busy times;
a paid provider key can replace it in one place (`aiImgUrl` in index.html).

## Payments
Checkout is TEST MODE (orders are created, plans upgrade, no real charge).
Phase 1: create the owner's Stripe account and wire the checkout endpoint
in `server.js` to Stripe Checkout — the orders/admin structure stays the same.
