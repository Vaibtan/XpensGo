import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { readWebSession } from "../../server/authentication";
import { SignOutButton } from "./sign-out-button";

export const dynamic = "force-dynamic";

/** Render only after the private API has resolved a valid first-party session. */
export default async function WorkspacePage() {
  const result = await readWebSession(new Headers(await headers()));
  if (result._tag === "Unauthenticated") {
    redirect("/sign-in");
  }
  if (result._tag === "Unavailable") {
    return (
      <main className="workspaceShell">
        <section className="workspaceEmpty">
          <p className="workspaceIndex">Session / unavailable</p>
          <h1>We cannot verify your session.</h1>
          <p>No account data was loaded. Refresh this page in a moment.</p>
        </section>
      </main>
    );
  }
  const { session } = result;

  return (
    <main className="workspaceShell">
      <header className="workspaceHeader">
        <div>
          <p className="eyebrow">Authenticated workspace</p>
          <p className="accountName">{session.user.name}</p>
        </div>
        <SignOutButton />
      </header>
      <section className="workspaceEmpty">
        <p className="workspaceIndex">Ledger / 00</p>
        <h1>Your account boundary is live.</h1>
        <p>
          Signed in as {session.user.email}. Financial capture remains closed until the next
          ownership and ledger tracer is complete.
        </p>
      </section>
    </main>
  );
}
