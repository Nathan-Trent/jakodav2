import { PageHeader } from "@/components/AppShell";
import { Card, CardContent, Badge } from "@zogal/ui";
import type { NavItem } from "@/lib/nav";

/** Honest placeholder for a planned section — says what and when. */
export function ComingSoonScreen({ item }: { item: NavItem }) {
  return (
    <>
      <PageHeader title={item.label} />
      <div className="px-8 pb-8">
        <Card className="max-w-lg">
          <CardContent className="grid gap-3">
            <div className="flex items-center gap-3">
              <div className="size-11 rounded-[12px] bg-brand-mint/50 grid place-items-center text-brand-deep">
                <item.icon size={22} stroke={1.75} />
              </div>
              <div>
                <div className="text-title">Coming in stage {item.comingIn?.stage}</div>
                <div className="text-small text-muted-foreground">{item.comingIn?.what}</div>
              </div>
            </div>
            <Badge variant="secondary" className="w-fit">Planned</Badge>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
