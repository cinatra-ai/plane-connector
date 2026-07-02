import * as React from "react";

import { cn } from "../../lib/utils";

// Vendored shadcn-style Button primitive — dependency-free: NO radix and NO
// class-variance-authority, so it adds no dependency to this connector (deps
// stay clsx / tailwind-merge / zod / server-only). It lives under components/ui
// so the ui-design-system gate's raw-<button> ban is carved out here. One
// primary style is all this setup page needs (a Save submit).
function Button({ className, type, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type={type}
      data-slot="button"
      className={cn(
        "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-primary px-4 text-sm font-medium whitespace-nowrap text-primary-foreground transition-all outline-none select-none hover:bg-primary/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Button };
