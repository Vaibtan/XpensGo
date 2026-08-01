import Link from "next/link";

import { AuthForm } from "./auth-form";

/** Render the single first-party authentication entry surface. */
export default function SignInPage() {
  return (
    <main className="authShell">
      <aside className="ledgerRail" aria-label="Xpensego trust markers">
        <Link className="brandMark" href="/">
          XG
        </Link>
        <div className="railStatement">
          <span>Capture</span>
          <span>Confirm</span>
          <span>Control</span>
        </div>
        <p>Private by default</p>
      </aside>
      <AuthForm />
    </main>
  );
}
