/**
 * @zogal/ui — the Zogal ERP design system as code: shadcn primitives,
 * brand marks, feedback (toasts / Alert / Confirm), number + period helpers,
 * and the token stylesheet. Shared by the desktop app and the web dashboard
 * (TRD §3: frontend-desktop and frontend-web are separate modules; this is
 * what they have in common).
 */
export * from "./components/ui/badge.js";
export * from "./components/ui/button.js";
export * from "./components/ui/card.js";
export * from "./components/ui/dialog.js";
export * from "./components/ui/input.js";
export * from "./components/ui/label.js";
export * from "./components/ui/number-field.js";
export * from "./components/ui/separator.js";
export * from "./components/ui/sonner.js";
export * from "./components/ui/table.js";
export * from "./components/Alert.js";
export * from "./components/ConfirmDialog.js";
export * from "./components/PeriodPicker.js";
export * from "./components/brand/LeafField.js";
export * from "./components/brand/LoadingMark.js";
export * from "./components/brand/ZogalMark.js";
export * from "./lib/utils.js";
export * from "./lib/feedback.js";
export * from "./lib/errors.js";
export * from "./lib/periods.js";
export * from "./lib/numberFormat.js";
