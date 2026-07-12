import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  waitlist: defineTable({
    email: v.string(),

    // where on the page they signed up, and which page variant they saw
    source: v.optional(v.string()),
    variant: v.optional(v.string()),

    // where they came from
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    referrer: v.optional(v.string()),

    // welcome email lifecycle: pending -> sent | failed
    // "pending" is the safe state when no domain is verified yet — nothing is lost
    welcomeStatus: v.string(),
    welcomeError: v.optional(v.string()),

    // launch/invite email lifecycle
    inviteSentAt: v.optional(v.number()),

    joinedAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_welcome_status", ["welcomeStatus"])
    .index("by_invite_sent", ["inviteSentAt"]),
});
