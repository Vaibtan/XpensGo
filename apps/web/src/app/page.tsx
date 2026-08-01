import Link from "next/link";

/**
 * Render the public platform-tracer landing page as a Server Component.
 *
 * @returns The minimal replacement application entry page.
 */
export default function HomePage() {
  return (
    <main className="shell">
      <p className="eyebrow">Replacement platform tracer</p>
      <h1>Your ledger, ready for every surface.</h1>
      <p className="lede">
        The production foundation now runs on Next.js and Cloudflare. Financial capture remains
        disabled until identity, ownership, and Neon persistence are proven.
      </p>
      <Link className="primaryLink" href="/workspace">
        Open your workspace
      </Link>
    </main>
  );
}
