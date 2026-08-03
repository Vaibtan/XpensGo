"use client";

import {
  IdentityOverviewV1,
  TelegramChallengeV1,
  type IdentityOverviewV1 as IdentityOverview,
} from "@xpensego/contracts/identity/identity";
import { Schema } from "effect";
import { useState, useTransition, type FormEvent } from "react";

type TelegramChallenge = typeof TelegramChallengeV1.Type;

const COMMON_TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
];

interface IdentityControlsProps {
  readonly initialIdentity: IdentityOverview;
}

const ApiErrorResponse = Schema.Struct({
  version: Schema.Literal(1),
  error: Schema.Struct({
    code: Schema.String,
    retryAfterSeconds: Schema.optional(Schema.Int.pipe(Schema.positive())),
  }),
});

type ApiRequestResult<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "AuthenticationRequired" }
  | { readonly _tag: "Forbidden" }
  | { readonly _tag: "InvalidRequest" }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "RateLimited"; readonly retryAfterSeconds: number }
  | { readonly _tag: "Unavailable" };

async function requestJson<A>(
  input: string,
  request: RequestInit,
  schema: Schema.Schema<A>,
): Promise<ApiRequestResult<A>> {
  try {
    const response = await fetch(input, request);
    const candidate: unknown = await response.json();
    if (response.ok) {
      const decoded = Schema.decodeUnknownEither(schema)(candidate);
      return decoded._tag === "Right"
        ? { _tag: "Success", value: decoded.right }
        : { _tag: "Unavailable" };
    }

    const decodedError = Schema.decodeUnknownEither(ApiErrorResponse)(candidate);
    if (decodedError._tag === "Left") {
      return { _tag: "Unavailable" };
    }
    switch (decodedError.right.error.code) {
      case "authentication_required":
        return { _tag: "AuthenticationRequired" };
      case "cross_site_request_forbidden":
        return { _tag: "Forbidden" };
      case "invalid_timezone":
      case "invalid_channel_identity":
        return { _tag: "InvalidRequest" };
      case "channel_identity_not_found":
        return { _tag: "NotFound" };
      case "challenge_rate_limited":
        return decodedError.right.error.retryAfterSeconds === undefined
          ? { _tag: "Unavailable" }
          : {
              _tag: "RateLimited",
              retryAfterSeconds: decodedError.right.error.retryAfterSeconds,
            };
      default:
        return { _tag: "Unavailable" };
    }
  } catch {
    return { _tag: "Unavailable" };
  }
}

function failureMessage(result: Exclude<ApiRequestResult<never>, { readonly _tag: "Success" }>) {
  switch (result._tag) {
    case "AuthenticationRequired":
      return "Your session ended. Sign in again before changing account settings.";
    case "Forbidden":
      return "This page can no longer make trusted changes. Refresh it and try again.";
    case "InvalidRequest":
      return "The requested account change is invalid. Check it and try again.";
    case "NotFound":
      return "That Telegram link is no longer active. Refresh the page to see current links.";
    case "RateLimited":
      return `Too many verification commands were created. Try again in ${result.retryAfterSeconds} seconds.`;
    case "Unavailable":
      return "Account settings are temporarily unavailable. Try again shortly.";
  }
}

/** Account preferences and Telegram ownership controls for the private workspace. */
export function IdentityControls({ initialIdentity }: IdentityControlsProps) {
  const [identity, setIdentity] = useState(initialIdentity);
  const [timezone, setTimezone] = useState(initialIdentity.user.timezone);
  const [challenge, setChallenge] = useState<TelegramChallenge | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function saveTimezone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    startTransition(async () => {
      const result = await requestJson(
        "/v1/identity/timezone",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ timezone }),
        },
        IdentityOverviewV1,
      );
      if (result._tag === "Success") {
        setIdentity(result.value);
        setFeedback("Timezone saved.");
      } else {
        setFeedback(
          result._tag === "InvalidRequest"
            ? "Use a valid IANA timezone, such as Asia/Kolkata."
            : failureMessage(result),
        );
      }
    });
  }

  function createChallenge(purpose: "link" | "unlink", channelIdentityId?: string) {
    setFeedback(null);
    setChallenge(null);
    startTransition(async () => {
      const request: RequestInit =
        purpose === "unlink"
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ channelIdentityId }),
            }
          : { method: "POST" };
      const result = await requestJson(
        `/v1/identity/telegram/${purpose}-challenges`,
        request,
        TelegramChallengeV1,
      );
      if (result._tag === "Success") {
        setChallenge(result.value);
      } else {
        setFeedback(failureMessage(result));
      }
    });
  }

  const ledgerReference = identity.ledger.id.slice(0, 8).toUpperCase();

  return (
    <section className="identityWorkspace" aria-busy={isPending}>
      <div className="identityIntro">
        <p className="workspaceIndex">Personal ledger / {ledgerReference}</p>
        <h1>One ledger, wherever you record.</h1>
        <p>
          {identity.user.email} owns this ledger. Your timezone controls transaction dates and
          reporting boundaries; Telegram can be linked without creating a second account.
        </p>
      </div>

      <div className="identityGrid">
        <form className="identityPanel" onSubmit={saveTimezone}>
          <div>
            <p className="panelLabel">Ledger clock</p>
            <h2>Timezone</h2>
          </div>
          <label htmlFor="timezone">IANA timezone</label>
          <input
            id="timezone"
            list="common-timezones"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            autoComplete="off"
            required
          />
          <datalist id="common-timezones">
            {COMMON_TIMEZONES.map((candidate) => (
              <option key={candidate} value={candidate} />
            ))}
          </datalist>
          <p className="controlNote">Current: {identity.user.timezone}</p>
          <button className="primaryButton controlButton" disabled={isPending} type="submit">
            Save timezone
          </button>
        </form>

        <div className="identityPanel telegramPanel">
          <div className="channelHeading">
            <div>
              <p className="panelLabel">Capture channel</p>
              <h2>Telegram</h2>
            </div>
            <span className="channelState">
              {identity.telegramIdentities.length > 0 ? "Linked" : "Not linked"}
            </span>
          </div>

          <p className="controlNote">
            Create a private, ten-minute command for each Telegram account you want to use with this
            ledger.
          </p>
          <button
            className="primaryButton controlButton"
            disabled={isPending}
            onClick={() => createChallenge("link")}
            type="button"
          >
            {identity.telegramIdentities.length === 0
              ? "Create link command"
              : "Add another Telegram account"}
          </button>

          {identity.telegramIdentities.length === 0 ? null : (
            <div className="linkedIdentityList">
              {identity.telegramIdentities.map((telegramIdentity) => (
                <div className="linkedIdentity" key={telegramIdentity.channelIdentityId}>
                  <span>
                    Linked {new Date(telegramIdentity.linkedAtMillis).toISOString().slice(0, 10)} ·
                    ref {telegramIdentity.channelIdentityId.slice(-8).toUpperCase()}
                  </span>
                  <button
                    className="textButton"
                    disabled={isPending}
                    onClick={() => createChallenge("unlink", telegramIdentity.channelIdentityId)}
                    type="button"
                  >
                    Create unlink command
                  </button>
                </div>
              ))}
            </div>
          )}

          {challenge === null ? null : (
            <div className="challengeSlip" role="status">
              <span>Send this one-use command in Telegram</span>
              <code>
                /{challenge.purpose} {challenge.token}
              </code>
              {challenge.deepLink === null ? null : (
                <a
                  className="primaryButton"
                  href={challenge.deepLink}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open Telegram
                </a>
              )}
              <small>Expires in ten minutes. Do not share it.</small>
            </div>
          )}
        </div>
      </div>

      {feedback === null ? null : (
        <p className="workspaceFeedback" role="status">
          {feedback}
        </p>
      )}
    </section>
  );
}
