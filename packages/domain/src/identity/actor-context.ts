import { CorrelationId } from "@xpensego/contracts/platform/correlation-id";
import { Schema } from "effect";

import { UserId } from "./user-id.js";
import { LedgerId } from "../ledger/ledger-id.js";
import { UserTimezone } from "./user-timezone.js";
import { ChannelIdentityId } from "./channel-identity.js";

/** Identifier owned by the selected web-authentication provider. */
export const AuthUserId = Schema.UUID.pipe(Schema.brand("AuthUserId"));

/** A parsed authentication-provider user identifier. */
export type AuthUserId = typeof AuthUserId.Type;

/** Server-constructed authority for one verified web request. */
export const WebActorContext = Schema.Struct({
  _tag: Schema.Literal("WebActor"),
  userId: UserId,
  ledgerId: LedgerId,
  timezone: UserTimezone,
  correlationId: CorrelationId,
  authenticationStrength: Schema.Literal("session"),
});

/** A trusted web ActorContext that clients cannot construct. */
export interface WebActorContext {
  readonly _tag: "WebActor";
  readonly userId: UserId;
  readonly ledgerId: LedgerId;
  readonly timezone: UserTimezone;
  readonly correlationId: CorrelationId;
  readonly authenticationStrength: "session";
}

/** Server-constructed authority for one verified Telegram Channel Identity. */
export const ChannelActorContext = Schema.Struct({
  _tag: Schema.Literal("ChannelActor"),
  userId: UserId,
  ledgerId: LedgerId,
  timezone: UserTimezone,
  correlationId: CorrelationId,
  authenticationStrength: Schema.Literal("linked_channel"),
  channel: Schema.Literal("telegram"),
  channelIdentityId: ChannelIdentityId,
});

/** A trusted channel ActorContext resolved only from server-held relationships. */
export type ChannelActorContext = typeof ChannelActorContext.Type;

/** Trusted authority available to application operations after ingress authentication. */
export const ActorContext = Schema.Union(WebActorContext, ChannelActorContext);

/** A trusted web or messaging ActorContext. */
export type ActorContext = typeof ActorContext.Type;
