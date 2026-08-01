import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  BetterAuthWebSession,
  type BetterAuthWebSession as BetterAuthWebSessionType,
} from "@xpensego/contracts/identity/better-auth-session";
import { Schema } from "effect";

export type WebSessionResult =
  | { readonly _tag: "Authenticated"; readonly session: BetterAuthWebSessionType }
  | { readonly _tag: "Unauthenticated" }
  | { readonly _tag: "Unavailable" };

/** Resolve the current provider session without collapsing outages into signed-out state. */
export async function readWebSession(headers: Headers): Promise<WebSessionResult> {
  try {
    const { env } = getCloudflareContext();
    const response = await env.API.fetch(
      new Request("https://xpensego-api.internal/v1/auth/get-session", { headers }),
    );
    if (!response.ok) {
      return { _tag: "Unavailable" };
    }
    const candidate: unknown = await response.json();
    if (candidate === null) {
      return { _tag: "Unauthenticated" };
    }
    if (!Schema.is(BetterAuthWebSession)(candidate)) {
      return { _tag: "Unavailable" };
    }
    return { _tag: "Authenticated", session: candidate };
  } catch {
    return { _tag: "Unavailable" };
  }
}
