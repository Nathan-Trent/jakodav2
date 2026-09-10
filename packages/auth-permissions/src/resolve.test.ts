import { describe, expect, it } from "vitest";
import { resolvePermissions, can } from "./resolve.js";

describe("resolvePermissions", () => {
  it("grants role permissions", () => {
    const p = resolvePermissions(["sales.create"]);
    expect(can(p, "sales.create")).toBe(true);
    expect(can(p, "items.view_cost")).toBe(false);
  });

  it("applies per-member grants and revokes on top of the role", () => {
    const p = resolvePermissions(
      ["sales.create", "items.view_cost"],
      [
        { permissionKey: "items.view_cost", allowed: false },
        { permissionKey: "reports.view", allowed: true },
      ],
    );
    expect(can(p, "items.view_cost")).toBe(false);
    expect(can(p, "reports.view")).toBe(true);
    expect(can(p, "sales.create")).toBe(true);
  });
});
