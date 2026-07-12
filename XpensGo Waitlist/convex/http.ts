import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });

// Browsers preflight the POST; answer it.
http.route({
  path: "/waitlist",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: cors })),
});

http.route({
  path: "/waitlist",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ status: "error", message: "Malformed request." }, 400);
    }

    // Honeypot: a real person never sees or fills this field. Bots do.
    // Report success so they don't retry, but store nothing.
    if (typeof body.website === "string" && body.website.trim() !== "") {
      return json({ status: "joined" });
    }

    const result = await ctx.runMutation(internal.waitlist.join, {
      email: String(body.email ?? ""),
      source: body.source ? String(body.source).slice(0, 32) : undefined,
      variant: body.variant ? String(body.variant).slice(0, 8) : undefined,
      utmSource: body.utmSource ? String(body.utmSource).slice(0, 100) : undefined,
      utmMedium: body.utmMedium ? String(body.utmMedium).slice(0, 100) : undefined,
      utmCampaign: body.utmCampaign ? String(body.utmCampaign).slice(0, 100) : undefined,
      referrer: body.referrer ? String(body.referrer).slice(0, 400) : undefined,
    });

    if (!result.ok) {
      return json({ status: "invalid", message: "That doesn't look like an email address." }, 422);
    }
    return json({ status: result.alreadyJoined ? "already_joined" : "joined" });
  }),
});

http.route({
  path: "/count",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const n = await ctx.runQuery(internal.waitlist.count, {});
    // Only show the counter once it's real social proof, never before.
    const min = Number(process.env.COUNTER_MIN_DISPLAY ?? 25);
    return json({ count: n, display: n >= min });
  }),
});

// Admin: full list as CSV. Call with ?token=<ADMIN_TOKEN>
http.route({
  path: "/export.csv",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = new URL(request.url).searchParams.get("token");
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }
    const rows = await ctx.runQuery(internal.waitlist.allRows, {});
    const header = "email,joined_at,source,variant,utm_source,referrer,welcome_status,invited_at\n";
    const csv =
      header +
      rows
        .map((r: any) =>
          [
            r.email,
            new Date(r.joinedAt).toISOString(),
            r.source ?? "",
            r.variant ?? "",
            r.utmSource ?? "",
            (r.referrer ?? "").replace(/,/g, " "),
            r.welcomeStatus,
            r.inviteSentAt ? new Date(r.inviteSentAt).toISOString() : "",
          ].join(","),
        )
        .join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=xpensego-waitlist.csv",
      },
    });
  }),
});

export default http;
