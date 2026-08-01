import {
  ChannelLinkChallengeDigest,
  ChannelLinkChallengeToken,
} from "@xpensego/domain/identity/channel-identity";
import {
  LinkChallengeCrypto,
  LinkChallengeCryptoUnavailable,
} from "@xpensego/domain/identity/identity";
import { Effect, Layer, Redacted, Schema } from "effect";

function encodeBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

const generateToken = Effect.try({
  try: () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Redacted.make(
      Schema.decodeUnknownSync(ChannelLinkChallengeToken)(encodeBase64Url(bytes)),
    );
  },
  catch: () => new LinkChallengeCryptoUnavailable({ operation: "generateToken" }),
});

const digestToken = Effect.fn("WebCryptoLinkChallenge.digestToken")(function* (
  token: Redacted.Redacted<ChannelLinkChallengeToken>,
) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(Redacted.value(token))),
    catch: () => new LinkChallengeCryptoUnavailable({ operation: "digestToken" }),
  });
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return yield* Schema.decodeUnknown(ChannelLinkChallengeDigest)(hex).pipe(
    Effect.mapError(() => new LinkChallengeCryptoUnavailable({ operation: "digestToken" })),
  );
});

/** Web Crypto implementation for high-entropy link capabilities and SHA-256 persistence digests. */
export const webCryptoLinkChallengeLayer = Layer.succeed(
  LinkChallengeCrypto,
  LinkChallengeCrypto.of({ digestToken, generateToken }),
);
