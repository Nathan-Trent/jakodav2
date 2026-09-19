import { IconLock } from "@tabler/icons-react";
import { Card, CardContent, Badge } from "@zogal/ui";
import { Page, PageHeader } from "@/components/Shell";

/** A section the shop's plan doesn't include (0027). Explains; the server refuses the calls regardless. */
export function PlanLockedScreen({ label }: { label: string }) {
  return (
    <>
      <PageHeader title={label} />
      <Page>
        <Card className="max-w-lg">
          <CardContent className="grid gap-3">
            <div className="flex items-center gap-3">
              <div className="size-11 rounded-[12px] bg-muted grid place-items-center text-muted-foreground"><IconLock size={22} stroke={1.75} /></div>
              <div>
                <div className="text-title">Not included in your plan</div>
                <div className="text-small text-muted-foreground">{label} is available on a higher plan. Upgrade under Subscription.</div>
              </div>
            </div>
            <Badge variant="secondary" className="w-fit">Upgrade to unlock</Badge>
          </CardContent>
        </Card>
      </Page>
    </>
  );
}
