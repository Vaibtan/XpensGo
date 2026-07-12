import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction } from "./_generated/server";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function fromAddress(): string {
  // Set EMAIL_FROM in the Convex dashboard once your domain is verified,
  // e.g. "Xpensego <hello@xpensego.app>".
  return process.env.EMAIL_FROM ?? "Xpensego <onboarding@resend.dev>";
}

async function sendEmail(to: string, subject: string, html: string, text: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    return { ok: false, error: "RESEND_API_KEY not set" };
  }
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: fromAddress(), to: [to], subject, html, text }),
  });
  if (res.ok) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `${res.status} ${body.slice(0, 200)}` };
}

function shell(bodyHtml: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;background:#161826;">
<div style="max-width:520px;margin:0 auto;padding:44px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e9e9ed;">
${bodyHtml}
<div style="height:1px;background:#3f424d;margin:28px 0;"></div>
<p style="font-size:13px;line-height:1.6;color:#9397ab;margin:0;">Your bank already tells you everything. Xpensego makes it mean something.<br>To come off the list, just reply &ldquo;remove me&rdquo;.</p>
</div></body></html>`;
}

const WELCOME_HTML = shell(`
<p style="font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:#9184d9;margin:0 0 18px;">Xpensego &mdash; early access</p>
<h1 style="font-size:26px;font-weight:500;line-height:1.25;margin:0 0 18px;">You're in line.</h1>
<p style="font-size:15px;line-height:1.65;color:#cfd3e5;margin:0 0 14px;">Xpensego is the expense agent that lives in your chats. Paste your bank SMS or just say what you spent &mdash; it keeps the ledger right, answers any money question in one message, and warns you before a budget blows.</p>
<p style="font-size:15px;line-height:1.65;color:#cfd3e5;margin:0;">Invites go out in the order people joined. We'll write the moment yours is ready &mdash; and nothing else in between. No spam, ever.</p>`);

const WELCOME_TEXT = `You're in line.

Xpensego is the expense agent that lives in your chats. Paste your bank SMS or
just say what you spent - it keeps the ledger right, answers any money question
in one message, and warns you before a budget blows.

Invites go out in the order people joined. We'll write the moment yours is ready
- and nothing else in between. No spam, ever.

- Xpensego
To come off the list, just reply "remove me".`;

/** Sent automatically the instant someone joins. */
export const sendWelcome = internalAction({
  args: { id: v.id("waitlist"), email: v.string() },
  handler: async (ctx, { id, email }) => {
    const r = await sendEmail(
      email,
      "You're on the Xpensego waitlist",
      WELCOME_HTML,
      WELCOME_TEXT,
    );
    await ctx.runMutation(internal.waitlist.markWelcome, {
      id,
      status: r.ok ? "sent" : "pending", // stays pending so it can be retried later
      error: r.ok ? undefined : r.error,
    });
  },
});

/**
 * Flush every welcome email that never went out — run this once your domain
 * is verified in Resend. Everyone who signed up before then gets their email.
 * Staggered to respect Resend's rate limit.
 */
export const flushPendingWelcomes = action({
  args: { adminToken: v.string() },
  handler: async (ctx, { adminToken }) => {
    if (adminToken !== process.env.ADMIN_TOKEN) throw new Error("Unauthorized");
    const pending = await ctx.runQuery(internal.waitlist.pendingWelcomes, {});
    for (let i = 0; i < pending.length; i++) {
      await ctx.scheduler.runAfter(i * 700, internal.emails.sendWelcome, pending[i]);
    }
    return { queued: pending.length };
  },
});

/** The launch email. Run this when the product is ready for people to use. */
export const sendLaunchInvites = action({
  args: {
    adminToken: v.string(),
    productUrl: v.string(), // e.g. https://t.me/XpensegoBot
    limit: v.optional(v.number()), // send in batches; Resend free tier is 100/day
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { adminToken, productUrl, limit, dryRun }) => {
    if (adminToken !== process.env.ADMIN_TOKEN) throw new Error("Unauthorized");
    const queue = await ctx.runQuery(internal.waitlist.awaitingInvite, {});
    const batch = queue.slice(0, limit ?? 90);
    if (dryRun) return { wouldSend: batch.length, totalWaiting: queue.length };

    for (let i = 0; i < batch.length; i++) {
      await ctx.scheduler.runAfter(i * 700, internal.emails.sendOneInvite, {
        ...batch[i],
        productUrl,
      });
    }
    return { queued: batch.length, remaining: queue.length - batch.length };
  },
});

export const sendOneInvite = internalAction({
  args: { id: v.id("waitlist"), email: v.string(), productUrl: v.string() },
  handler: async (ctx, { id, email, productUrl }) => {
    const html = shell(`
<p style="font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:#9184d9;margin:0 0 18px;">Xpensego &mdash; your invite</p>
<h1 style="font-size:26px;font-weight:500;line-height:1.25;margin:0 0 18px;">You're in.</h1>
<p style="font-size:15px;line-height:1.65;color:#cfd3e5;margin:0 0 22px;">Open Xpensego, send it one bank SMS, and ask it what you spent on food this month. That's the whole onboarding.</p>
<p style="margin:0 0 22px;"><a href="${productUrl}" style="display:inline-block;padding:12px 22px;border:1px solid #9184d9;border-radius:8px;color:#9184d9;text-decoration:none;font-size:15px;">Start using Xpensego</a></p>
<p style="font-size:15px;line-height:1.65;color:#cfd3e5;margin:0;">If something's wrong or confusing, reply to this email. It comes straight to us and we read every one.</p>`);

    const text = `You're in.

Open Xpensego, send it one bank SMS, and ask it what you spent on food this
month. That's the whole onboarding.

${productUrl}

If something's wrong or confusing, reply to this email. It comes straight to us
and we read every one.

- Xpensego`;

    const r = await sendEmail(email, "Your Xpensego invite is ready", html, text);
    if (r.ok) {
      await ctx.runMutation(internal.waitlist.markInvited, { id });
    }
  },
});
