import { useState, type FormEvent } from "react";
import { errorMessage, useSession } from "../lib/session.js";

export function LoginScreen() {
  const { auth } = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signup") {
        await auth.signUp({ email, password, fullName });
        setNotice("Account created. If email confirmation is on, check your inbox, then sign in.");
        setMode("signin");
      } else {
        await auth.signIn({ email, password });
        // onAuthStateChange in SessionProvider takes it from here
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-xl font-semibold">JakoDav</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "signin" ? "Sign in to your shop" : "Create your account"}
          </p>
        </div>

        {mode === "signup" && (
          <div>
            <label className="label" htmlFor="fullName">Full name</label>
            <input id="fullName" className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} required autoComplete="name" />
          </div>
        )}
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
        </div>

        {error && <div className="alert-error">{error}</div>}
        {notice && <div className="rounded-md bg-muted px-3 py-2 text-sm">{notice}</div>}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
        <button type="button" className="btn-ghost w-full text-muted-foreground" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
