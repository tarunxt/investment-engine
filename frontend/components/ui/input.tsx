import * as React from "react"

import { cn } from "@/lib/utils"
import { cva, VariantProps } from "class-variance-authority";

const inputVariants = cva(
  "h-10 w-full min-w-0 border border-transparent border-b-input bg-transparent px-2 py-1 text-base transition-[color,border-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-b-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-b-destructive md:text-sm dark:aria-invalid:border-b-destructive/50 peer-data-[state=invalid]:border-b-destructive",
  {
    variants: {
      variant: {
        default: "",
        error: "border-b-red-500 focus:border-b-red-500",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function Input({
  className,
  type,
  variant = "default",
  ...props
}: React.ComponentProps<"input"> &
  VariantProps<typeof inputVariants>) {

  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        inputVariants({ variant, className }),
        className
      )}
      {...props}
    />
  )
}

export { Input }
