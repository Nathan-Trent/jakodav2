import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      toastOptions={{ classNames: { toast: "elev-3 rounded-[12px] font-sans", description: "text-muted-foreground" } }}
      style={
        {
          // tokens are HSL triplets, so wrap them
          "--normal-bg": "hsl(var(--popover))",
          "--normal-text": "hsl(var(--popover-foreground))",
          "--normal-border": "hsl(var(--border))",
          "--success-bg": "#DCFCE7",
          "--success-text": "#15803D",
          "--success-border": "#BBF7D0",
          "--error-bg": "#FEE2E2",
          "--error-text": "#B91C1C",
          "--error-border": "#FECACA",
          "--warning-bg": "#FEF9C3",
          "--warning-text": "#A16207",
          "--warning-border": "#FDE68A",
          "--info-bg": "hsl(var(--popover))",
          "--info-text": "hsl(var(--popover-foreground))",
          "--info-border": "hsl(var(--border))",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
