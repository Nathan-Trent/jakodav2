import { IconLock } from "@tabler/icons-react";
import { PageHeader } from "@/components/AppShell";
import { Card, CardContent, Badge } from "@zogal/ui";
import type { NavItem } from "@/lib/nav";

/**
 * A section the shop's plan doesn't include (0027). Stays in the menu so the
 * product reads as one system; says plainly what to do. The server refuses
 * the underlying calls regardless — this is the explanation, not the lock.
 */
export function PlanLockedScreen({ item }: { item: NavItem }) {
  return (
    <>
      <PageHeader title={item.label} />
      <div className="px-8 pb-8">
        <Card className="max-w-lg">
          <CardContent className="grid gap-3">
            <div className="flex items-center gap-3">
              <div className="size-11 rounded-[12px] bg-muted grid place-items-center text-muted-foreground">
                <IconLock size={22} stroke={1.75} />
              </div>
              <div>
                <div className="text-title">Not included in your plan</div>
                <div className="text-small text-muted-foreground">
                  {item.label} is available on a higher plan. The shop owner can upgrade from the web dashboard under Subscription.
                </div>
              </div>
            </div>
            <Badge variant="secondary" className="w-fit">Upgrade to unlock</Badge>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
