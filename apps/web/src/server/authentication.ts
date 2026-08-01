import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  IdentityOverviewV1,
  type IdentityOverviewV1 as IdentityOverviewV1Type,
} from "@xpensego/contracts/identity/identity";
import { Schema } from "effect";

/** Authenticated application identity or a safe private-route resolution outcome. */
export type WebIdentityResult =
  | { readonly _tag: "Authenticated"; readonly identity: IdentityOverviewV1Type }
  | { readonly _tag: "Unauthenticated" }
  | { readonly _tag: "Unavailable" };

/** Resolve application-owned identity without collapsing outages into signed-out state. */
export async function readWebIdentity(headers: Headers): Promise<WebIdentityResult> {
  try {
    const { env } = getCloudflareContext();
    const response = await env.API.fetch(
      new Request("https://xpensego-api.internal/v1/identity", { headers }),
    );
    if (response.status === 401) {
      return { _tag: "Unauthenticated" };
    }
    if (!response.ok) {
      return { _tag: "Unavailable" };
    }
    const candidate: unknown = await response.json();
    if (!Schema.is(IdentityOverviewV1)(candidate)) {
      return { _tag: "Unavailable" };
    }
    return { _tag: "Authenticated", identity: candidate };
  } catch {
    return { _tag: "Unavailable" };
  }
}
