import { IconDeviceDesktop } from "@tabler/icons-react";
import { useShopData } from "@/lib/shopData";
import { useSession } from "@/lib/session";

/**
 * "Which terminal?" — for an owner looking at activity across the shop.
 *
 * A plain select rather than tabs or chips: the list of terminals is short
 * but unbounded, and the owner's question is "show me only Terminal B", not
 * a comparison. "All terminals" is the default so nothing is hidden by
 * accident (Nielsen #1). Names come from the working set, so it works offline.
 */
export function TerminalFilter({ value, onChange }: { value: string | null; onChange: (deviceId: string | null) => void }) {
  const { data } = useShopData();
  const { device } = useSession();
  const terminals = data.devices.filter((d) => !d.revoked_at);
  if (terminals.length < 2) return null; // one terminal: nothing to filter by

  return (
    <label className="inline-flex items-center gap-2 text-small text-muted-foreground">
      <IconDeviceDesktop size={15} />
      <select
        className="h-9 rounded-md border bg-card px-2 text-sm text-foreground"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label="Filter by terminal"
      >
        <option value="">All terminals</option>
        {terminals.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}{device?.device_id === t.id ? " (this one)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Name for a device id, for labelling rows when "All terminals" is selected. */
export function useTerminalName(): (deviceId: string | null) => string | null {
  const { data } = useShopData();
  return (id) => (id ? (data.devices.find((d) => d.id === id)?.name ?? "Unknown terminal") : null);
}
