import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

/**
 * Add someone to the waitlist.
 * Idempotent: a repeat signup is a no-op that still reports success, because
 * "you already signed up" is not an error the visitor needs to think about.
 */
export const join = internalMutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
    variant: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    referrer: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return { ok: false as const, reason: "invalid_email" };
    }

    const existing = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();

    if (existing) {
      return { ok: true as const, alreadyJoined: true };
    }

    const id = await ctx.db.insert("waitlist", {
      email,
      source: args.source,
      variant: args.variant ?? "1a",
      utmSource: args.utmSource,
      utmMedium: args.utmMedium,
      utmCampaign: args.utmCampaign,
      referrer: args.referrer,
      welcomeStatus: "pending",
      joinedAt: Date.now(),
    });

    // Fire the welcome email without making the visitor wait for it.
    await ctx.scheduler.runAfter(0, internal.emails.sendWelcome, {
      id,
      email,
    });

    return { ok: true as const, alreadyJoined: false };
  },
});

export const count = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("waitlist").collect();
    return rows.length;
  },
});

export const markWelcome = internalMutation({
  args: {
    id: v.id("waitlist"),
    status: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, error }) => {
    await ctx.db.patch(id, { welcomeStatus: status, welcomeError: error });
  },
});

export const markInvited = internalMutation({
  args: { id: v.id("waitlist") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { inviteSentAt: Date.now() });
  },
});

/** Everyone whose welcome email never went out (e.g. before the domain was verified). */
export const pendingWelcomes = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("waitlist")
      .withIndex("by_welcome_status", (q) => q.eq("welcomeStatus", "pending"))
      .collect();
    return rows.map((r) => ({ id: r._id, email: r.email }));
  },
});

/** Everyone who has not yet been sent the launch invite. */
export const awaitingInvite = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("waitlist")
      .withIndex("by_invite_sent", (q) => q.eq("inviteSentAt", undefined))
      .collect();
    return rows
      .sort((a, b) => a.joinedAt - b.joinedAt) // first-come, first-served
      .map((r) => ({ id: r._id, email: r.email }));
  },
});

export const allRows = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("waitlist").collect();
    return rows.sort((a, b) => a.joinedAt - b.joinedAt);
  },
});
