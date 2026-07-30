# Xpensego — Feature Opportunity Map (verified research, 12 Jul 2026)

> **Status:** Research input, not committed roadmap. The Product Document and PRD decide what is built and when. Opportunity ordering in this document must be re-evaluated against core-product validation, implementation readiness, cost, and trust requirements.

**Method:** deep-research workflow — 5 search angles, 22 sources fetched, 105 claims extracted, top 25 adversarially verified (3 independent refuters per claim). 17 confirmed, 8 refuted. Confirmed claims support factual statements; thin or unresolved evidence is labelled where an opportunity remains a hypothesis. Refuted claims are listed at the bottom so they are not reused as evidence.
**Companion docs:** [Product Document](./xpensego-product-doc.md) · [PRD](./PRD.md) · [Technical Specification](./SPEC.md).

---

## Product review outcome (29 Jul 2026)

This research supports the direction of the roadmap but no longer defines its sequence:

- Shared ledgers are the strongest feature experiment after the core product is validated; Splitwise dissatisfaction does not by itself prove conversion into paid personal-finance use.
- Recurring-expense detection is a post-signal intelligence candidate. The data model should not block it, but user-facing detection waits for enough reliable longitudinal data.
- "Can I afford this?" is treated as a disclosed projection, not an affordability verdict, and requires better income, balance, liability, and recurring-cost coverage than the initial ledger provides.
- Account Aggregator work remains partner and regulatory discovery before implementation.
- Tax exports require direct demand evidence.
- Receipt OCR, voice, investments, and net-worth expansion remain on hold.

The Product Document's success gates and the PRD's requirement tags govern all of these decisions.

---

## The three verified market facts that should drive the roadmap

**1. Feature quality does not equal a business (Fi Money, March 2026).** Fi built exactly what we're building — the "Ask Fi" natural-language assistant and intelligent categorization — and still wound down its banking platform in March 2026 after burning ₹301 Cr against ₹38 Cr revenue (FY23), redirecting ~3.5M customers to Federal Bank. Root cause: low transaction fees, high CAC, no path from insight to revenue. *(TechCrunch 11 Mar 2026; valueforstartups.in; techbuzz.ai — verified 3-0)*

**2. A chat-native money agent can retain and charge (Cleo).** ~7M users, ~700K paying (~10% free-to-paid), ~$214 ARPC, tiers $5.99–$14.99/mo, 59% of 2023 revenue from subscriptions. Proactive alerts + conversational insights + goals are the retention core. Caveats: US market, 41% of revenue from cash advances/lending we won't build, and a March 2025 FTC settlement ($17M) over advance/cancellation practices. *(Sacra, Sifted, meetcleo.com pricing — verified 3-0 / 2-1)*

**3. Splitwise handed us a wedge.** It paywalled previously-free core expense entry (free tier capped at ~3 expenses/day, Pro $4.99/mo) and triggered documented backlash and user exodus ("leaving them in droves"). Shared/split expense tracking is the one whitespace in our candidate list with *verified* user-demand evidence. *(Splitwise helpdesk confirms the cap; technofino.org; @ArtemR — verified 3-0)*

Supporting facts: Axio/Walnut's silent SMS-permission parsing demonstrably misses transactions (real-time gaps for some banks, breaks on format changes/dual-SIM/regional-language SMS, blocked on iOS — verified 3-0). India's Account Aggregator ecosystem is scaling fast (5.96 Cr PFM users, 164% CAGR since FY23, 90–135+ live FIPs) but **every stat is Sahamati self-reported**, and consuming AA data requires being — or partnering with — an RBI/SEBI/IRDAI/PFRDA-regulated FIU (verified 3-0). AA does **not** eliminate manual entry (refuted 0-3): cash, P2P detail, and ~38% account enablement remain gaps.

---

## Prioritized feature opportunities from the research

### Tier 1 — highest-value post-core opportunities

**F1. Group ledgers + splits in chat — strongest bounded experiment after core validation.**
- *Demand evidence:* the Splitwise backlash (verified, above) is the strongest demand signal in the entire research run.
- *Why incumbents fail:* Splitwise charges for entry itself; split-apps have no personal-ledger side, so a group dinner never shows up in "how much on food this month."
- *Our fit:* add Xpensego to a messaging group and connect shared spending to each member's personal ledger. Personal rollup remains the differentiator to test.
- *Positioning hypothesis:* keep core split entry in the free tier during the experiment and test whether that creates acquisition or retention. Do not make a permanent public pricing promise before the Product Document's pricing evidence exists.
- *Product gate:* first prove that group use creates acquisition or retention rather than only messaging and support cost, and that personal/shared isolation is understandable.
- *Effort:* medium-high — membership, authorization, split math, debt netting, settlements, personal rollups, and channel-specific group behavior.

**F2. Recurring-expense detection — first post-signal intelligence candidate and a foundation for F3.**
- *Demand evidence:* moderate (category tables everywhere list it; not independently verified as top-demand).
- *Why it matters:* it unlocks "fixed costs vs discretionary," missed-rent notes, price-increase alerts (Netflix ₹649→₹799), credit-card bill reminders — and F3 is impossible without it.
- *Product gate:* preserve the required data, then wait for enough reliable longitudinal usage to build and evaluate detection against real patterns.
- *Effort:* low-medium once reliable history exists — pattern detection over normalized counterparties, amounts, and intervals; surface candidates for confirmation per PRD FR-23.

**F3. "Can I afford this?" — cash-flow forecast answered in one message.**
- *Demand evidence:* Cleo shipped exactly this (projected month-end spend, "would this leave you in the red," savings timelines — verified). One source frames backward-tracking + forward-planning in one tool as unfilled whitespace (thin, blog-grade).
- *Why incumbents fail:* Indian trackers are entirely backward-looking; none answers a forward question.
- *Our fit:* pure conversational territory — "what would buying a ₹40k phone do to this month's projected cash flow?" can produce a concise estimate.
- *Product gate:* disclose missing balances, income, liabilities, and recurring costs; do not present incomplete records as a verdict or financial advice.
- *Effort:* medium-high — projection inputs, recurring-cost output, confidence, assumptions, and one new structured query capability.

### Tier 2 — strategic bets (verified enabler, gated or needs validation)

**F4. Account Aggregator auto-fetch via FIU partnership — the ingestion moat, sequenced later.**
- *Verified:* AA is real and scaling; the regulatory gate is hard (must partner with or become a regulated FIU); AA does *not* replace manual capture (cash/P2P gaps).
- *PM read:* paste stays the v1 contract. Scope a TSP/FIU partnership (Setu, Finvu, OneMoney-class) as a v3 track: "connect your bank once, consented, RBI-framework" kills both our paste-friction *and* Axio's fragile SMS-permission model — and the partnership requirement is a barrier that protects whoever crosses it first at our size.
- *Action now:* one scoping conversation with a TSP to learn cost/timeline. No build.

**F5. Tax-season exports (HRA rent proof, 80C summary) — cheap, seasonal retention hook.**
- *Demand evidence:* thin in this research run (explicitly an open question). India logic is strong: we already know rent payments (payee memory) and insurance/ELSS debits; a one-message "HRA bundle for FY25-26" or "my 80C so far" is a January–July reason to keep the ledger fed.
- *Effort:* low — query + CSV/PDF export over existing data. Validate demand in the 10 planned user conversations before building.

### Tier 3 — hold / don't build yet

- **Receipt OCR** and **voice logging**: no demand evidence surfaced; voice is cheap on Telegram (transcribe → same pipeline) — nice-to-have, not a differentiator.
- **Net-worth / multi-account view, investments**: explicitly deferred in Product Document §8 — stays out; Fi died with this feature set.
- **Small-business/GST mode**: remains the pivot option described in Product Document §§3, 11, and 14, not a parallel build.
- **Cancellation nudges**: F2's price-increase/recurring alerts cover the valuable 80%; "cancel for you" requires merchant integrations that don't exist in India.

---

## Monetization guardrails the evidence supports

1. **Design the revenue engine now, not after traction** — Fi's lesson. Instrumented cost-per-user (PRD FR-20) + a priced tier hypothesis should exist before scale marketing.
2. **Avoid bait-and-switch pricing** — Splitwise's lesson. Publish a clear free/paid boundary before public launch and do not revoke an explicit user promise. The working hypothesis keeps core capture and any bounded split experiment in the free foundation while paid value comes from *intelligence and automation*: forecasting (F3), AA auto-fetch (F4), tax bundles (F5), and longer history. Final entitlements remain a product decision informed by Xpensego's own evidence.
3. **Benchmark, don't copy, Cleo's pricing** — ~10% conversion and $6–15/mo are US numbers; no reliable India WTP datapoint survived verification (the Fi Premium claim was refuted). India pricing needs our own trial data per Product Document §10.

## Open questions (research could not resolve)

1. FIU-partnership practicalities: cost, timeline, revenue share for a pre-revenue startup (needs direct TSP conversations, not web research).
2. Indian WTP for a pure tracking/insights subscription with no lending attached — no reliable figure exists; must come from our own trials.
3. A trustworthy D30/D90 retention benchmark for this category (the widely-quoted 4.2% D30 figure failed verification).
4. Demonstrated Indian demand for tax exports, voice logging, OCR — validate in the 10 user conversations before any Tier-2/3 build.

## Refuted claims — do not cite these

- "Reimbursement/settlement netting is the top-upvoted Axio gap" (0-3).
- "Cleo: ~50% free-to-paid, $11 CAC, $280M ARR, lending-dominant revenue" (0-3).
- "Finance-category D30 retention is ~4.2%" (0-3).
- "Fi Premium's failure proves low Indian WTP" (0-3).
- "Your-bank-not-on-AA is now moot" and "AA eliminates manual uploads" (both 0-3).
- "Pure-subscription budgeting is a capped ~$100M market" (1-2, unproven).

## Key sources

Axio/Walnut Play Store listing + axio.co.in · Splitwise helpdesk + technofino.org + @ArtemR thread · Sacra/Sifted/meetcleo.com (Cleo) · TechCrunch 11 Mar 2026 + valueforstartups.in (Fi) · Sahamati FY26 report via investmentguruindia/newkerala · casparser.in State of AA 2026 (FIU gate) · monarch.com/for-couples (household-ledger pattern) · medium.com/meetcleo ("can I afford")
