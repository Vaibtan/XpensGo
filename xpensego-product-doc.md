# Xpensego — Product Document (v0.2)

**Product name:** Xpensego (confirmed)
**Author:** Black · **Status:** Draft for review
**Origin:** 8-hour buildathon (Revenue track, Hermes required) treated as the seed of a real product, not a throwaway prototype.
**Related docs:** PRD v1.0, Build Spec v2.1, Demo Script (PRD companion).

---

## 1. One-liner

Xpensego is an expense agent that lives in your messaging app. Paste your bank SMS or just tell it what you spent — it categorizes everything correctly, answers any question about your money in plain language, and warns you before a budget blows.

## 2. The problem

Indian consumers do not lack expense *data* — every transaction already generates a bank SMS, a UPI notification, or a statement line. What they lack is expense *meaning*. The existing tools fail in a specific, consistent way: automatic trackers (bank apps, Jupiter, Axio, ET Money) capture transactions effortlessly but categorize them badly — a Blinkit grocery run and a Zomato dinner both land in "Food," rent transfers show up as "UPI to person," and the insights tab becomes noise the user stops opening. Manual trackers get categories right but demand a daily data-entry habit that almost nobody sustains past week three; this is the pattern that killed a generation of Indian expense apps.

The result is a population that is transacting digitally at massive scale and still answering "how much did I spend on food this month?" with a guess.

An important honesty note carried over from early scoping: **the depth of categorization pain as a paid problem is asserted, not yet evidenced.** Validating that users notice and care about miscategorization — enough to change behavior or pay — is an explicit early milestone, not an assumption to build on silently. (See §10, Risks.)

## 3. Who it's for

**Primary persona (v1):** the digitally-fluent Indian consumer, roughly 22–35, salaried or freelancing, transacting predominantly through UPI and cards, living inside WhatsApp and Telegram all day. They have tried an expense app at least once and abandoned it. They don't want a new app, a dashboard, or a habit — they want answers when they ask and a warning before they overspend.

**Deliberately deferred (v2 candidate):** small business owners tracking business expenses over chat. This segment likely has higher willingness to pay (tax pressure, CA relationships, GST) and fits Black's B2B background, but v1 stays B2C to validate the core categorize-and-converse loop with the simplest possible user. This deferral is a conscious decision, revisit after buildathon signal.

## 4. Why now

Three curves are crossing. UPI has made every spend a text-visible event, so the raw data problem is solved nationally. LLMs have made messy-text-to-clean-category a solved problem at near-zero marginal engineering cost — categorization quality, the thing incumbents fumble with rules engines, is now a prompt-and-evals problem (and Black has a direct asset here: Aurum's categorization engine runs at 96.4% accuracy, so the hardest capability is a port, not an invention). And chat-native agents have normalized the interface: users no longer need convincing that "text a bot" is a product.

## 5. The product

Xpensego is a Telegram agent (WhatsApp later) with three capabilities and deliberately nothing else.

**Capture without discipline.** The user pastes bank/UPI SMS — one or fifty — or drops a CSV statement, and Xpensego extracts and categorizes every debit. Manual logging ("chai 30, auto 80") works too, for cash and the gaps. The design principle: the user should never *owe* Xpensego a habit; they feed it whatever they already have, whenever they remember.

**Categorization that's actually right.** A fixed 14-category taxonomy tuned for Indian spending (the Blinkit-vs-Zomato split is the flagship example), plus a per-user payee memory: when Xpensego asks once what a UPI transfer to a person was for, it never asks about that payee again. Corrections are conversational — "no, that's groceries" — and stick.

**Answers and warnings, not dashboards.** Any question about spending gets a number-first answer in one message. Budgets are set in one line ("food budget 5000") and Xpensego proactively messages when a category crosses 80% and 100% of its limit. There is no app to open. The agent comes to you exactly twice a month per category at most, and only when it matters.

## 6. Positioning

**Against auto-trackers (Jupiter, Axio, bank apps):** they capture everything and understand nothing; Xpensego understands. Their insights are a tab you forget; Xpensego's are a message you receive.

**Against manual trackers and spreadsheets:** they demand discipline; Xpensego demands nothing. Paste when you feel like it — the ledger stays coherent.

**Against "just use ChatGPT":** a general chatbot has no persistent ledger, no per-payee memory, no proactive alerts, and forgets you between sessions. Xpensego is an agent with state, not a conversation.

**Positioning sentence:** *Your bank already tells you everything. Xpensego makes it mean something.*

## 7. What Xpensego is not (scope guardrails)

Not a personal finance super-app: no investments, no credit scores, no loans, no insurance. Not an auto-ingestion service in v1: no Android SMS-permission integration (a privacy, trust, and Play Store rabbit hole — pasting is the v1 contract). Not a general assistant: off-topic messages get a brief answer and a steer back. Not a family/shared ledger yet. Not priced yet — see §9.

## 8. Product principles

One: never require a habit; reward whatever the user gives. Two: one-line responses; the number first; no lectures. Three: never ask two questions in one message. Four: every correction teaches the system permanently (payee memory). Five: proactive contact is rare, budget-linked, and never promotional. Six: the user's data is theirs — per-user isolation is architectural (enforced in the API layer, never trusted to the model), and no customer data touches shared agent memory.

## 9. Business model — explicitly open

**Pricing is not decided.** A ₹50/month figure was floated early and retired: it was chosen for psychological plausibility, not derived from unit economics, and preliminary reasoning suggests engaged-user infra costs (LLM calls, and WhatsApp conversation fees if/when that channel ships) could exceed it. Before any price is set, the following must exist: measured cost per active user per month from real usage, willingness-to-pay signal from actual trial users, and a decision between subscription, freemium-with-caps, or an alternate model (e.g., free consumer tier funding a paid small-business tier).

**What is decided:** the monetizable asset is the categorized, queryable ledger and the proactive-alert layer on top of it — not capture, which is free everywhere and monetizes nowhere. The Revenue-track story is honest: "the retention hook is built; pricing is in validation."

## 10. Risks — stated plainly

**Demand risk (biggest):** categorization pain may be a shrug, not a purchase. Users may not notice miscategorization because they never open insights at all — in which case the problem isn't bad categories, it's indifference, and Xpensego inherits it. Mitigation: the buildathon and immediate post-launch trials are structured to test this first (see §11).

**Behavior risk:** even pasting SMS is a habit of sorts. If users won't paste weekly, the ledger goes stale and answers lose value. Mitigation: the alert layer creates a reason to keep the ledger fed; measure paste-frequency decay from day one.

**Graveyard risk:** this category has killed many funded attempts (Walnut et al.). The bet is that the failure mode was manual-entry discipline plus dashboard interfaces, both of which Xpensego removes. That is a thesis, not a fact.

**Moat risk:** everything here is buildable by an incumbent in a quarter. Near-term defensibility is speed, categorization quality (Aurum head start), and per-user payee memory that compounds. Long-term defensibility is unresolved.

**Platform risk:** Telegram penetration in India is far below WhatsApp's; WhatsApp Business API adds cost and approval friction. v1 accepts Telegram's smaller reach for zero-friction launch; the WhatsApp decision is a v2 gate tied to unit economics.

## 11. Success criteria

**Buildathon day:** the live demo lands (SMS paste → categorized table → query → on-stage budget alert), judges register the architecture and honesty of the revenue story, and — the real prize — at least 10 people in the room add the bot and log something real.

**First 30 days after:** 50+ real users acquired without paid spend; ≥40% paste transactions in week 2 (the behavior-risk test); a measured cost-per-active-user number; 10 user conversations that produce direct evidence for or against the categorization-pain thesis.

**Kill/pivot signal:** if week-2 paste-through falls under 15% and user conversations show indifference to category accuracy, the B2C thesis is weak — pivot evaluation toward the small-business segment rather than pushing consumer harder.

## 12. Roadmap sketch

**v1 (buildathon):** Telegram · SMS paste + manual log + CSV · 14-category taxonomy · payee memory · natural-language queries · budgets + alerts.
**v1.5 (weeks 1–4):** onboarding polish · correction flows hardened · usage/cost instrumentation · pricing research.
**v2 (conditional on signal):** WhatsApp channel · pricing live · small-business/GST mode evaluation · PDF statements.

## 13. Open decisions (owner: Black)

Pricing model and price (blocked on §9 prerequisites). B2C persistence vs small-business pivot criteria (draft in §11, confirm). WhatsApp timing. Whether buildathon partner continues post-event and on what terms.
