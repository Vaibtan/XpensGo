import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./styles.css";

/** Metadata shared by the minimal replacement web application. */
export const metadata: Metadata = {
  title: "Xpensego",
  description: "A trustworthy ledger across web and messaging surfaces.",
};

type RootLayoutProperties = {
  readonly children: ReactNode;
};

/**
 * Render the root document shell.
 *
 * @param properties - The route content selected by Next.js.
 * @returns The server-rendered application document.
 */
export default function RootLayout({ children }: RootLayoutProperties) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
