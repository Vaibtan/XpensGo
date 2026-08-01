"use client";

import { useState } from "react";

export function SignOutButton() {
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await fetch("/v1/auth/sign-out", { method: "POST" });
      window.location.assign("/sign-in");
    } finally {
      setPending(false);
    }
  }

  return (
    <button className="textButton" disabled={pending} onClick={signOut} type="button">
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
