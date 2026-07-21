import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const buttonVariants = cva("button", {
  variants: {
    variant: {
      default: "button-default",
      secondary: "button-secondary",
      ghost: "button-ghost",
      destructive: "button-destructive",
    },
    size: {
      default: "button-md",
      sm: "button-sm",
      lg: "button-lg",
      icon: "button-icon",
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
