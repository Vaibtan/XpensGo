# Xpensego — Build Spec v2.1 (for the coding agent)

**Companion:** PRD v1.0 (feature tiers + acceptance criteria). Where this spec and the PRD conflict, the PRD's product intent wins; flag the conflict instead of guessing.
**Scope of this build:** PRD items tagged [BUILD] only. Do not implement [v1.5] or [v2] features, but the schema below already accommodates them — implement the schema exactly as written.

**Decision log (locked 12 Jul 2026):** OpenAI Responses API, `gpt-5.4-nano` everywhere (one model) · laptop long-polling for build day, hosting deferred to week 1 · `query_ledger` is a structured slot-filling tool, the model never writes SQL · parse-time duplicates held in `pending_entries`, confirmed via `resolve_pending` (no re-parse, no model transcription) · unknown payees insert immediately as Other, recategorized on answer · onboarding sample SMS is a dry run with a reserved UPI ref, never inserted · SMS pastes split deterministically, extracted per-SMS in parallel · dependencies via uv.

---

## 0. Mission

Build a Telegram expense agent: users log expenses/income in natural language (English or Hinglish), paste bank SMS, or upload CSV statements; the agent extracts and categorizes entries, answers money questions number-first, and sends budget alerts. Multi-user from the first commit. This runs live in front of judges and strangers at an 8-hour buildathon — reliability of the core loop beats feature count.

## 1. Non-negotiable constraints

These override any implementation convenience. Violating any of them is a failed build even if everything "works."

1. **Isolation:** `user_id` comes from the Telegram update, injected server-side into every DB operation. The LLM never chooses, sees, or outputs another user's ID. No tool accepts a user_id parameter from the model.
2. **Debits-only math:** spend totals, budgets, and alerts compute over `type='debit'` only. Credits are recorded and separately queryable, never netted in unless the user explicitly asks for "net".
3. **Date echo:** every logging confirmation displays the resolved date (`✓ ₹500 · Food & Dining — 03/07/26`). No silent date assumptions.
4. **Soft delete everywhere** (`deleted_at` timestamp; every read filters `deleted_at IS NULL`) **except** the user command "delete everything about me", which hard-deletes all rows for that user after one confirmation.
5. **Cost logging:** every OpenAI API call is wrapped; log user_id, operation, model, input/output tokens, computed cost to `cost_log`. No exceptions, including onboarding.
6. **Tone contract:** one-line confirmations; answers lead with the number; at most ONE clarifying question per agent message; off-topic input → one brief sentence + steer back to expenses; no financial advice lectures; no emojis except ✓ on confirmations and ⚠️ on alerts.
7. **Raw input preservation:** every SMS/statement-parsed row stores the original text in `raw_input`.
8. **Abuse controls (the bot is public from day one):** per-user cap of 150 agent turns/day and 30/hour (over cap → polite static message, no LLM call); inbound text truncated at 4,000 characters; CSV uploads capped at 500 rows / 1 MB; a `BOT_PAUSED` env flag that makes the bot reply with a static maintenance line (global kill switch if the API bill runs away).

## 2. Stack

- **Python 3.11+**, FastAPI, uvicorn.
- **python-telegram-bot** v21+ (async), **long polling** for the buildathon (no public URL/webhook dependency; switchable later).
- **openai** SDK via the **Responses API** (tool calling with `strict: true` function schemas). Model: `gpt-5.4-nano` for the agent loop and parsing. One model everywhere; do not mix.
- Dependencies managed with **uv** (`pyproject.toml` + committed `uv.lock`); run everything via `uv run` — the dev laptop is the demo machine, so reproducibility is the point.
- **SQLite** via `aiosqlite`, single file `xpensego.db`. All DDL kept Postgres-compatible (no SQLite-only types in schema design).
- **APScheduler** (AsyncIOScheduler) for the daily alert job.
- Config via environment: `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `DB_PATH` (default `./xpensego.db`), `ALERT_HOUR_IST` (default 20).

## 3. Project structure

```
xpensego/
├── main.py               # entrypoint: starts bot polling + scheduler + FastAPI (admin endpoints)
├── config.py             # env loading
├── db.py                 # connection, migrations (schema below), query helpers
├── agent/
│   ├── loop.py           # per-message agent loop (OpenAI Responses tool loop)
│   ├── system_prompt.py  # builds the system prompt (template in §7)
│   └── tools.py          # tool JSON schemas + dispatch to handlers
├── handlers/
│   ├── entries.py        # log_entries, delete_last_entry, purge handlers
│   ├── parsing.py        # parse_transactions (SMS + CSV path)
│   ├── queries.py        # query_ledger (guarded SQL, §6.3)
│   ├── budgets.py        # manage_budget
│   └── payees.py         # payee_memory read/write
├── telegram/
│   ├── bot.py            # update handling, /start onboarding, file download (CSV)
│   └── send.py           # outbound messages (also used by alerts)
├── alerts.py             # daily budget check + /trigger-alerts logic
├── costs.py              # OpenAI call wrapper with cost_log writes
├── seed_demo.py          # seeds demo user data for rehearsal
└── tests/
    ├── test_qa_set.py    # Appendix A cases
    └── sms_corpus.py     # Appendix B as fixtures
```

## 4. Database schema (implement exactly; includes v1.5/v2 accommodation)

```sql
CREATE TABLE users (
  user_id        TEXT PRIMARY KEY,        -- Telegram user id as string
  display_name   TEXT,
  onboarded_at   TEXT,
  digest_opt_out INTEGER DEFAULT 0,       -- v1.5 field, present now
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id   TEXT NOT NULL,              -- 'user:<user_id>' now; 'group:<chat_id>' in v2
  user_id     TEXT NOT NULL,              -- who logged it
  paid_by     TEXT NOT NULL,              -- who paid; == user_id for personal ledgers
  type        TEXT NOT NULL CHECK (type IN ('debit','credit')),
  amount      REAL NOT NULL CHECK (amount > 0),
  category    TEXT NOT NULL,
  subcategory TEXT,
  description TEXT,
  txn_date    TEXT NOT NULL,              -- 'YYYY-MM-DD'
  source      TEXT NOT NULL CHECK (source IN ('manual','sms','statement','receipt')),
  raw_input   TEXT,
  deleted_at  TEXT,                       -- soft delete; NULL = live
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_entries_ledger_date ON entries(ledger_id, txn_date);
CREATE INDEX idx_entries_dedup ON entries(ledger_id, amount, txn_date);

CREATE TABLE pending_entries (             -- parse-time duplicates awaiting user confirmation
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('debit','credit')),
  amount      REAL NOT NULL CHECK (amount > 0),
  category    TEXT NOT NULL,
  description TEXT,
  txn_date    TEXT NOT NULL,
  source      TEXT NOT NULL,
  raw_input   TEXT,
  reason      TEXT NOT NULL DEFAULT 'duplicate',
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE budgets (
  ledger_id     TEXT NOT NULL,
  category      TEXT NOT NULL,
  monthly_limit REAL NOT NULL CHECK (monthly_limit > 0),
  PRIMARY KEY (ledger_id, category)
);

CREATE TABLE payee_memory (
  user_id  TEXT NOT NULL,
  payee    TEXT NOT NULL,                 -- normalized: lowercase, UPI VPA or person name
  category TEXT NOT NULL,
  PRIMARY KEY (user_id, payee)
);

CREATE TABLE custom_categories (           -- v1.5 table, present now, unused in build
  user_id  TEXT NOT NULL,
  name     TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE conversation_context (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_ctx_user ON conversation_context(user_id, id);

CREATE TABLE alerts_sent (
  ledger_id TEXT NOT NULL,
  category  TEXT NOT NULL,
  month     TEXT NOT NULL,                -- 'YYYY-MM'
  threshold INTEGER NOT NULL CHECK (threshold IN (80,100)),
  sent_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (ledger_id, category, month, threshold)
);

CREATE TABLE cost_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT,
  operation     TEXT NOT NULL,            -- 'agent_turn','parse_sms','parse_csv','alert_check'
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
);
```

Schema rules for all code: every entries read includes `deleted_at IS NULL`; every write sets `ledger_id = 'user:' || user_id` and `paid_by = user_id` (group values are v2); "delete everything about me" hard-deletes the user's rows from every table above. `pending_entries` rows are ephemeral: auto-discard rows older than 24h, and discard the user's leftover pending rows at the start of their next paste.

## 5. Message flow (per Telegram update)

1. Update arrives → extract `user_id`, upsert `users` row.
2. `/start` → onboarding flow (§8), bypasses the agent loop for message 1–2.
3. Document attachment (CSV) → download, run `parse_transactions` with `source='statement'`.
4. Text → load last 10 `conversation_context` rows for this user → build system prompt (§7, includes today's date in IST and the user's known payees count) → run the agent loop (§6) → send reply → append user message and assistant reply to `conversation_context` → prune context rows older than 7 days.
5. Any OpenAI call goes through `costs.py` wrapper.

## 6. Agent loop & tools

Standard OpenAI Responses API tool loop: call `client.responses.create()` with the conversation input and tool definitions (`strict: true` on every schema); while the response output contains `function_call` items, execute each server-side and send back matching `function_call_output` items (chaining with `previous_response_id`); cap at 8 tool iterations per turn; on cap, reply asking the user to simplify.

### 6.1 Tool: `log_entries`
```json
{
  "name": "log_entries",
  "description": "Record one or more expense (debit) or income (credit) entries the user stated in their message. Resolve all relative dates before calling. Use payee memory: if the user names a payee you have a stored category for, use it silently.",
  "input_schema": {
    "type": "object",
    "properties": {
      "entries": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "type": {"type": "string", "enum": ["debit","credit"]},
            "amount": {"type": "number", "exclusiveMinimum": 0},
            "category": {"type": "string"},
            "description": {"type": "string"},
            "txn_date": {"type": "string", "description": "YYYY-MM-DD, already resolved"},
            "payee": {"type": "string", "description": "normalized payee if this teaches or uses payee memory"}
          },
          "required": ["type","amount","category","description","txn_date"]
        }
      },
      "teach_payee": {
        "type": "object",
        "description": "Set when the user just told you what a payee is for",
        "properties": {"payee": {"type": "string"}, "category": {"type": "string"}},
        "required": ["payee","category"]
      }
    },
    "required": ["entries"]
  }
}
```
Handler: validate category against the 14 defaults (reject others with an error the model can react to); insert rows (`source='manual'`); write `teach_payee` to payee_memory; return inserted rows with ids so the model can compose the ✓ confirmation with echoed dates.

### 6.2 Tool: `parse_transactions`
```json
{
  "name": "parse_transactions",
  "description": "Parse pasted bank/UPI SMS text (one or many messages) into structured entries. Call with the full raw pasted text. The server inserts what it can, holds duplicates as pending, and returns everything with ids; you then present the summary and ask at most one question (duplicates or first unknown payee).",
  "input_schema": {
    "type": "object",
    "properties": {
      "raw_text": {"type": "string"}
    },
    "required": ["raw_text"]
  }
}
```
Handler pipeline:
1. **Split deterministically** — blank lines plus the bank-header patterns evident in Appendix B (`HDFC Bank:`, `Dear Customer`, `Dear SBI User`, `ICICI Bank`, `Axis Bank:`, `INR … debited`, `Paid Rs.`, `You paid ₹`). The chunk count grounds the "N parsed" the user sees.
2. **Extract per chunk, in parallel** — one extraction call per SMS chunk via `asyncio.gather` (structured JSON out: merchant, amount, date, type, upi_vpa). Fallback: if a chunk appears to contain multiple amounts (splitter missed a boundary), that chunk's call asks for an array. A failed extraction retries once, alone.
3. **Categorize** — merchant map from §7 taxonomy + payee_memory lookup. Person-payees with no stored category insert immediately as `Other` (never held); the agent asks the one payee question and the answer fires `recategorize_entry` + `teach_payee`.
4. **Dedup check** — same ledger + amount + txn_date + fuzzy description ≥ 0.8 similarity. Non-duplicates insert with `source='sms'`, `raw_input` = the original SMS. Duplicates go to `pending_entries` (never silently inserted, never silently dropped).
5. **Return** `{inserted: [{id, ...}], pending: [{pending_id, ...}], unknown_payees: [...]}`. The agent reports: count, total, top 3 categories, a short numbered list of the inserted entries (so "2 is groceries" works per FR-3.5), and at most one question (duplicate confirm or first unknown payee).

CSV path: same handler from step 3 onward, rows from CSV columns (auto-detect date/amount/description columns from the header; ask if undetectable), `source='statement'`.

### 6.3 Tool: `query_ledger` (structured — the model never writes SQL)
```json
{
  "name": "query_ledger",
  "description": "Answer a money question from the user's own ledger by filling slots; the server runs the SQL. Spend questions use type='debit' (the default). For comparisons ('this week vs last week'), set the compare_* range. Every result row includes entry ids where applicable.",
  "input_schema": {
    "type": "object",
    "properties": {
      "metric": {"type": "string", "enum": ["total", "list", "max", "avg_per_day", "count", "budget_status"]},
      "type": {"type": "string", "enum": ["debit", "credit", "all"]},
      "category": {"type": "string", "description": "one of the 14 categories; omit for all"},
      "description_contains": {"type": "string", "description": "substring match on description/merchant, e.g. 'blinkit'"},
      "date_from": {"type": "string", "description": "YYYY-MM-DD inclusive"},
      "date_to": {"type": "string", "description": "YYYY-MM-DD inclusive"},
      "compare_date_from": {"type": "string"},
      "compare_date_to": {"type": "string"},
      "group_by": {"type": "string", "enum": ["category", "txn_date", "none"]}
    },
    "required": ["metric", "date_from", "date_to"]
  }
}
```
Handler — slot-filling replaces the SQL guard (decision log):
1. Dispatch each metric to hand-written parameterized SQL. `ledger_id = 'user:<id>'` and `deleted_at IS NULL` are injected server-side on every query — isolation never depends on model output. `type` defaults to `debit`.
2. Metrics: `total` (SUM, optionally grouped), `list` (rows with id, type, amount, category, description, txn_date — capped at 200, newest first), `max` (single largest entry), `avg_per_day` (SUM / days in range), `count`, `budget_status` (each budget with current-range debit total).
3. When `compare_date_from/to` is set, run the same query over the second range and return both results so the model can phrase the comparison.
4. Coverage of the seven FR-9 classes: totals→`total`, comparisons→`compare_*`, superlatives→`max`, listings→`list`, rates→`avg_per_day`, credits→`type:'credit'`, merchant questions→`description_contains`. A question the schema can't express → the model answers "can't answer that yet" honestly (schema extension is a v1.5 task, not a build-day heroic).

### 6.4 Tool: `manage_budget`
```json
{
  "name": "manage_budget",
  "description": "Set or read monthly category budgets.",
  "input_schema": {
    "type": "object",
    "properties": {
      "action": {"type": "string", "enum": ["set","list"]},
      "category": {"type": "string"},
      "monthly_limit": {"type": "number", "exclusiveMinimum": 0}
    },
    "required": ["action"]
  }
}
```
Handler: `set` upserts; `list` returns each budget with current-month debit total. Model formats: `Food & Dining: ₹3,150 of ₹5,000 (63%)`.

### 6.5 Tool: `delete_last_entry`
```json
{
  "name": "delete_last_entry",
  "description": "Soft-delete the user's most recently created live entry. Use when the user says 'delete that' / 'remove the last one'.",
  "input_schema": {"type": "object", "properties": {}}
}
```
Handler: set `deleted_at` on the newest live row for the ledger; return the deleted entry so the model confirms in one line ("Removed ₹450 · Entertainment — 04/07/26").

### 6.6 Tool: `purge_my_data`
```json
{
  "name": "purge_my_data",
  "description": "PERMANENTLY delete all data for this user. Only call after the user has explicitly confirmed in this conversation ('yes, delete everything'). If they have not yet confirmed, do not call — ask the single confirmation question instead.",
  "input_schema": {
    "type": "object",
    "properties": {"user_confirmed": {"type": "boolean", "enum": [true]}},
    "required": ["user_confirmed"]
  }
}
```
Handler: hard-delete this user's rows from entries, pending_entries, budgets, payee_memory, custom_categories, conversation_context, alerts_sent, users. cost_log rows are anonymized (user_id set to NULL), not deleted — they contain no personal content and are needed for unit economics. Reply: "Done. Everything's deleted. If you come back, we start fresh."

### 6.7 Tool: `resolve_pending`
```json
{
  "name": "resolve_pending",
  "description": "Resolve parse-time duplicates held for the user's confirmation. Call only after the user has answered the duplicate question. 'log' inserts the held entries exactly as parsed; 'discard' drops them.",
  "input_schema": {
    "type": "object",
    "properties": {
      "pending_ids": {"type": "array", "items": {"type": "integer"}},
      "action": {"type": "string", "enum": ["log", "discard"]}
    },
    "required": ["pending_ids", "action"]
  }
}
```
Handler: `log` moves the rows from `pending_entries` into `entries` verbatim — the server copies every field, the model transcribes nothing (a transposed digit in a ledger is the unforgivable error class). `discard` deletes the pending rows. Either way, confirm in one line. Pending ids not belonging to the caller are ignored (isolation).

## 7. System prompt (template — implement in `system_prompt.py`)

```
You are Xpensego, an expense agent on Telegram. Today is {today_date} ({weekday}), timezone IST.

You do three things: record what the user spends or receives, answer questions
about their money, and manage their category budgets. Nothing else.

TONE (hard rules):
- Confirmations are ONE line: ✓ ₹{amount} · {category} — {DD/MM/YY}. Always show the date.
- Answers lead with the number, then at most one line of context. No advice, no lectures.
- Ask at most ONE clarifying question per message. If a category is guessable, guess
  and state it instead of asking.
- Off-topic messages: answer in one brief sentence, then steer back to expenses.
- The user may write in English, Hindi, or Hinglish ("aaj 200 ka petrol"). Understand
  all of it; reply in the language they used, keeping ✓-format confirmations.

MONEY RULES:
- "Spent/spend/budget" always means debits only. Credits (salary, refunds, money
  received) are recorded but NEVER counted in spending or budgets unless the user
  explicitly asks for a net figure.
- Amounts are INR.

DATES: resolve relative dates against today ({today_date}): "yesterday", "last Friday",
"3 tarikh ko" → concrete YYYY-MM-DD before calling tools. No date mentioned → today.

CATEGORIES (exactly these 14 — never invent others):
Food & Dining (restaurants, Swiggy, Zomato, cafés, street food) · Groceries (Blinkit,
Zepto, Instamart, BigBasket, kirana, sabzi) · Transport (Uber, Ola, Rapido, metro, bus,
auto, petrol, FASTag, parking) · Rent & Utilities (rent, electricity, water, gas,
broadband, recharge, maintenance) · Shopping (Amazon, Flipkart, Myntra, clothing,
electronics) · Entertainment (movies, events, gaming) · Health (pharmacy, doctor,
diagnostics, insurance premium) · Education (courses, books, fees) · Personal Care
(salon, grooming) · Subscriptions (Netflix, Spotify, Hotstar, gym, apps) · Travel
(flights, trains, hotels, trips) · Family & Gifts (gifts, festivals, money sent home,
donations) · Fees & Charges (bank/ATM/late fees, penalties) · Other (last resort).
Canonical trap: Zomato/Swiggy → Food & Dining; Blinkit/Zepto/Instamart → Groceries.

PAYEES: for person-to-person transfers with a payee you don't have a stored category
for, ask once what it was for, then pass teach_payee so you never ask again. Known
payees categorize silently.

CORRECTIONS: "no, that's groceries" → recategorize_entry on the last entry (use
query_ledger's list metric to find it if needed) and update payee memory when a
payee is involved. After a paste summary, a numbered reply ("2 is groceries")
refers to that summary's numbered list — map it to the entry id and recategorize.

DELETION: "delete that / the last one" → delete_last_entry. "Delete everything about
me" → ask ONE confirmation question; only on an explicit yes call purge_my_data.

{payee_memory_summary}   # e.g. "Known payees: rahul→Rent & Utilities, mom→Family & Gifts"
```

Note to builder: correction of an existing row needs an UPDATE path — add a small internal handler `recategorize_entry(entry_id, category)` reachable from `log_entries`'s handler file and exposed as an eighth tool `recategorize_entry {entry_id, category}`; the model gets entry ids back from every logging/query call, so it can reference them. (Tool roster: log_entries, parse_transactions, query_ledger, manage_budget, delete_last_entry, purge_my_data, resolve_pending, recategorize_entry.)

## 8. Onboarding (`/start`)

Three fixed messages (not model-generated; hardcode):
1. "Hi, I'm Xpensego 👋 Tell me what you spend, or paste your bank SMS — I'll keep the ledger and answer anything about your money."
2. "Try it — paste this: `HDFC Bank: Rs.649.00 debited from a/c **1234 on {today-1} to VPA blinkit@ybl (UPI Ref 000000424242)`"
3. (sent after their first successful parse/log) "That's it. Log something real, or set a budget anytime — like *food budget 5000*."
Set `users.onboarded_at` on first real (non-sample) entry. The sample SMS is recognized by its reserved UPI ref `000000424242` (appears nowhere in Appendix B or any real bank message) and handled as a **dry run**: the real extraction + categorization pipeline runs and the real ✓ confirmation is shown, but nothing is inserted — the sample never touches the ledger, so no code path can put it in a report, a dedup check, or the demo.

## 9. Alerts

- APScheduler daily at 20:00 IST → for every ledger with budgets: month-to-date debit total per budgeted category; ≥80% and no 80-row in alerts_sent this month → send `⚠️ {category}: ₹{spent} of ₹{limit} ({pct}%) with {days_left} days left.`; same at ≥100%. Insert alerts_sent row per send.
- FastAPI admin endpoint `POST /trigger-alerts` (localhost only) runs the same function immediately — this is the on-stage demo button. Build the endpoint even if the scheduler gets cut.

## 10. Milestones (build in this order; verify before moving on)

| M | Deliverable | Verification (must pass) |
|---|---|---|
| M0 | Repo skeleton, config, DB migrations, bot answers "ping"→"pong" via polling | Two different Telegram accounts get independent replies |
| M1 | Agent loop + log_entries + conversation context + cost logging + abuse caps | "chai 30, auto 80, lunch 250" → 3 rows, one ✓ confirmation with today's date; "spent 500 on groceries yesterday" echoes yesterday's date; cost_log has rows; 31st message in an hour gets the static cap reply with zero LLM calls |
| M2 | parse_transactions (SMS paste) + payee memory + dedup/pending + resolve_pending | Appendix B corpus: ≥19/20 SMS parsed with correct amount+date+type; Blinkit→Groceries and Zomato→Food & Dining; re-pasting SMS #7 lands in pending_entries and asks — "log it" → resolve_pending inserts verbatim, "skip" discards; unknown payee (SMS #9) inserts as Other and asks once, the answer recategorizes + teaches; second Rahul transfer (SMS #12) is silent |
| M3 | query_ledger (structured) | All 7 query classes in Appendix A answer correctly on seeded data via slot-filled query_ledger calls; ledger scoping is injected server-side — user B's totals are ₹0 after user A logs; a question the schema can't express gets a graceful "can't answer that yet" |
| M4 | manage_budget + alerts + /trigger-alerts | "food budget 5000" then seed 4,200 food debits → /trigger-alerts sends the 80% warning once; second trigger sends nothing |
| M5 | Onboarding + delete_last_entry + recategorize + purge | Fresh account /start→sample paste→real entry sets onboarded_at; "no, that's groceries" fixes the last entry; purge flow requires the confirm question |
| M6 | CSV upload | Sample CSV → parsed summary; bad CSV → one graceful question |
| M7 | seed_demo.py + full rehearsal | Demo script (PRD companion) runs end-to-end twice without intervention |

Cut order under time pressure: M6 → scheduler (keep /trigger-alerts) → delete_last_entry → credit-parsing inside M2 (manual credit logging stays). Never cut: M0–M3, onboarding, isolation, date echo, rehearsal.

## 11. Appendix A — QA set (implement as tests/test_qa_set.py where automatable)

Manual logging (expect: rows + ✓ confirmations with echoed dates):
1. "chai 30" · 2. "spent 1200 on groceries yesterday" · 3. "movie 450 last friday" · 4. "chai 30, auto 80, lunch 250" (3 rows) · 5. "aaj 200 ka petrol" (Transport, today) · 6. "bhai ko 500 bheje" (payee question expected once) · 7. "kal 350 ka dinner tha" (Food & Dining, yesterday) · 8. "salary 85000" (credit) · 9. "got 500 back from amazon" (credit) · 10. "auto" (asks for amount — the ONE question) · 11. "recharge 239" (Rent & Utilities) · 12. "netflix 649" (Subscriptions) · 13. "sent mom 2000" (payee → likely Family & Gifts, ask once) · 14. "gym 1500 on the 1st" (date = 1st of this month) · 15. "coffee 180 and cab 320 day before yesterday" (2 rows, correct date)

Queries (run after seeding; expect number-first):
16. "how much on food this month?" · 17. "this week vs last week?" · 18. "biggest expense this month?" · 19. "what did I spend yesterday?" · 20. "average daily spend this month?" · 21. "how much did I receive this month?" (credits only) · 22. "how much have I spent at blinkit?"

Flows:
23. Correction: log "blinkit 500" forced wrong → "no, that's groceries" → verify row updated. · 24. "delete that" after a log → soft-deleted, excluded from #16. · 25. "delete everything about me" → confirm question → "yes" → all tables empty for user; cost_log anonymized. · 26. Isolation: user B asks "how much did I spend?" after user A logs — must be ₹0 for B. · 27. Off-topic: "who will win the world cup?" → one line + steer back.

## 12. Appendix B — SMS corpus (tests/sms_corpus.py and the demo paste block)

1. `HDFC Bank: Rs.649.00 debited from a/c **1234 on 03-07-26 to VPA blinkit@ybl (UPI Ref No 654321987654). Not you? Call 18002586161.` → debit 649, Groceries
2. `Dear Customer, Rs.450.00 debited from A/c XX5678 on 02Jul26 towards ZOMATO ONLINE. Avl Bal Rs.23,456.78. -SBI` → debit 450, Food & Dining
3. `ICICI Bank Acct XX321 debited for Rs 1,299.00 on 01-Jul-26; MYNTRA DESIGNS credited. UPI:519876543210. Call 18002662 for dispute.` → debit 1299, Shopping
4. `INR 240.00 debited from A/c no. XX4321 on 04-07-26 at UBER INDIA SYSTEMS. Avl bal INR 12,340.50 - Axis Bank` → debit 240, Transport
5. `Paid Rs.180.00 to RAPIDO BIKE TAXI via Paytm UPI. UPI Ref: 612345678901. Balance: Rs 340.` → debit 180, Transport
6. `You paid ₹350.00 to Apollo Pharmacy using Google Pay. UPI transaction ID: 726354981234` → debit 350, Health
7. `HDFC Bank: Rs.2,400.00 debited from a/c **1234 on 05-07-26 to VPA swiggy@icici (UPI Ref No 998877665544).` → debit 2400, Food & Dining
8. Exact duplicate of #7 (same ref) → must be held as duplicate, not inserted
9. `Dear SBI User, your A/c XX5678 debited Rs.5,000.00 on 01Jul26 trf to RAHUL SHARMA Ref 445566778899. -SBI` → debit 5000, unknown payee → ask once
10. `HDFC Bank: Rs.85,000.00 credited to a/c **1234 on 01-07-26 by a/c linked to VPA acmecorp.payroll@icici (ACME SALARY JUL).` → CREDIT 85000
11. `Rs.500.00 credited to A/c XX5678 on 06Jul26 by AMAZON PAY refund Ref 112233445566. -SBI` → CREDIT 500
12. `You paid ₹1,200.00 to Rahul Sharma using Google Pay. UPI transaction ID: 813427659812` → debit 1200; if #9 taught rahul→Rent & Utilities, categorize silently
13. `Axis Bank: INR 649.00 debited from A/c XX4321 on 05-07-26 at NETFLIX.COM. Avl bal INR 11,691.50` → debit 649, Subscriptions
14. `ICICI Bank Acct XX321 debited Rs 3,000.00 on 03-Jul-26; HPCL PETROL PUMP. UPI:519876543299.` → debit 3000, Transport
15. `Paid Rs.890.00 to BIGBASKET via Paytm UPI. UPI Ref: 612345678944.` → debit 890, Groceries
16. `Dear Customer, Rs.1,450.00 debited from A/c XX5678 on 04Jul26 towards BSES RAJDHANI ELECTRICITY. -SBI` → debit 1450, Rent & Utilities
17. `You paid ₹220.00 to DELHI METRO RAIL using Google Pay. UPI transaction ID: 726354981777` → debit 220, Transport
18. `HDFC Bank: Rs.799.00 debited from a/c **1234 on 06-07-26 to VPA bookmyshow@hdfcbank (UPI Ref No 554433221100).` → debit 799, Entertainment
19. `INR 4,500.00 debited from A/c no. XX4321 on 02-07-26 at MAKEMYTRIP INDIA. - Axis Bank` → debit 4500, Travel
20. `Paid Rs.60.00 to SHARMA GENERAL STORE via Paytm UPI. UPI Ref: 612345679001.` → debit 60, Groceries (kirana)

Demo paste block = SMS 1, 2, 4, 6, 7, 10, 13, 14, 17, 18 (includes the Blinkit/Zomato pair, a credit, and spans 4 bank formats).

## 13. Out of scope for this build (do not implement even if trivial)

Receipt OCR · weekly digest · custom categories (table exists, no behavior) · past-entry deletion beyond delete-last · export · groups behavior (schema only) · recurring detection · WhatsApp · PDF statements · payments/pricing · webhooks.

## 14. Production path (post-buildathon — the bot stays public)

This build is designed to survive contact with the public, not just the judges. What's already production-shaped: Postgres-compatible DDL, per-user isolation, soft deletes + audit trail, purge/data-rights flow, cost logging, abuse caps (§1.8), and the polling→webhook switch. What must change before scale, in order:

**Week 1 (before any promotion of the bot):**
- Host on a small always-on VM or PaaS (Railway/Render/a ₹400–800/mo VPS). Secrets via environment/secret manager, never in the repo. Bot token treated as a credential: rotate if ever exposed.
- Nightly `xpensego.db` backup to object storage (a 5-line cron). An expense ledger users trust with months of data must not live on one disk.
- Error monitoring: Sentry (free tier) or at minimum structured logs + a Telegram DM to Black on unhandled exceptions.
- A one-page privacy note linked from onboarding message 1: what's stored (transaction text you send us), what's not (we never read your SMS inbox — you paste), retention, and the "delete everything about me" command. Storing Indian consumers' financial behavior sits in DPDP Act territory — the note is the floor, proper review is a v1.5 task.
- Watch `cost_log` daily; the per-user caps in §1.8 are tuned from this data.

**On traction signal (per PRD §15 metrics):**
- SQLite → managed Postgres (Supabase/Neon). Single-writer SQLite is fine to roughly a few hundred lightly-active users; migrate before it's felt, not after.
- Polling → webhook behind HTTPS (needed for reliability at volume and required before WhatsApp anyway).
- Alert scheduler moved to a proper job runner; timezone handling per user if non-IST users appear.
- Uptime monitoring + a status command.

**Explicitly deferred with pricing:** payment rails, plan gating, invoicing — blocked on the §9 (Product Doc) pricing prerequisites, not on engineering.
