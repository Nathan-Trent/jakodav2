import { useState, type FormEvent } from "react";
import { AuthFrame } from "@/components/AuthFrame";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, notifyError, notifySuccess } from "@zogal/ui";
import { useSession } from "@/lib/session";

export function LoginScreen({ variant = "shop" }: { variant?: "shop" | "admin" } = {}) {
  const { auth } = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        await auth.signUp({ email, password, fullName });
        notifySuccess("Account created", { description: "If email confirmation is on, check your inbox, then sign in." });
        setMode("signin");
      } else {
        await auth.signIn({ email, password });
        // onAuthStateChange in SessionProvider takes it from here
      }
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame sub={variant === "admin" ? "Back office" : "Business"}>
      <Card className="w-full max-w-sm elev-3">
        <CardHeader>
          <CardTitle className="text-heading">{variant === "admin" ? "Zogal back office" : "Welcome back"}</CardTitle>
          <CardDescription>{variant === "admin" ? "Platform admins only" : mode === "signin" ? "Sign in to your shop" : "Create your account"}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4">
            {mode === "signup" && (
              <div className="grid gap-2">
                <Label htmlFor="fullName">Full name</Label>
                <Input id="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} required autoComplete="name" />
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
            </Button>
            {variant === "shop" && <Button type="button" variant="link" className="text-muted-foreground" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
              {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
            </Button>}
          </form>
        </CardContent>
      </Card>
    </AuthFrame>
  );
}
