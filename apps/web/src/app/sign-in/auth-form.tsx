"use client";

import { useState, type FormEvent } from "react";

type Mode = "sign-in" | "sign-up";

function readFormText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function readErrorMessage(candidate: unknown): string | undefined {
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "message" in candidate &&
    typeof candidate.message === "string"
  ) {
    return candidate.message;
  }
  return undefined;
}

export function AuthForm() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const payload = {
      email: readFormText(form, "email"),
      password: readFormText(form, "password"),
      ...(mode === "sign-up" ? { name: readFormText(form, "name") } : {}),
    };

    try {
      const response = await fetch(`/v1/auth/${mode}/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => undefined);
        setError(readErrorMessage(body) ?? "Check your details and try again.");
        return;
      }
      window.location.assign("/workspace");
    } catch {
      setError("Authentication is unavailable. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="authCard" aria-labelledby="auth-heading">
      <div className="authTabs" aria-label="Account action">
        <button
          className={mode === "sign-in" ? "authTab active" : "authTab"}
          onClick={() => setMode("sign-in")}
          type="button"
        >
          Sign in
        </button>
        <button
          className={mode === "sign-up" ? "authTab active" : "authTab"}
          onClick={() => setMode("sign-up")}
          type="button"
        >
          Create account
        </button>
      </div>
      <h1 id="auth-heading">{mode === "sign-in" ? "Return to your ledger." : "Start a ledger."}</h1>
      <p className="authIntro">
        {mode === "sign-in"
          ? "Your session stays on this Xpensego surface."
          : "Alpha accounts use email and password while recovery delivery is being proven."}
      </p>
      <form className="authFields" onSubmit={authenticate}>
        {mode === "sign-up" ? (
          <label>
            Name
            <input autoComplete="name" name="name" required />
          </label>
        ) : null}
        <label>
          Email
          <input autoComplete="email" name="email" required type="email" />
        </label>
        <label>
          Password
          <input
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            minLength={8}
            name="password"
            required
            type="password"
          />
        </label>
        {error ? (
          <p className="formError" role="alert">
            {error}
          </p>
        ) : null}
        <button className="primaryButton" disabled={pending} type="submit">
          {pending ? "Checking…" : mode === "sign-in" ? "Sign in" : "Create account"}
        </button>
      </form>
    </section>
  );
}
