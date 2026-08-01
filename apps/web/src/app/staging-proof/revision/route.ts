import { getCloudflareContext } from "@opennextjs/cloudflare";
import { Schema } from "effect";

const BuildRevision = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/));

/** Expose deployment provenance only when the staging revision binding is present. */
export function GET(): Response {
  const { env } = getCloudflareContext();
  if (env.BUILD_REVISION === undefined || !Schema.is(BuildRevision)(env.BUILD_REVISION)) {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  }

  return Response.json(
    { version: 1, buildRevision: env.BUILD_REVISION },
    { headers: { "cache-control": "no-store" } },
  );
}
