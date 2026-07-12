export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPENAI_API_KEY: string;
}

type TelegramUpdate = { message?: { text?: string; chat: { id: number }; from?: { id: number; first_name?: string; last_name?: string } } };
const categories = ["Food & Dining", "Groceries", "Transport", "Rent & Utilities", "Shopping", "Entertainment", "Health", "Education", "Personal Care", "Subscriptions", "Travel", "Family & Gifts", "Fees & Charges", "Other"];

function categoryFor(text: string): string {
  const t = text.toLowerCase();
  if (/blinkit|zepto|instamart|bigbasket|kirana|sabzi/.test(t)) return "Groceries";
  if (/zomato|swiggy|chai|coffee|lunch|dinner|restaurant/.test(t)) return "Food & Dining";
  if (/uber|ola|rapido|auto|cab|petrol|metro|fastag/.test(t)) return "Transport";
  if (/netflix|spotify|hotstar|gym/.test(t)) return "Subscriptions";
  if (/salary|refund/.test(t)) return "Other";
  return "Other";
}

async function telegram(env: Env, chatId: number, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) });
  if (!response.ok) throw new Error(`Telegram send failed: ${response.status}`);
}

async function upsertUser(env: Env, userId: string, name?: string) {
  await env.DB.prepare("INSERT INTO users (user_id, display_name) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET display_name=COALESCE(excluded.display_name, users.display_name)").bind(userId, name ?? null).run();
}

async function handleMessage(env: Env, message: NonNullable<TelegramUpdate["message"]>) {
  const userId = String(message.from?.id ?? message.chat.id);
  const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");
  await upsertUser(env, userId, name);
  const text = (message.text ?? "").trim();
  if (text === "/start") {
    await telegram(env, message.chat.id, "Hi, I'm Xpensego 👋 Tell me what you spend, or paste your bank SMS — I'll keep the ledger and answer anything about your money.");
    await telegram(env, message.chat.id, "Try it — paste this: HDFC Bank: Rs.649.00 debited from a/c **1234 on 03-07-26 to VPA blinkit@ybl (UPI Ref 000000424242)");
    return;
  }
  const budget = text.match(/^(.+?)\s+budget\s+(\d+(?:\.\d+)?)$/i);
  if (budget) {
    const category = categories.find((c) => c.toLowerCase().startsWith(budget[1].toLowerCase())) ?? categoryFor(budget[1]);
    await env.DB.prepare("INSERT INTO budgets (ledger_id, category, monthly_limit) VALUES (?, ?, ?) ON CONFLICT(ledger_id,category) DO UPDATE SET monthly_limit=excluded.monthly_limit").bind(`user:${userId}`, category, Number(budget[2])).run();
    await telegram(env, message.chat.id, `✓ ${category} budget set to ₹${Number(budget[2]).toLocaleString("en-IN")}.`);
    return;
  }
  const expense = text.match(/(?:spent\s+)?(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)/i);
  if (expense) {
    const amount = Number(expense[1]); const type = /salary|refund|received|got\s+\d+/i.test(text) ? "credit" : "debit"; const category = categoryFor(text); const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO entries (ledger_id,user_id,paid_by,type,amount,category,description,txn_date,source) VALUES (?,?,?,?,?,?,?,?, 'manual')").bind(`user:${userId}`, userId, userId, type, amount, category, text, today).run();
    await env.DB.prepare("UPDATE users SET onboarded_at=COALESCE(onboarded_at,CURRENT_TIMESTAMP) WHERE user_id=?").bind(userId).run();
    await telegram(env, message.chat.id, `✓ ₹${amount.toLocaleString("en-IN")} · ${category} — ${today.split("-").reverse().join("/").slice(0, 8)}`);
    return;
  }
  await telegram(env, message.chat.id, "I can log an expense, set a budget, or answer from your ledger.");
}

async function scheduled(env: Env) {
  const month = new Date().toISOString().slice(0, 7); const start = `${month}-01`;
  const rows = await env.DB.prepare("SELECT b.ledger_id,b.category,b.monthly_limit,COALESCE(SUM(e.amount),0) spent FROM budgets b LEFT JOIN entries e ON e.ledger_id=b.ledger_id AND e.category=b.category AND e.type='debit' AND e.deleted_at IS NULL AND e.txn_date>=? GROUP BY b.ledger_id,b.category,b.monthly_limit").bind(start).all<{ledger_id:string;category:string;monthly_limit:number;spent:number}>();
  for (const row of rows.results) for (const threshold of [80, 100]) if ((row.spent / row.monthly_limit) * 100 >= threshold) {
    const claimed = await env.DB.prepare("INSERT INTO alerts_sent (ledger_id,category,month,threshold) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").bind(row.ledger_id,row.category,month,threshold).run();
    if (claimed.meta.changes && row.ledger_id.startsWith("user:")) await telegram(env, Number(row.ledger_id.slice(5)), `⚠️ ${row.category}: ₹${row.spent} of ₹${row.monthly_limit} (${Math.round(row.spent / row.monthly_limit * 100)}%).`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok" });
    if (request.method !== "POST" || url.pathname !== "/telegram") return new Response("Not found", { status: 404 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
    const update = await request.json<TelegramUpdate>();
    if (update.message?.from) await handleMessage(env, update.message);
    return new Response("ok");
  },
  async scheduled(_: ScheduledController, env: Env, ctx: ExecutionContext) { ctx.waitUntil(scheduled(env)); },
} satisfies ExportedHandler<Env>;
