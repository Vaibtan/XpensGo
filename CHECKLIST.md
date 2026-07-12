# Xpensego — Build Checklist

**Source:** PRD v1.0 + Build Spec v2.1 (decision log at its top governs every ticket).
**How to work it:** each ticket is a tracer-bullet vertical slice — demoable on its own, sized for a single fresh context window. Work the frontier: any ticket whose blockers are all done. After ticket 02 lands, tickets 03/04/05 are all on the frontier and can proceed in parallel. Under time pressure, cut in spec §12 order: 07 first, then the alert scheduler (keep the manual trigger), then delete-last, then SMS credit parsing.

---

## 01 — Skeleton + ping-pong bot

**What to build:** a running Telegram bot that two different accounts can talk to independently, backed by the full database schema and reproducible tooling.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] uv project (`pyproject.toml` + committed lockfile); everything runs via `uv run`
- [ ] Config loads bot token, OpenAI key, DB path, alert hour from environment
- [ ] Full spec §4 schema migrates on startup, including `pending_entries` and the group-ready columns (`ledger_id`, `paid_by`)
- [ ] Bot long-polls and answers "ping" → "pong"
- [ ] Two different Telegram accounts get independent replies (M0 verification)

## 02 — Agent loop + manual logging

**What to build:** a user types "chai 30, auto 80, lunch 250" or "spent 500 on groceries yesterday" (English or Hinglish) and gets one ✓ confirmation with the resolved date echoed; every model call is cost-logged; abusers hit static caps.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] OpenAI Responses API tool loop (`strict` schemas, 8-iteration cap, one model: `gpt-5.4-nano`)
- [ ] `log_entries` handles debits and credits; category validated against the 14 defaults
- [ ] Multi-entry message → N rows, one consolidated ✓ confirmation with echoed dates
- [ ] Relative dates resolve against today IST ("yesterday", "last friday", "3 tarikh ko")
- [ ] Conversation context: last 10 messages loaded per turn, pruned past 7 days
- [ ] Every OpenAI call writes a `cost_log` row (no exceptions)
- [ ] Abuse caps: 30 turns/hour and 150/day → static reply with zero LLM calls; 4,000-char input truncation; `BOT_PAUSED` kill switch
- [ ] Tone contract holds: one-line ✓, number-first, ≤1 clarifying question ("auto" alone asks for the amount)

## 03 — SMS paste pipeline

**What to build:** the demo centerpiece — a user pastes 1–50 bank/UPI SMS and gets a compact summary (count, total, top 3 categories, numbered entry list) with at most one question; duplicates are held for confirmation, never silently inserted or dropped; taught payees are never asked about again.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Deterministic split (blank lines + bank-header patterns), then per-SMS extraction calls in parallel; multi-amount chunk falls back to array extraction; failed extraction retries once alone
- [ ] Appendix B corpus: ≥19/20 parsed with correct amount, date, and debit/credit; Blinkit→Groceries and Zomato→Food & Dining
- [ ] Raw SMS text preserved on every parsed row
- [ ] Dedup match → row held in `pending_entries`; "log it" → `resolve_pending` inserts verbatim (server copies fields, model transcribes nothing); "skip" discards; pending rows expire after 24h or on next paste
- [ ] Unknown person-payee inserts immediately as Other, one question asked; the answer recategorizes the entry and teaches payee memory; second transfer to that payee logs silently
- [ ] Credits in SMS (salary, refund) parse as credits
- [ ] Numbered-reply correction works: "2 is groceries" fixes entry 2 from the last summary

## 04 — Structured queries

**What to build:** any of the seven money-question classes gets a number-first, one-line answer; the model fills query slots and never writes SQL; one user can never see another's data.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] `query_ledger` structured tool with metric/type/category/description/date-range/compare-range/group-by slots; ledger scope and soft-delete filter injected server-side on every query
- [ ] All 7 FR-9 classes answer correctly on seeded data: totals, comparisons, superlatives, listings, rates, credits-only, merchant substring ("how much at blinkit")
- [ ] Spend answers count debits only; credits appear only when asked
- [ ] Every answer leads with the number
- [ ] Isolation check: user B's totals are ₹0 after user A logs (QA #26)
- [ ] Inexpressible question → graceful "can't answer that yet", no heroics

## 05 — Budgets + alerts + manual trigger

**What to build:** "food budget 5000" sets a monthly limit; crossing 80% or 100% of it produces exactly one proactive ⚠️ warning per threshold per month; a local admin endpoint fires the check on demand for the on-stage demo.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] `manage_budget` set/list; list shows current-month debit spend vs limit with percentage
- [ ] Daily scheduled check at 20:00 IST computes month-to-date debits per budgeted category
- [ ] ⚠️ alert at ≥80% and ≥100% with days-left; `alerts_sent` ledger guarantees once per category/threshold/month
- [ ] Manual trigger endpoint (localhost only) runs the same check immediately; second trigger sends nothing (M4 verification)
- [ ] Scheduler is cuttable; the manual trigger is not

## 06 — Onboarding + corrections + deletion + purge

**What to build:** a fresh account's `/start` proves the product in under 30 seconds via a dry-run sample SMS that never touches the ledger; corrections stick; "delete that" works; "delete everything about me" purges after one confirmation.

**Blocked by:** 02, 03 (sample dry run reuses the parse pipeline).

**Status:** ready-for-agent

- [ ] `/start` → three fixed (hardcoded) messages; sample SMS carries reserved UPI ref `000000424242`
- [ ] Sample paste runs real extraction + categorization and shows the real ✓, but inserts nothing
- [ ] `onboarded_at` set on first real entry (activation event instrumented)
- [ ] "no, that's groceries" → `recategorize_entry` updates the last entry and payee memory where a payee is involved; persists across turns (QA #23)
- [ ] "why did you categorize this as X?" → stored raw input + reasoning in two lines
- [ ] "delete that" → soft-delete newest live entry, one-line confirm, excluded from all queries
- [ ] "delete everything about me" → exactly one confirmation question → hard-delete across all user tables; `cost_log` anonymized, not deleted (QA #25)
- [ ] Off-topic message → one brief sentence + steer back (QA #27)

## 07 — CSV statement upload

**What to build:** a user sends a CSV bank statement as a document and gets the same parse summary as an SMS paste; a malformed CSV gets one graceful question instead of an error.

**Blocked by:** 03.

**Status:** ready-for-agent — first to cut under time pressure

- [ ] Document download → same pipeline from categorization onward, source marked as statement
- [ ] Date/amount/description columns auto-detected from header; undetectable → one question
- [ ] Caps enforced: 500 rows / 1 MB
- [ ] Dedup and pending behavior identical to SMS path

## 08 — Demo seed + QA + rehearsal

**What to build:** the full on-stage demo (paste → categorized summary → query → budget alert) runs end-to-end twice without intervention on the demo laptop, against seeded data, with the QA set green.

**Blocked by:** 02, 03, 04, 05, 06 (07 optional).

**Status:** ready-for-agent

- [ ] Demo seeder creates the rehearsal user and data
- [ ] Automatable Appendix A cases pass as tests (manual-log set, 7 query classes, correction/deletion/purge/isolation flows)
- [ ] 20-SMS demo paste block parses live; duplicate SMS #8 held and resolved on stage
- [ ] Budget alert fires on stage via the manual trigger
- [ ] Full demo script runs twice, no intervention, on the same machine that will present
