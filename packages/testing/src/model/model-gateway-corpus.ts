/** Named quality slice for the first versioned provider-backed extraction corpus. */
export type ModelGatewayCorpusSlice =
  | "bank_debit"
  | "upi_credit"
  | "hinglish"
  | "misleading_multiple_amounts"
  | "missing_amount"
  | "missing_direction"
  | "ambiguous_date"
  | "missing_counterparty";

export interface ModelGatewayCorpusExpectedOutput {
  readonly outcome:
    | {
        readonly _tag: "Extracted";
        readonly amountMinor: number;
        readonly counterparty: string;
        readonly currency: "INR";
        readonly direction: "debit" | "credit";
        readonly occurredOn: string;
        readonly requiresReview: boolean;
      }
    | {
        readonly _tag: "ClarificationRequired";
        readonly reason:
          | "missing_amount"
          | "ambiguous_amount"
          | "missing_direction"
          | "missing_date"
          | "ambiguous_date"
          | "missing_counterparty";
      };
}

export interface ModelGatewayCorpusFixture {
  readonly canonicalInput: string;
  readonly expected: ModelGatewayCorpusExpectedOutput;
  readonly fixtureId: string;
  readonly inputDigest: string;
  readonly slice: ModelGatewayCorpusSlice;
  readonly version: 1;
}

/**
 * Reviewed synthetic corpus for the initial single-transaction extraction gate.
 * Raw fixture contents must never enter logs, metrics, Queue jobs, or proof output.
 */
export const modelGatewayExtractionCorpusV1 = [
  {
    version: 1,
    fixtureId: "bank-debit-exact",
    slice: "bank_debit",
    canonicalInput: "Synthetic Bank: INR 123.45 debited on 2026-08-08 at Synthetic Grocer.",
    inputDigest: "2e103aa3e3879838516698fb514652214d134b01fe43a3c8b8c62ac36d2e8967",
    expected: {
      outcome: {
        _tag: "Extracted",
        amountMinor: 12_345,
        counterparty: "Synthetic Grocer",
        currency: "INR",
        direction: "debit",
        occurredOn: "2026-08-08",
        requiresReview: false,
      },
    },
  },
  {
    version: 1,
    fixtureId: "upi-credit-exact",
    slice: "upi_credit",
    canonicalInput: "UPI credit: INR 50.00 received from Synthetic Sender on 2026-08-07.",
    inputDigest: "a36ac2d75f6714e9a617caa329bd6b03e876d0bfbaf37aa37e904f27400d012e",
    expected: {
      outcome: {
        _tag: "Extracted",
        amountMinor: 5_000,
        counterparty: "Synthetic Sender",
        currency: "INR",
        direction: "credit",
        occurredOn: "2026-08-07",
        requiresReview: false,
      },
    },
  },
  {
    version: 1,
    fixtureId: "hinglish-debit-exact",
    slice: "hinglish",
    canonicalInput: "2026-08-06 ko Synthetic Cafe par 250 rupaye debit hue.",
    inputDigest: "02de97dd9925892caa44917b981f549e1a6fb487fd7c2a1cc3d5d50bfcd3ac44",
    expected: {
      outcome: {
        _tag: "Extracted",
        amountMinor: 25_000,
        counterparty: "Synthetic Cafe",
        currency: "INR",
        direction: "debit",
        occurredOn: "2026-08-06",
        requiresReview: false,
      },
    },
  },
  {
    version: 1,
    fixtureId: "multiple-amount-bank-debit",
    slice: "misleading_multiple_amounts",
    canonicalInput:
      "Synthetic card purchase INR 500.00; available limit INR 10,000.00; debited at Synthetic Market on 2026-08-05.",
    inputDigest: "01cd6dced162bea53a7d51199948e3ea0c2e87b4f8e110ce039d148c8ade8fd1",
    expected: {
      outcome: {
        _tag: "Extracted",
        amountMinor: 50_000,
        counterparty: "Synthetic Market",
        currency: "INR",
        direction: "debit",
        occurredOn: "2026-08-05",
        requiresReview: true,
      },
    },
  },
  {
    version: 1,
    fixtureId: "missing-amount",
    slice: "missing_amount",
    canonicalInput: "Paid Synthetic Vendor on 2026-08-05.",
    inputDigest: "315a9238ae399632b5066944849c9d3675e1359507c8ef2ea6621e8b2f3621ee",
    expected: { outcome: { _tag: "ClarificationRequired", reason: "missing_amount" } },
  },
  {
    version: 1,
    fixtureId: "missing-direction",
    slice: "missing_direction",
    canonicalInput: "INR 300.00 Synthetic Wallet on 2026-08-04.",
    inputDigest: "9357c02d7a18b76277c5fd3dff5cffc29493ce1485ab05cd25040f46e331ad75",
    expected: { outcome: { _tag: "ClarificationRequired", reason: "missing_direction" } },
  },
  {
    version: 1,
    fixtureId: "ambiguous-date",
    slice: "ambiguous_date",
    canonicalInput: "Paid INR 75.00 to Synthetic Shop on 08/09/2026.",
    inputDigest: "a146240b4a214bbef19d2ca9e35308b0283a5d319da001cb1a217c11416d07af",
    expected: { outcome: { _tag: "ClarificationRequired", reason: "ambiguous_date" } },
  },
  {
    version: 1,
    fixtureId: "missing-counterparty",
    slice: "missing_counterparty",
    canonicalInput: "INR 125.00 debited on 2026-08-03.",
    inputDigest: "32f4ac600c549977a7cf6ac0b2b1fed42d1522b0fb592215981bd1dda085cdcc",
    expected: { outcome: { _tag: "ClarificationRequired", reason: "missing_counterparty" } },
  },
] as const satisfies ReadonlyArray<ModelGatewayCorpusFixture>;

/** Resolve only an allow-listed synthetic fixture by opaque identifier. */
export function findModelGatewayExtractionFixture(fixtureId: string) {
  return modelGatewayExtractionCorpusV1.find((fixture) => fixture.fixtureId === fixtureId);
}
