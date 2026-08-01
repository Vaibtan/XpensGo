import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { readWebIdentity } from "../../server/authentication";
import { IdentityControls } from "./identity-controls";
import { SignOutButton } from "./sign-out-button";

export const dynamic = "force-dynamic";

/** Render only after the private API has resolved a valid first-party session. */
export default async function WorkspacePage() {
  const result = await readWebIdentity(new Headers(await headers()));
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
  const { identity } = result;

  return (
    <main className="workspaceShell">
      <header className="workspaceHeader">
        <div>
          <p className="eyebrow">Authenticated workspace</p>
          <p className="accountName">{identity.user.name}</p>
        </div>
        <SignOutButton />
      </header>
      <IdentityControls initialIdentity={identity} />
    </main>
  );
}
