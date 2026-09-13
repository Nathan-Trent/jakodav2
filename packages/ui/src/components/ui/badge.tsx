import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border px-[9px] py-[3px] text-[11px] font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary: "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive: "border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90",
        outline: "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        success: "bg-[#DCFCE7] text-[#15803D] border-[#BBF7D0] dark:bg-status-green/15 dark:text-brand-signal dark:border-status-green/25",
        warning: "bg-[#FEF9C3] text-[#A16207] border-[#FDE68A] dark:bg-status-amber/15 dark:text-[#FCD34D] dark:border-status-amber/25",
        critical: "bg-[#FEE2E2] text-[#B91C1C] border-[#FECACA] dark:bg-status-red/15 dark:text-[#F87171] dark:border-status-red/25",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
