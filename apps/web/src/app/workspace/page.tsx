import { connection } from "next/server";

/** Force request-time execution so later authenticated data cannot become shared static output. */
export const dynamic = "force-dynamic";

/**
 * Render the request-scoped workspace placeholder.
 *
 * @returns A dynamic Server Component that makes the pending authentication boundary explicit.
 */
export default async function WorkspacePage() {
  await connection();

  return (
    <main className="shell">
      <p className="eyebrow">Request-scoped route</p>
      <h1>The account boundary comes next.</h1>
      <p className="lede">
        This route is intentionally dynamic and uncached. It will expose ledger data only after the
        authentication provider and server-owned actor context are implemented.
      </p>
    </main>
  );
}
