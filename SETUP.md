# Xpensego waitlist — setup

Two services. Cloudflare Pages puts the page on the internet. Convex stores the
emails and sends them. Total setup: about 30 minutes, all free tiers.

```
site/index.html      → the landing page (goes to Cloudflare Pages)
convex/schema.ts     → the waitlist table
convex/waitlist.ts   → join / count / export logic
convex/emails.ts     → welcome email + launch invite
convex/http.ts       → the URLs the page talks to
```

---

## 1. Convex (the database + emails)

```bash
npm init -y
npm install convex
npx convex dev          # logs you in, creates the project, deploys the functions
```

Leave `npx convex dev` running. It prints two URLs. You want the one ending in
**`.convex.site`** (HTTP actions), not `.convex.cloud`.

Then set three environment variables in the Convex dashboard (Settings →
Environment Variables):

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | from resend.com → API Keys |
| `ADMIN_TOKEN` | any long random string — this protects your CSV export |
| `EMAIL_FROM` | `Xpensego <hello@yourdomain.com>` — **only after** your domain is verified |

Generate an admin token: `openssl rand -base64 32`

## 2. Point the page at Convex

In `site/index.html`, one line near the bottom:

```js
const CONVEX_URL = "https://YOUR-DEPLOYMENT.convex.site";
```

Paste your `.convex.site` URL there. That's the only edit.

## 3. Cloudflare Pages (hosting)

Dashboard → Workers & Pages → Create → Pages → **Upload assets**. Drag the
`site` folder in. You get a live URL like `xpensego.pages.dev` in under a minute.

(If you'd rather push from Git, connect the repo instead and set the build
output directory to `site` with no build command.)

Test it: open the URL, sign up with your own email, then check the Convex
dashboard → Data → `waitlist`. Your row is there.

## 4. Analytics (2 minutes, do it before you promote anything)

Cloudflare dashboard → Analytics & Logs → Web Analytics → Add a site. Copy the
token and paste it into **both** `index.html` and `privacy.html`, replacing
`YOUR_CF_ANALYTICS_TOKEN`.

This is cookieless and stores no personal data, which is why the privacy note
doesn't need a consent banner. Without it you'll have signups but no idea how
many people saw the page — and a signup count with no visitor count can't tell
you whether the page works.

## 5. Privacy note

`site/privacy.html` ships with the page and is linked from the footer. Two things
to change before launch:

- The contact address is `privacy@xpensego.com` — point it at a mailbox you
  actually read, or swap it for your own address.
- It says Convex, Resend and Cloudflare by name. If you switch email provider,
  update that line. It's a factual list, not boilerplate.

It's written to be true rather than defensive: it names the two emails you'll
send, promises no bank access, and offers a real delete. Note that I'm not a
lawyer — for a financial product storing Indian consumers' data, get this looked
at properly once you have real users. This is the floor, not the finish line.

---

## The email catch — read this

Resend will **only send to your own account email** until you verify a domain.
Signups still save perfectly; the welcome email just doesn't go out, and the row
sits at `welcomeStatus: "pending"`. Nothing is lost.

When you get a domain (Cloudflare Registrar sells them at cost):

1. Resend → Domains → add it, paste the DNS records into Cloudflare DNS.
2. Set `EMAIL_FROM` in Convex to an address on that domain.
3. Flush everyone who signed up in the meantime — Convex dashboard → Functions →
   `emails:flushPendingWelcomes` → run with `{ "adminToken": "<your token>" }`.

Every pending signup gets their welcome email, in order. No one falls through.

---

## Day-to-day

**Get the list** — open in a browser:
```
https://YOUR-DEPLOYMENT.convex.site/export.csv?token=<ADMIN_TOKEN>
```

**Send the launch email** — Convex dashboard → Functions → `emails:sendLaunchInvites`:
```json
{ "adminToken": "<your token>", "productUrl": "https://t.me/XpensegoBot", "dryRun": true }
```
`dryRun: true` tells you how many would go out without sending anything. Drop it
to send for real. It goes out in signup order, and each person is marked so
nobody gets it twice. Resend's free tier caps at 100/day — the default batch is
90, so run it again the next day if the list is longer.

---

## What's built in

- **Duplicate signups** are a no-op, not an error — the visitor sees "you're already on the list".
- **Bot honeypot**: a hidden field real people never fill. Filled → silently discarded.
- **Attribution**: every row records which section of the page they signed up on,
  plus `utm_source` / `utm_medium` / `utm_campaign` and referrer. Share the URL as
  `?utm_source=twitter` and you'll know what actually worked.
- **The counter is honest.** It shows the real number from the database and stays
  hidden until there are at least 25 signups (`COUNTER_MIN_DISPLAY` in Convex env).
  The original design had a hardcoded 8,214 — that's a fabricated number on a page
  whose entire pitch is honesty. It's gone.
- **No raw IPs stored.** Nothing collected beyond email + attribution.
