# Xpensego — Product Requirements Document (v1.0)

**Author:** Black · **Builder:** Black + partner (Hermes runs on partner's system)
**Status:** Ready for build
**Companion docs:** Product Document v0.2 (vision, positioning, risks) · Build Spec v1.1 (architecture — supersede its scope with this PRD)

---

## 1. Purpose & scope of this document

This PRD defines the complete Xpensego product — every confirmed feature — with each requirement tagged to a delivery tier:

- **[BUILD]** — Buildathon day. This is the definition of "done" for the 8-hour build. Nothing untagged jumps in.
- **[v1.5]** — Weeks 1–4 post-buildathon.
- **[v2]** — Built after the core loop shows validation signal (see Product Doc §11 success criteria).

Rule for build day: if hour-boundary checkpoints show slippage, cut [BUILD] items in the order given in §12, never by improvisation.

## 2. Product summary

Xpensego is a Telegram-based expense agent for Indian consumers. Users log expenses and income conversationally, paste bank/UPI SMS, or upload statements; the agent extracts, categorizes (14-category Indian-tuned taxonomy + learned payee memory), answers natural-language money questions number-first, and proactively alerts on budget thresholds. No app, no dashboard, no required habit.

Positioning: *Your bank already tells you everything. Xpensego makes it mean something.*

## 3. Users & platform

- **Persona (v1):** digitally-fluent Indian consumer, 22–35, UPI-heavy, has abandoned at least one expense app. Chat-native.
- **Platform:** Telegram bot. The Telegram user ID is the account — no signup, no forms.
- **Multi-tenancy:** hard per-user isolation. `user_id` is injected by the API layer from Telegram identity; the model never selects it. **[BUILD]**
- **Conversation context:** agent holds the last ~10 messages per user (DB-loaded per request) so follow-ups and corrections work. **[BUILD]**
- **Language:** English and Hinglish/code-mixed input are both first-class. No separate feature — but §11 test cases must pass. **[BUILD]**

## 4. Functional requirements — Capture

### FR-1 Manual logging **[BUILD]**
Natural-text expense entry: "chai 30", "spent 1200 on groceries yesterday", "movie 450 last friday".
- FR-1.1 Multiple entries in one message ("chai 30, auto 80, lunch 250") → multiple rows, one consolidated confirmation.
- FR-1.2 Date resolution: agent resolves relative dates ("yesterday", "last Friday", "3 tarikh ko") against today's date; no date stated → today.
- FR-1.3 **Confirmation always echoes the resolved date:** `✓ ₹500 · Food & Dining — 03/07/26`. This is the user's misparse safety net; never omit it.
- FR-1.4 Missing amount → ask. Guessable category → guess and state it, don't interrogate. Max one clarifying question per message (global rule).

**Acceptance:** the 25-message QA set (§11) logs with correct amount, category, date, and echoed-date confirmations; multi-entry messages produce N rows and one confirmation.

### FR-2 Credits & income **[BUILD]**
Users record money received: "salary 85000", "got 500 back from Amazon", "refund 1200".
- FR-2.1 Every ledger row carries `type: debit | credit`.
- FR-2.2 **Spend totals, budgets, and alerts count debits only.** Credits never net against spending unless the user explicitly asks ("net this month?").
- FR-2.3 Credits are queryable: "how much did I receive this month?", "did my Amazon refund come?"
- FR-2.4 SMS/statement parsing (FR-3) logs credits it finds, tagged as credits, same debits-only reporting rule.

**Acceptance:** logging salary then asking "how much did I spend this month" excludes it; "how much did I receive" includes it.

### FR-3 SMS paste parsing **[BUILD]** — demo centerpiece
Pasted bank/UPI SMS (one to fifty in a single paste) → parsed entries.
- FR-3.1 Extract merchant, amount, date, debit/credit per SMS. Formats to support at minimum: HDFC, SBI, ICICI, Axis, Paytm, GPay/UPI notification styles (Black supplies the sample corpus).
- FR-3.2 Categorize via taxonomy (FR-5) + payee memory (FR-6).
- FR-3.3 **Raw input preserved** on every parsed row (original SMS text stored, user-invisible) for dispute resolution, parser debugging, and future re-categorization.
- FR-3.4 Dedup: before insert, match on user + amount + date + fuzzy description; on hit, ask instead of double-logging.
- FR-3.5 Output: compact summary — count, total, top 3 categories — plus "reply with a number to fix any category."

**Acceptance:** the 20-SMS demo block parses with ≥95% field accuracy; a re-pasted SMS triggers the dedup question, not a duplicate row.

### FR-4 Statement upload **[BUILD — first cut]**
CSV bank statements → same pipeline as FR-3 (parse, categorize, dedup, raw-line preservation, summary). PDF statements: **[v2]**.

### FR-4b Receipt photo OCR **[v1.5]**
User sends a photo of a receipt/bill → vision model extracts merchant, total, date (line items when legible).
- FR-4b.1 **Mandatory confirm step:** agent replies with the parsed entry; user confirms (or corrects) before it's logged. Never silent-log from OCR.
- FR-4b.2 Failure cases to handle gracefully: blur, thermal fade, handwritten bills — reply with what was read and ask for the missing field.
- FR-4b.3 Cost note: image calls cost multiples of text; instrument per-interaction cost from day one (feeds pricing work).

## 5. Functional requirements — Categorization

### FR-5 Taxonomy **[BUILD]**
Fixed 14 defaults: Food & Dining · Groceries · Transport · Rent & Utilities · Shopping · Entertainment · Health · Education · Personal Care · Subscriptions · Travel · Family & Gifts · Fees & Charges · Other.
- FR-5.1 Indian-merchant mapping is the differentiator; canonical cases: Swiggy/Zomato→Food & Dining, Blinkit/Zepto/Instamart/BigBasket→Groceries, Uber/Ola/Rapido/petrol/FASTag→Transport, Netflix/Hotstar/gym→Subscriptions, bank/ATM/late fees→Fees & Charges. Port Aurum categorization prompts/patterns as the starting point.
- FR-5.2 "Other" is monitored: entries landing there are a taxonomy-gap signal (review weekly).

### FR-6 Payee memory **[BUILD]**
Person-to-person UPI transfers carry no merchant signal.
- FR-6.1 First occurrence of an unknown payee → one question ("What was the ₹5,000 to Rahul for?").
- FR-6.2 Answer is stored per-user (payee → category); all future transfers to that payee auto-categorize silently. Never re-ask.
- FR-6.3 User can revise: "transfers to Rahul are rent now" updates the mapping.

**Acceptance:** second transfer to a taught payee logs with zero questions.

### FR-7 Corrections **[BUILD]**
- FR-7.1 "no, that's groceries" (within conversation context) re-categorizes the last-inserted entry and, where a payee/merchant is involved, updates payee memory so the correction sticks system-wide.
- FR-7.2 "why did you categorize this as X?" → agent shows the stored raw input and its reasoning in two lines.

### FR-8 Custom categories **[v1.5]**
- FR-8.1 "create a category called Pet Care" → per-user category, usable everywhere defaults are.
- FR-8.2 Overlap guard: if the request overlaps a default ("Fuel"), agent says so and offers subcategory vs new category. User's explicit choice wins.
- FR-8.3 Cap: 10 custom categories per user. Renaming/deleting the 14 defaults: not allowed.

## 6. Functional requirements — Query & reports

### FR-9 Natural-language queries **[BUILD]**
User asks in ordinary words (English or Hinglish); agent translates to a scoped DB query; answer leads with the number, one line of context, no lectures.
Must-pass query classes:
- Totals: "how much on food this month?" → "₹6,240 on Food & Dining so far this July."
- Comparisons: "this week vs last week" → "₹4,100 vs ₹5,650 — down 27%."
- Superlatives: "biggest expense this month?" → "₹12,000 — rent, on the 2nd."
- Listings: "what did I spend yesterday?" → short list, total on top.
- Rates: "average daily spend?" → "₹930/day this month."
- Credits: per FR-2.3.
- Inference with a limit: vague asks ("how much did Goa cost me?") get at most one clarifying question, then answer.

**Acceptance:** all seven classes answer correctly against seeded data; every answer's first token block is the number.

### FR-10 Weekly digest **[v1.5]**
Sunday ~19:00 IST push, fixed 5-line format, nothing more:
1. Week total vs last week (with direction)
2. Top 3 categories with week-over-week change
3. Single biggest expense
4. Budget health one-liner ("Food at 68%, 12 days left")
5. One plain observation ("Transport doubled — 6 cab rides vs your usual 2")
- FR-10.1 Never promotional, never advice-lecturing. Opt-out with one message ("stop weekly summary"); opt back in likewise.
- FR-10.2 Skip the digest entirely for users with zero entries that week (don't nag ghosts).

## 7. Functional requirements — Budgets & alerts

### FR-11 Budgets **[BUILD]**
- FR-11.1 "food budget 5000" → monthly per-category limit (upsert). "what are my budgets" → each budget with current-month spend vs limit.

### FR-12 Proactive alerts **[BUILD]**
- FR-12.1 Daily check ~20:00 IST: for each budgeted category, alert at ≥80% and again at 100% of limit. `⚠️ Food & Dining: ₹4,150 of ₹5,000 (83%) with 9 days left.`
- FR-12.2 Max one alert per category per threshold per month (sent-alerts ledger enforces).
- FR-12.3 Manual trigger endpoint (`/trigger-alerts`) for the on-stage demo. **[BUILD]** Scheduler itself may fall to the cut order (§12); manual trigger may not.

## 8. Functional requirements — Entry management

### FR-13 Delete last **[BUILD]**
"delete that" / "remove the last one" → soft-delete the most recent entry (in-context), confirm in one line.

### FR-14 Delete from the past **[v1.5]**
- FR-14.1 Natural-language find-and-delete: "delete the 500 chai from Tuesday" → agent finds the entry; exact match → confirm-then-delete; 2–3 candidates → show them, user picks; no match → say so.
- FR-14.2 Forwarded-SMS path: user forwards/re-pastes the original SMS → exact match via stored raw input → confirm-then-delete.
- FR-14.3 All deletion is soft (excluded from every report and query; retained internally per the no-hard-delete audit rule). "undo delete" within the same conversation restores.

### FR-15 Data rights **[BUILD for deletion · v1.5 for export]**
- FR-15.1 "delete everything about me" → confirm once, then purge the user's data (this one is a hard delete — trust obligation trumps audit rule). **[BUILD]**
- FR-15.2 "export my data" → CSV of the user's full ledger. **[v1.5]**

## 9. Functional requirements — Onboarding

### FR-16 First-run flow **[BUILD]**
`/start` → exactly three messages, no forms, no permissions:
1. "Hi, I'm Xpensego. Tell me what you spend, or paste your bank SMS — I'll keep the ledger and answer anything about your money."
2. A sample bank SMS + "try pasting this." Paste → categorized entry appears → product has proven itself in <30s with zero real data at risk.
3. "That's it. Log something real, or set a budget anytime — like *food budget 5000*."
- FR-16.1 Activation event (instrument it): first real (non-sample) logged entry.

## 10. Functional requirements — Shared groups **[v2 — designed now, built on signal]**

### FR-17 Group ledgers
- FR-17.1 Adding @XpensegoBot to a Telegram group makes that group a shared ledger keyed to the chat ID. Membership = Telegram membership; no invite flows built.
- FR-17.2 Any member logs as in DM; the agent records **who paid** (from the sender's identity).
- FR-17.3 Split default: equal among group members. Override inline: "dinner 2400, split with @arjun and @priya only" / "I paid 3000, split 2:1 with @arjun".
- FR-17.4 Debt netting: "who owes whom?" → minimum-transfer settlement set ("Arjun → you ₹800; Priya → you ₹350").
- FR-17.5 Settlements: "settled with Priya" records payment and updates the net.
- FR-17.6 **Personal rollup:** each member's share of group expenses flows into their personal reports ("how much on food this month" in DM includes their slice of the group dinner). This is the differentiator over split-apps; do not cut it from the group design.
- FR-17.7 Isolation: group ledger is visible to group members only; personal ledgers never leak into groups.

**Schema requirement effective NOW [BUILD]:** every ledger row carries `ledger_id` (personal user ID or group chat ID) and `paid_by` from day one. Two columns today; surgery later.

### FR-18 Recurring-expense detection **[v2]**
- FR-18.1 Detect recurring debits from ledger history: same/similar payee + similar amount + regular interval (monthly, weekly) over ≥2–3 cycles. Candidates: rent, subscriptions, EMIs, SIP debits, mobile recharge.
- FR-18.2 Surface, don't assume: on detection, one message — "Netflix ₹649 has hit on the 5th for 3 months. Track it as recurring?" User confirms; never auto-mark.
- FR-18.3 Confirmed recurring entries unlock: "what are my fixed costs?" (monthly committed total vs discretionary spend), a missed-recurrence note ("your rent debit hasn't appeared yet this month"), and an increase alert ("Netflix charged ₹799, up from ₹649").
- FR-18.4 Dependency note: needs several weeks of real ledger data to detect anything — this is why it is v2 by nature, not just by priority. No schema change required now (detection runs on existing rows).

## 11. QA set (build-day, minimum)

- 25 manual-log messages: English + Hinglish mixed ("aaj 200 ka petrol", "bhai ko 500 bheje", "chai 30 auto 80 lunch 250"), relative dates, missing amounts, credits.
- 20-SMS paste corpus (HDFC/SBI/ICICI/Axis/Paytm/GPay formats; include one Blinkit + one Zomato; include 2 credits; include 1 duplicate).
- 7 query classes from FR-9 against seeded data.
- Payee-memory loop: unknown payee → teach → silent auto-categorize on repeat.
- Correction loop: wrong category → "no, that's X" → verify persistence.
- Onboarding: fresh account `/start` → sample paste → real entry.
- Isolation check: two test users; verify zero cross-visibility.

## 12. Build-day cut order (bottom cuts first)

1. CSV upload (FR-4)
2. Alert scheduler (keep manual `/trigger-alerts`)
3. Delete-last (FR-13)
4. Credits parsing in SMS (keep manual credit logging)
Never cut: FR-1, FR-3, FR-5/6, FR-9, FR-16, rehearsal hour, isolation, echoed-date confirmations.

## 13. Non-functional requirements

- **Latency:** manual log confirm <5s; bulk SMS parse <15s for 20 SMS; queries <8s.
- **Isolation:** user_id injected server-side, never model-chosen. **[BUILD]**
- **Auditability:** raw input stored on parsed rows; soft deletes; corrections logged. **[BUILD]**
- **Cost instrumentation:** per-interaction LLM cost logged per user from day one — pricing (open) is blocked on this data. **[BUILD]**
- **Tone contract:** one-line confirmations; number-first answers; ≤1 clarifying question per message; off-topic → brief answer + steer back; alerts and digest are the only proactive contact.

## 14. Out of scope (all tiers, restated)

Pricing/payments (open decision) · WhatsApp channel (v2 gate, tied to unit economics) · automatic SMS ingestion via Android permissions · PDF statements before v2 · multi-currency · investments/credit/loans/insurance · family super-features beyond FR-17 · renaming default categories.

## 15. Metrics (instrument at [BUILD])

Activation (first real entry) · week-2 paste-through rate (target ≥40%; kill/pivot signal <15% per Product Doc §11) · entries per active user per week · query rate · correction rate (categorization-quality proxy) · "Other" category share (taxonomy-gap proxy) · cost per active user per month · alert opt-out rate (post-v1.5: digest opt-out rate).

## 16. Open items

Pricing (blocked on cost + willingness-to-pay data) · WhatsApp timing · v2 build triggers (which §15 signals green-light FR-17 groups and FR-18 recurring) · custom-category cap (10 — revisit on demand) · partner continuation post-event.
