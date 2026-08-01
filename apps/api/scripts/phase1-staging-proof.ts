import { NodeRuntime } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { runMigrations } from "@xpensego/adapters/postgres/migrations";
import { BetterAuthWebSession } from "@xpensego/contracts/identity/better-auth-session";
import { OutboxMessageId } from "@xpensego/contracts/platform/outbox-message-id";
import { UserId } from "@xpensego/domain/identity/user-id";
import { LedgerId } from "@xpensego/domain/ledger/ledger-id";
import { Clock, Effect, Exit, Redacted, Schema } from "effect";

import {
  coldResumeRequestTimeoutMilliseconds,
  coldResumeWaitMilliseconds,
  effectiveNeonSuspendTimeoutSeconds,
  maximumColdResumeLatencyMilliseconds,
  maximumProvenNeonSuspendTimeoutSeconds,
  maximumScheduledRecoveryWaitMilliseconds,
} from "../src/phase1-staging-proof-policy.js";

const stagingApiUrl = "https://xpensego-api-staging.vaibhav21296.workers.dev";
const stagingWebUrl = "https://xpensego-web-staging.vaibhav21296.workers.dev";
const stagingNeonProjectId = "rough-term-42024311";
const stagingNeonBranchId = "br-spring-mud-azz6ko90";

const Secret = Schema.String.pipe(Schema.minLength(32), Schema.maxLength(512));
const BuildRevision = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{40}$/));
const PostgresUrl = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "postgres:" || protocol === "postgresql:";
    } catch {
      return false;
    }
  }),
);

const Environment = Schema.Struct({
  XPENSEGO_MIGRATION_DATABASE_URL: PostgresUrl,
  XPENSEGO_PHASE1_PROBE_SECRET: Secret,
  XPENSEGO_EXPECTED_REVISION: BuildRevision,
  NEON_API_KEY: Secret,
  XPENSEGO_STAGING_API_URL: Schema.Literal(stagingApiUrl),
  XPENSEGO_STAGING_WEB_URL: Schema.Literal(stagingWebUrl),
  XPENSEGO_NEON_PROJECT_ID: Schema.Literal(stagingNeonProjectId),
  XPENSEGO_NEON_BRANCH_ID: Schema.Literal(stagingNeonBranchId),
});

interface ProofEnvironment {
  readonly migrationDatabaseUrl: Redacted.Redacted<string>;
  readonly probeSecret: Redacted.Redacted<string>;
  readonly expectedRevision: string;
  readonly neonApiKey: Redacted.Redacted<string>;
  readonly apiUrl: typeof stagingApiUrl;
  readonly webUrl: typeof stagingWebUrl;
  readonly neonProjectId: typeof stagingNeonProjectId;
  readonly neonBranchId: typeof stagingNeonBranchId;
}

const FixtureIds = Schema.Struct({
  ownerUserId: UserId,
  ledgerId: LedgerId,
  otherOwnerUserId: UserId,
});

const AcceptanceResponse = Schema.Struct({
  version: Schema.Literal(1),
  operation: Schema.Literal("acceptInboundEvent"),
  buildRevision: BuildRevision,
  concurrentOutcomes: Schema.Array(Schema.Literal("Accepted", "Duplicate")),
  acceptedOutboxMessageId: OutboxMessageId,
  crossOwnerOutcome: Schema.Literal("InboundEventOwnershipMismatch"),
  redeliveryToken: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/)),
});

const RedeliveryResponse = Schema.Struct({
  version: Schema.Literal(1),
  operation: Schema.Literal("redeliverOutbox"),
  buildRevision: BuildRevision,
  outcome: Schema.Literal("published"),
});

const WebRevisionResponse = Schema.Struct({
  version: Schema.Literal(1),
  buildRevision: BuildRevision,
});

const ProofState = Schema.Struct({
  inboundEventCount: Schema.Int.pipe(Schema.nonNegative()),
  outboxMessageCount: Schema.Int.pipe(Schema.nonNegative()),
  receiptCount: Schema.Int.pipe(Schema.nonNegative()),
  deliveryAttempts: Schema.Int.pipe(Schema.nonNegative()),
  status: Schema.Literal("pending", "published", "failed"),
  publishAttempts: Schema.Int.pipe(Schema.nonNegative()),
  lastPublishErrorCode: Schema.NullOr(Schema.String),
});

const NeonEndpointList = Schema.Struct({
  endpoints: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      branch_id: Schema.String,
      type: Schema.String,
      current_state: Schema.String,
      suspend_timeout_seconds: Schema.Int.pipe(Schema.between(-1, 604_800)),
    }),
  ),
});

type NeonEndpoint = (typeof NeonEndpointList.Type)["endpoints"][number];

class Phase1StagingProofFailed extends Schema.TaggedError<Phase1StagingProofFailed>()(
  "Phase1StagingProofFailed",
  {
    step: Schema.String,
  },
) {
  override get message(): string {
    return `Phase 1 staging proof failed at ${this.step}.`;
  }
}

function asProofFailure(error: unknown, fallbackStep: string): Phase1StagingProofFailed {
  return error instanceof Phase1StagingProofFailed
    ? error
    : new Phase1StagingProofFailed({ step: fallbackStep });
}

function requireProof(condition: boolean, step: string) {
  return condition ? Effect.void : Effect.fail(new Phase1StagingProofFailed({ step }));
}

function proofRunId(): string {
  return `run-${crypto.randomUUID()}`;
}

function makeFixtureIds() {
  return Schema.decodeUnknownSync(FixtureIds)({
    ownerUserId: crypto.randomUUID(),
    ledgerId: crypto.randomUUID(),
    otherOwnerUserId: crypto.randomUUID(),
  });
}

function resolveEnvironment(): Effect.Effect<ProofEnvironment, Phase1StagingProofFailed> {
  return Schema.decodeUnknown(Environment)(process.env).pipe(
    Effect.map((environment): ProofEnvironment => ({
      migrationDatabaseUrl: Redacted.make(environment.XPENSEGO_MIGRATION_DATABASE_URL),
      probeSecret: Redacted.make(environment.XPENSEGO_PHASE1_PROBE_SECRET),
      expectedRevision: environment.XPENSEGO_EXPECTED_REVISION,
      neonApiKey: Redacted.make(environment.NEON_API_KEY),
      apiUrl: environment.XPENSEGO_STAGING_API_URL,
      webUrl: environment.XPENSEGO_STAGING_WEB_URL,
      neonProjectId: environment.XPENSEGO_NEON_PROJECT_ID,
      neonBranchId: environment.XPENSEGO_NEON_BRANCH_ID,
    })),
    Effect.mapError(() => new Phase1StagingProofFailed({ step: "environment" })),
  );
}

function fetchManaged(url: string, init: RequestInit = {}) {
  return Effect.tryPromise({
    try: () =>
      fetch(url, {
        ...init,
        signal: AbortSignal.timeout(coldResumeRequestTimeoutMilliseconds),
      }),
    catch: (error) => asProofFailure(error, "managed_http_request"),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response)
        : Effect.fail(
            new Phase1StagingProofFailed({
              step: `managed_http_status_${response.status}`,
            }),
          ),
    ),
  );
}

function callJson<SchemaType extends Schema.Schema.AnyNoContext>(
  schema: SchemaType,
  url: string,
  init: RequestInit = {},
) {
  return fetchManaged(url, init).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.json(),
        catch: (error) => asProofFailure(error, "managed_http_json"),
      }),
    ),
    Effect.flatMap(Schema.decodeUnknown(schema)),
    Effect.mapError((error) => asProofFailure(error, "managed_http_response_schema")),
  );
}

function callProbe<SchemaType extends Schema.Schema.AnyNoContext>(
  schema: SchemaType,
  environment: ProofEnvironment,
  body: unknown,
) {
  return callJson(schema, `${environment.apiUrl}/_internal/phase1-staging-proof`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${Redacted.value(environment.probeSecret)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }).pipe(
    Effect.tap((result) =>
      requireProof(result.buildRevision === environment.expectedRevision, "deployed_revision"),
    ),
  );
}

function makeAdminLayer(databaseUrl: Redacted.Redacted<string>) {
  return PgClient.layer({
    url: databaseUrl,
    applicationName: "xpensego-phase1-staging-proof",
    connectTimeout: "15 seconds",
    idleTimeout: "1 second",
    maxConnections: 1,
  });
}

function restoreProofExit<A, E>(proofExit: Exit.Exit<A, E>) {
  return Exit.match(proofExit, {
    onFailure: (cause) => Effect.failCause(cause),
    onSuccess: (value) => Effect.succeed(value),
  });
}

function readProofState(outboxMessageId: OutboxMessageId) {
  return Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<{
      readonly inboundEventCount: unknown;
      readonly outboxMessageCount: unknown;
      readonly receiptCount: unknown;
      readonly deliveryAttempts: unknown;
      readonly status: unknown;
      readonly publishAttempts: unknown;
      readonly lastPublishErrorCode: unknown;
    }>`
      SELECT
        COUNT(DISTINCT event.id)::integer AS "inboundEventCount",
        COUNT(DISTINCT message.id)::integer AS "outboxMessageCount",
        COUNT(DISTINCT receipt.outbox_message_id)::integer AS "receiptCount",
        COALESCE(MAX(receipt.delivery_attempts), 0)::integer AS "deliveryAttempts",
        message.status,
        message.publish_attempts AS "publishAttempts",
        message.last_publish_error_code AS "lastPublishErrorCode"
      FROM inbound_channel_events AS event
      JOIN outbox_messages AS message ON message.inbound_event_id = event.id
      LEFT JOIN outbox_message_receipts AS receipt ON receipt.outbox_message_id = message.id
      WHERE message.id = ${outboxMessageId}
      GROUP BY message.id
    `;
    return yield* Schema.decodeUnknown(ProofState)(rows[0]);
  });
}

function runDatabaseAndQueueProof(environment: ProofEnvironment, runId: string) {
  const fixtureIds = makeFixtureIds();
  const cleanup = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      DELETE FROM users
      WHERE id IN (${fixtureIds.ownerUserId}, ${fixtureIds.otherOwnerUserId})
    `;
  }).pipe(
    Effect.mapError(() => new Phase1StagingProofFailed({ step: "application_fixture_cleanup" })),
  );

  const proof = Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`
      INSERT INTO users (id)
      VALUES (${fixtureIds.ownerUserId}), (${fixtureIds.otherOwnerUserId})
    `;
    yield* sql`
      INSERT INTO ledgers (id, owner_user_id)
      VALUES (${fixtureIds.ledgerId}, ${fixtureIds.ownerUserId})
    `;

    const acceptance = yield* callProbe(AcceptanceResponse, environment, {
      operation: "acceptInboundEvent",
      runId,
      ...fixtureIds,
    });
    yield* requireProof(
      acceptance.concurrentOutcomes.join(",") === "Accepted,Duplicate",
      "concurrent_idempotency",
    );
    yield* requireProof(
      acceptance.crossOwnerOutcome === "InboundEventOwnershipMismatch",
      "cross_owner_constraint",
    );

    const failedRows = yield* sql<{ readonly outboxMessageId: unknown }>`
      UPDATE outbox_messages
      SET
        publish_attempts = 1,
        last_publish_error_code = 'queue_unavailable',
        next_publish_attempt_at = CURRENT_TIMESTAMP
      WHERE id = ${acceptance.acceptedOutboxMessageId}
        AND status = 'pending'
      RETURNING id AS "outboxMessageId"
    `;
    yield* requireProof(failedRows.length === 1, "persisted_publication_failure_fixture");

    const recoveryStartedAt = yield* Clock.currentTimeMillis;
    let firstDeliveryState: typeof ProofState.Type | undefined;
    const recoveryPolls = Math.floor(maximumScheduledRecoveryWaitMilliseconds / 5_000);
    for (let attempt = 0; attempt < recoveryPolls; attempt += 1) {
      const state = yield* readProofState(acceptance.acceptedOutboxMessageId);
      if (state.receiptCount === 1) {
        firstDeliveryState = state;
        break;
      }
      yield* Effect.sleep("5 seconds");
    }
    const recoveryCompletedAt = yield* Clock.currentTimeMillis;
    const deliveredState =
      firstDeliveryState === undefined
        ? yield* Effect.fail(
            new Phase1StagingProofFailed({ step: "scheduled_queue_consumer_receipt" }),
          )
        : firstDeliveryState;
    yield* requireProof(
      deliveredState.status === "published" &&
        deliveredState.publishAttempts === 2 &&
        deliveredState.inboundEventCount === 1 &&
        deliveredState.outboxMessageCount === 1 &&
        deliveredState.lastPublishErrorCode === null,
      "durable_outbox_state",
    );

    yield* callProbe(RedeliveryResponse, environment, {
      operation: "redeliverOutbox",
      runId,
      outboxMessageId: acceptance.acceptedOutboxMessageId,
      redeliveryToken: acceptance.redeliveryToken,
    });
    let duplicateState = yield* readProofState(acceptance.acceptedOutboxMessageId);
    for (
      let attempt = 0;
      attempt < 12 && duplicateState.deliveryAttempts <= deliveredState.deliveryAttempts;
      attempt += 1
    ) {
      yield* Effect.sleep("2 seconds");
      duplicateState = yield* readProofState(acceptance.acceptedOutboxMessageId);
    }
    yield* requireProof(
      duplicateState.receiptCount === 1 &&
        duplicateState.deliveryAttempts > deliveredState.deliveryAttempts,
      "duplicate_queue_delivery",
    );

    return {
      concurrentOutcomes: acceptance.concurrentOutcomes,
      crossOwnerOutcome: acceptance.crossOwnerOutcome,
      scheduledRecoveryMilliseconds: recoveryCompletedAt - recoveryStartedAt,
      outboxState: deliveredState,
      duplicateReceiptCount: duplicateState.receiptCount,
      observedDeliveryAttempts: duplicateState.deliveryAttempts,
    };
  });

  return Effect.gen(function* () {
    const proofExit = yield* Effect.exit(proof);
    yield* cleanup;
    return yield* restoreProofExit(proofExit);
  }).pipe(
    Effect.provide(makeAdminLayer(environment.migrationDatabaseUrl)),
    Effect.scoped,
    Effect.mapError((error) => asProofFailure(error, "database_and_queue_proof")),
  );
}

function readNeonEndpoint(environment: ProofEnvironment) {
  return callJson(
    NeonEndpointList,
    `https://console.neon.tech/api/v2/projects/${environment.neonProjectId}/endpoints`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${Redacted.value(environment.neonApiKey)}`,
      },
    },
  ).pipe(
    Effect.flatMap((result) => {
      const endpoint = result.endpoints.find(
        (candidate: NeonEndpoint) =>
          candidate.branch_id === environment.neonBranchId && candidate.type === "read_write",
      );
      return endpoint === undefined
        ? Effect.fail(new Phase1StagingProofFailed({ step: "neon_staging_endpoint" }))
        : Effect.succeed(endpoint);
    }),
  );
}

function signUp(webUrl: string, email: string, name: string, password: string) {
  return fetchManaged(`${webUrl}/v1/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: webUrl, "content-type": "application/json" },
    body: JSON.stringify({ email, name, password }),
  }).pipe(
    Effect.flatMap((response) => {
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      return cookie === undefined
        ? Effect.fail(new Phase1StagingProofFailed({ step: "auth_session_cookie" }))
        : Effect.succeed(cookie);
    }),
  );
}

function readWorkspace(webUrl: string, cookie: string) {
  return fetchManaged(`${webUrl}/workspace`, { headers: { cookie } }).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: async () => ({
          body: await response.text(),
          cacheControl: response.headers.get("cache-control") ?? "",
        }),
        catch: (error) => asProofFailure(error, "workspace_response"),
      }),
    ),
  );
}

function cleanupAuthenticationFixtures(
  databaseUrl: Redacted.Redacted<string>,
  emails: ReadonlyArray<string>,
) {
  return Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql`DELETE FROM auth_user WHERE ${sql.in("email", emails)}`;
  }).pipe(
    Effect.provide(makeAdminLayer(databaseUrl)),
    Effect.scoped,
    Effect.mapError(() => new Phase1StagingProofFailed({ step: "authentication_fixture_cleanup" })),
  );
}

function proveAuthenticatedIsolationAndColdResume(environment: ProofEnvironment, runId: string) {
  const emailA = `phase1-a-${runId}@example.test`;
  const emailB = `phase1-b-${runId}@example.test`;
  const password = `Stg-${crypto.randomUUID()}!aA7`;
  const cleanup = cleanupAuthenticationFixtures(environment.migrationDatabaseUrl, [emailA, emailB]);

  const proof = Effect.gen(function* () {
    const webRevision = yield* callJson(
      WebRevisionResponse,
      `${environment.webUrl}/staging-proof/revision`,
    );
    yield* requireProof(
      webRevision.buildRevision === environment.expectedRevision,
      "deployed_web_revision",
    );

    const cookieA = yield* signUp(environment.webUrl, emailA, "Phase One Alpha", password);
    const cookieB = yield* signUp(environment.webUrl, emailB, "Phase One Beta", password);
    const workspaceA = yield* readWorkspace(environment.webUrl, cookieA);
    const workspaceB = yield* readWorkspace(environment.webUrl, cookieB);
    yield* requireProof(
      workspaceA.body.includes(emailA) && !workspaceA.body.includes(emailB),
      "workspace_a_isolation",
    );
    yield* requireProof(
      workspaceB.body.includes(emailB) && !workspaceB.body.includes(emailA),
      "workspace_b_isolation",
    );
    yield* requireProof(
      workspaceA.cacheControl.includes("private") &&
        workspaceA.cacheControl.includes("no-store") &&
        workspaceB.cacheControl.includes("private") &&
        workspaceB.cacheControl.includes("no-store"),
      "workspace_cache_isolation",
    );

    const anonymousWorkspace = yield* Effect.tryPromise({
      try: () =>
        fetch(`${environment.webUrl}/workspace`, {
          redirect: "manual",
          signal: AbortSignal.timeout(coldResumeRequestTimeoutMilliseconds),
        }),
      catch: (error) => asProofFailure(error, "anonymous_workspace_request"),
    });
    yield* requireProof(
      anonymousWorkspace.status === 307 &&
        anonymousWorkspace.headers.get("location") === "/sign-in",
      "anonymous_workspace_redirect",
    );

    const endpointBeforeIdle = yield* readNeonEndpoint(environment);
    const effectiveSuspendTimeoutSeconds = effectiveNeonSuspendTimeoutSeconds(
      endpointBeforeIdle.suspend_timeout_seconds,
    );
    yield* requireProof(
      effectiveSuspendTimeoutSeconds > 0 &&
        effectiveSuspendTimeoutSeconds <= maximumProvenNeonSuspendTimeoutSeconds,
      "neon_suspend_timeout_configuration",
    );
    const currentTime = yield* Clock.currentTimeMillis;
    const preIdleWait = coldResumeWaitMilliseconds(currentTime);
    if (preIdleWait > 0) {
      yield* Effect.logInfo("Waiting for an uninterrupted Neon idle window", {
        waitSeconds: Math.ceil(preIdleWait / 1_000),
      });
      yield* Effect.sleep(`${preIdleWait} millis`);
    }

    yield* Effect.logInfo("Beginning the Neon scale-to-zero observation window", {
      idleSeconds: 360,
    });
    yield* Effect.sleep("360 seconds");
    const idleEndpoint = yield* readNeonEndpoint(environment);
    yield* requireProof(idleEndpoint.current_state === "idle", "neon_compute_idle_state");

    const resumeStartedAt = yield* Clock.currentTimeMillis;
    const session = yield* callJson(
      BetterAuthWebSession,
      `${environment.webUrl}/v1/auth/get-session`,
      { headers: { cookie: cookieA } },
    );
    const resumeCompletedAt = yield* Clock.currentTimeMillis;
    const resumeLatencyMilliseconds = resumeCompletedAt - resumeStartedAt;
    yield* requireProof(session.user.email === emailA, "cold_resume_session_identity");
    yield* requireProof(
      resumeLatencyMilliseconds <= maximumColdResumeLatencyMilliseconds,
      "bounded_cold_resume_latency",
    );

    let activeEndpoint = yield* readNeonEndpoint(environment);
    for (let attempt = 0; attempt < 10 && activeEndpoint.current_state !== "active"; attempt += 1) {
      yield* Effect.sleep("2 seconds");
      activeEndpoint = yield* readNeonEndpoint(environment);
    }
    yield* requireProof(activeEndpoint.current_state === "active", "neon_compute_reactivated");

    return {
      isolatedSessions: 2,
      deployedWebRevision: webRevision.buildRevision,
      privateWorkspaceCacheControl: true,
      anonymousRedirect: true,
      neonStateBeforeIdle: endpointBeforeIdle.current_state,
      neonSuspendTimeoutSeconds: effectiveSuspendTimeoutSeconds,
      neonIdleState: idleEndpoint.current_state,
      neonReactivatedState: activeEndpoint.current_state,
      resumeLatencyMilliseconds,
      resumeBoundMilliseconds: maximumColdResumeLatencyMilliseconds,
    } as const;
  });

  return Effect.gen(function* () {
    const proofExit = yield* Effect.exit(proof);
    yield* cleanup;
    return yield* restoreProofExit(proofExit);
  });
}

const program = Effect.gen(function* () {
  const environment = yield* resolveEnvironment();
  const runId = proofRunId();
  const appliedMigrations = yield* runMigrations(environment.migrationDatabaseUrl).pipe(
    Effect.mapError((error) => asProofFailure(error, "empty_managed_migration")),
  );
  yield* requireProof(appliedMigrations.length === 0, "empty_managed_migration");
  const managedDataPath = yield* runDatabaseAndQueueProof(environment, runId);
  const authenticatedBoundary = yield* proveAuthenticatedIsolationAndColdResume(environment, runId);

  yield* Effect.logInfo("Phase 1 staging proof complete", {
    runId,
    deployedRevision: environment.expectedRevision,
    appliedMigrationCount: appliedMigrations.length,
    managedDataPath,
    authenticatedBoundary,
  });
}).pipe(Effect.asVoid);

NodeRuntime.runMain(program);
