import { useState, type FormEvent } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, notifyError, notifySuccess } from "@zogal/ui";
import { AuthFrame } from "@/components/AuthFrame";
import { useSession } from "@/lib/session";

/**
 * A signed-in person with no shop. The site promises "create the shop in a
 * minute on your phone" — this is that minute. create_shop() (0002) makes
 * them Owner; refresh() then lands them on the dashboard. Staff who were
 * invited get in through the same door once the owner's invite matches
 * their email (accept_my_invitations runs at bootstrap).
 */
export function CreateShopScreen() {
  const { ctx, auth, refresh, signOut } = useSession();
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<"idle" | "creating" | "opening">("idle");
  const first = ctx?.user?.full_name?.split(" ")[0] ?? "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (phase !== "idle") return;
    setPhase("creating");
    try {
      await auth.createShop(name.trim());
      setPhase("opening");
      notifySuccess("Your shop is ready", { description: "Add items when you like; install Doka on the shop computer when you're ready to sell." });
      await refresh();
    } catch (err) {
      notifyError(err);
      setPhase("idle");
    }
  }

  return (
    <AuthFrame title="One name, and you're in.">
      <Card className="w-full max-w-[420px]">
        <CardHeader>
          <CardTitle className="text-heading">{first ? `Welcome, ${first}.` : "Welcome."}</CardTitle>
          <CardDescription>Give your shop a name to open your dashboard. You can change it later. No card needed.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="grid gap-4" aria-busy={phase !== "idle"}>
            <div className="grid gap-2">
              <Label htmlFor="shop">Shop name</Label>
              <Input id="shop" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoFocus disabled={phase !== "idle"} placeholder="e.g. Sunrise Provisions" />
            </div>
            <Button type="submit" disabled={phase !== "idle" || name.trim().length < 2} className="w-full">
              {phase === "creating" ? "Creating your shop…" : phase === "opening" ? "Opening your dashboard…" : "Create my shop"}
            </Button>
            <p className="text-caption text-muted-foreground">
              Joining someone else's shop? Ask the owner to invite you with this email ({ctx?.user?.email}); it opens on your next sign-in.
            </p>
            <Button type="button" variant="link" className="text-muted-foreground justify-start px-0" onClick={() => void signOut()}>Not you? Sign out</Button>
          </form>
        </CardContent>
      </Card>
    </AuthFrame>
  );
}
