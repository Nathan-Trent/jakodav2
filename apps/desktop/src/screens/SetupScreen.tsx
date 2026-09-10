import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, useSession } from "@/lib/session";
import { defaultDeviceName } from "@/lib/device";

/**
 * Shown when the signed-in user has no shop, or this terminal isn't yet
 * bound to a shop (TRD §1 device activation).
 *
 * Two activation paths:
 *  - "Enter a code" — code generated elsewhere (web dashboard, Stage 8).
 *  - "Activate as owner" — the Owner is standing at this terminal, so we
 *    mint a code and redeem it in one step. Same DB path, no shortcut.
 */
export function SetupScreen() {
  const { ctx, auth, device, setDevice, refresh, signOut } = useSession();
  const memberships = ctx?.memberships ?? [];
  const canActivate = memberships.filter((m) => m.permissions.includes("shop.settings"));

  const [shopName, setShopName] = useState("");
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function createShop(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await auth.createShop(shopName);
      await refresh();
    });
  }

  function activateWithCode(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      setDevice(await auth.activateDevice(code, deviceName));
      toast.success("Terminal activated");
    });
  }

  function activateAsOwner(shopId: string) {
    void run(async () => {
      const { code } = await auth.createActivationCode(shopId);
      setDevice(await auth.activateDevice(code, deviceName));
      toast.success("Terminal activated");
    });
  }

  const boundToOtherShop = device && !memberships.some((m) => m.shop.id === device.shop_id);

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md grid gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Set up this terminal</h1>
            <p className="text-sm text-muted-foreground">Signed in as {ctx?.user?.full_name}</p>
          </div>
          <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
        </div>

        {boundToOtherShop && (
          <Card>
            <CardHeader>
              <CardTitle>Terminal belongs to another shop</CardTitle>
              <CardDescription>
                Ask that shop's owner to invite you, or reset the terminal binding.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="secondary" onClick={() => setDevice(null)}>Reset terminal binding</Button>
            </CardContent>
          </Card>
        )}

        {memberships.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Open a new shop</CardTitle>
              <CardDescription>You'll be its Owner. Staff can be invited afterwards.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={createShop} className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="shopName">Shop name</Label>
                  <Input id="shopName" value={shopName} onChange={(e) => setShopName(e.target.value)} required maxLength={120} autoFocus />
                </div>
                <Button disabled={busy}>Create shop</Button>
              </form>
            </CardContent>
          </Card>
        )}

        {!device && memberships.length > 0 && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Terminal name</CardTitle>
              </CardHeader>
              <CardContent>
                <Input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} maxLength={80} />
              </CardContent>
            </Card>

            {canActivate.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Activate for your shop</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {canActivate.map((m) => (
                    <Button key={m.shop.id} size="lg" disabled={busy} onClick={() => activateAsOwner(m.shop.id)}>
                      Activate for “{m.shop.name}”
                    </Button>
                  ))}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Or enter an activation code</CardTitle>
                <CardDescription>Generated by the shop owner from the dashboard. Valid 10 minutes.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={activateWithCode} className="grid gap-3">
                  <Input className="font-mono tracking-widest uppercase" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD2345" maxLength={8} required />
                  <Button variant="secondary" disabled={busy || code.length < 8}>Activate</Button>
                </form>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
