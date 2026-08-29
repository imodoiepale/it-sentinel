import * as React from "react";
import Link from "next/link";
import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "ui-button-primary",
  secondary: "ui-button-secondary",
  ghost: "ui-button-ghost",
  destructive: "ui-button-destructive",
};

export function buttonClassName(variant: ButtonVariant = "primary", className?: string) {
  return cn("ui-button", variantClasses[variant], className);
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", type = "button", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={buttonClassName(variant, className)}
        {...props}
      />
    );
  },
);

Button.displayName = "Button";

export function ButtonLink({
  href,
  variant = "primary",
  className,
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={buttonClassName(variant, className)}>
      {children}
    </Link>
  );
}
