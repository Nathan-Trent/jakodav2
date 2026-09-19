import { useState, type FormEvent } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, friendlyError, Input, Label } from "@zogal/ui";
import { useSession } from "@/lib/session";
import { useOnline } from "@/lib/useOnline";

/**
 * Sign in / create an account. Every state is visible on the button itself
 * (Nathan: "you don't know if the sign in worked, you don't know if it's
 * processing") — idle → checking → opening, never a silent gap. After
 * signIn() resolves there is still a network round trip (bootstrap) before
 * the app switches away from this screen, so "opening" is held rather than
 * reset — the button never flashes back to "Sign in" first.
 */
type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "opening" }
  | { kind: "creating" }
  | { kind: "created"; needsConfirm: boolean }
  | { kind: "error"; title: string; detail?: string };

export function LoginScreen() {
  const { auth } = useSession();
  const online = useOnline();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind === "checking" || phase.kind === "opening" || phase.kind === "creating";

  function switchMode(next: "signin" | "signup") {
    setMode(next);
    setPhase({ kind: "idle" });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    try {
      if (mode === "signup") {
        setPhase({ kind: "creating" });
        const { session } = await auth.signUp({ email, password, fullName });
        setPhase({ kind: "created", needsConfirm: !session });
        if (session) return; // onAuthStateChange takes over; stay on "created" until the screen unmounts.
      } else {
        setPhase({ kind: "checking" });
        await auth.signIn({ email, password });
        setPhase({ kind: "opening" }); // onAuthStateChange → bootstrap() → the app switches screens from here
      }
    } catch (err) {
      const f = friendlyError(err);
      setPhase({ kind: "error", title: f.title, detail: [f.detail, f.action].filter(Boolean).join(" ") });
    }
  }

  const buttonLabel =
    phase.kind === "checking" ? "Checking your details…"
    : phase.kind === "opening" ? "Signed in — opening your dashboard…"
    : phase.kind === "creating" ? "Creating your account…"
    : mode === "signin" ? "Sign in" : "Create account";

  return (
    <AuthFrame>
      <Card className="w-full max-w-sm elev-3">
        <CardHeader>
          <CardTitle className="text-heading">{mode === "signin" ? "Welcome back" : "Create your account"}</CardTitle>
          <CardDescription>{mode === "signin" ? "Sign in to your shop" : "A minute, then create or join a shop"}</CardDescription>
        </CardHeader>
        <CardContent>
          {phase.kind === "created" ? (
            <div className="grid gap-4">
              <Alert tone="success" title="Account created">
                {phase.needsConfirm
                  ? "Check your inbox for a confirmation link, then sign in below."
                  : "Signing you in…"}
              </Alert>
              {phase.needsConfirm && (
                <Button type="button" className="w-full" onClick={() => switchMode("signin")}>Sign in</Button>
              )}
            </div>
          ) : (
            <form onSubmit={submit} className="grid gap-4" aria-busy={busy}>
              {!online && <Alert tone="warning" title="No internet connection">Signing in needs a connection.</Alert>}
              {phase.kind === "error" && <Alert tone="critical" title={phase.title}>{phase.detail}</Alert>}
              {mode === "signup" && (
                <div className="grid gap-2">
                  <Label htmlFor="fullName">Full name</Label>
                  <Input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} required autoComplete="name" disabled={busy} />
                </div>
              )}
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus disabled={busy} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={mode === "signin" ? "current-password" : "new-password"} disabled={busy} />
              </div>
              <Button type="submit" className="w-full" disabled={busy || !online}>{buttonLabel}</Button>
              <p aria-live="polite" className="text-caption text-muted-foreground text-center -mt-2 min-h-4">
                {phase.kind === "checking" || phase.kind === "creating" ? "Talking to Zogal…" : phase.kind === "opening" ? "One moment." : ""}
              </p>
              <Button type="button" variant="link" className="text-muted-foreground" disabled={busy} onClick={() => switchMode(mode === "signin" ? "signup" : "signin")}>
                {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </AuthFrame>
  );
}
