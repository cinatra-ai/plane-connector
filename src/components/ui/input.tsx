import * as React from "react";

import { cn } from "../../lib/utils";

// Vendored shadcn Input primitive — dependency-free (React + cn only). It lives
// under components/ui so the ui-design-system gate's raw-<input> ban is carved
// out here: this primitive is the sanctioned wrapper the rest of the connector
// renders instead of a raw <input>.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-surface-strong px-3 py-1 text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
