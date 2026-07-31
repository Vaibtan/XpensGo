import { Schema } from "effect";

import { CorrelationId } from "./correlation-id.js";
import { OutboxMessageId } from "./outbox-message-id.js";

/** Version 1 Queue envelope for one durable outbox message. */
export const OutboxJobV1 = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("outbox.message.ready"),
  outboxMessageId: OutboxMessageId,
  correlationId: CorrelationId,
});

/** A parsed version 1 outbox Queue envelope. */
export type OutboxJobV1 = typeof OutboxJobV1.Type;
