import * as React from "react";
import { cn } from "@/lib/utils";

// Types following shadcn convention
export interface LoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Size variant of the loader */
  size?: "sm" | "default" | "lg" | "xl";
  /** Visual variant of the loader */
  variant?: "spinner" | "dots" | "pulse" | "progress" | "ring";
  /** Color variant following shadcn theme */
  color?: "default" | "primary" | "secondary" | "destructive" | "muted";
  /** Animation speed multiplier */
  speed?: "slow" | "normal" | "fast";
  /** Progress value for progress variant (0-100) */
  progress?: number;
  /** Show percentage text for progress variant */
  showPercentage?: boolean;
  /** Custom size in pixels (overrides size prop) */
  customSize?: number;
}

const sizeClasses = {
  sm: "h-4 w-4",
  default: "h-6 w-6",
  lg: "h-8 w-8",
  xl: "h-12 w-12",
} as const;

const dotSizeClasses = {
  sm: "h-1 w-1",
  default: "h-1.5 w-1.5",
  lg: "h-2 w-2",
  xl: "h-3 w-3",
} as const;

const colorClasses = {
  default: "text-foreground",
  primary: "text-primary",
  secondary: "text-secondary-foreground",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
} as const;

const speedClasses = {
  slow: "duration-1000",
  normal: "duration-700",
  fast: "duration-400",
} as const;

const Loader = React.forwardRef<HTMLDivElement, LoaderProps>(
  (
    {
      size = "default",
      variant = "spinner",
      color = "primary",
      speed = "normal",
      className,
      progress = 0,
      showPercentage = false,
      customSize,
      ...props
    },
    ref
  ) => {
    const validProgress = Math.min(100, Math.max(0, progress));
    const colorClass = colorClasses[color];
    const speedClass = speedClasses[speed];

    // Custom size style if provided
    const customSizeStyle = customSize
      ? {
          width: customSize,
          height: customSize,
        }
      : undefined;

    const renderLoader = () => {
      switch (variant) {
        case "dots":
          return (
            <div
              ref={ref}
              className={cn("flex gap-1.5 items-center justify-center", className)}
              role="status"
              aria-label="Loading"
              {...props}
            >
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={cn(
                    dotSizeClasses[size],
                    "rounded-full bg-current animate-bounce",
                    colorClass,
                    speedClass
                  )}
                  style={{
                    animationDelay: `${i * 0.15}s`,
                    animationDuration: `${speed === "slow" ? "1.4s" : speed === "fast" ? "0.8s" : "1s"}`,
                    ...customSizeStyle,
                  }}
                />
              ))}
            </div>
          );

        case "pulse":
          return (
            <div
              ref={ref}
              style={customSizeStyle}
              className={cn(
                sizeClasses[size],
                "rounded-full bg-current animate-pulse",
                colorClass,
                speedClass,
                className
              )}
              role="status"
              aria-label="Loading"
              {...props}
            />
          );

        case "ring":
          return (
            <div
              ref={ref}
              style={customSizeStyle}
              className={cn(
                sizeClasses[size],
                "rounded-full border-2 border-current border-t-transparent animate-spin",
                colorClass,
                speedClass,
                className
              )}
              role="status"
              aria-label="Loading"
              {...props}
            />
          );

        case "progress":
          return (
            <div
              ref={ref}
              className={cn("w-full max-w-xs space-y-2", className)}
              role="progressbar"
              aria-valuenow={validProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              {...props}
            >
              <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300 ease-in-out",
                    color === "default" && "bg-foreground",
                    color === "primary" && "bg-primary",
                    color === "secondary" && "bg-secondary",
                    color === "destructive" && "bg-destructive",
                    color === "muted" && "bg-muted-foreground"
                  )}
                  style={{ width: `${validProgress}%` }}
                />
              </div>
              {showPercentage && (
                <div className="text-center text-sm font-medium tabular-nums text-muted-foreground">
                  {Math.round(validProgress)}%
                </div>
              )}
            </div>
          );

        default: // spinner
          return (
            <div
              ref={ref}
              style={customSizeStyle}
              className={cn(
                sizeClasses[size],
                "rounded-full border-2 border-current border-t-transparent animate-spin",
                colorClass,
                speedClass,
                className
              )}
              role="status"
              aria-label="Loading"
              {...props}
            />
          );
      }
    };

    return renderLoader();
  }
);

Loader.displayName = "Loader";

// Compound component pattern following shadcn
const LoaderText = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, children, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  >
    {children}
  </p>
));
LoaderText.displayName = "LoaderText";

// Full loading component with text support
export interface FullLoaderProps extends LoaderProps {
  text?: string;
  textPosition?: "top" | "bottom" | "left" | "right";
}

const FullLoader = React.forwardRef<HTMLDivElement, FullLoaderProps>(
  ({ text, textPosition = "bottom", className, ...loaderProps }, ref) => {
    const isHorizontal = textPosition === "left" || textPosition === "right";
    
    return (
      <div
        ref={ref}
        className={cn(
          "flex items-center justify-center gap-3",
          isHorizontal ? "flex-row" : "flex-col",
          className
        )}
      >
        {textPosition === "top" || textPosition === "left" ? (
          <>
            <LoaderText>{text}</LoaderText>
            <Loader {...loaderProps} />
          </>
        ) : (
          <>
            <Loader {...loaderProps} />
            <LoaderText>{text}</LoaderText>
          </>
        )}
      </div>
    );
  }
);
FullLoader.displayName = "FullLoader";

// Skeleton loader variant for content loading
interface SkeletonLoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  count?: number;
  variant?: "text" | "circular" | "rectangular";
  width?: string | number;
  height?: string | number;
  className?: string;
}

const SkeletonLoader = React.forwardRef<HTMLDivElement, SkeletonLoaderProps>(
  ({ count = 1, variant = "text", width, height, className, ...props }, ref) => {
    const getSkeletonClass = () => {
      switch (variant) {
        case "circular":
          return "rounded-full";
        case "rectangular":
          return "rounded-md";
        default:
          return "rounded";
      }
    };

    return (
      <div ref={ref} className="space-y-2" {...props}>
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "animate-pulse bg-muted",
              getSkeletonClass(),
              className
            )}
            style={{
              width: width || (variant === "text" ? "100%" : undefined),
              height: height || (variant === "text" ? "1rem" : "2rem"),
            }}
          />
        ))}
      </div>
    );
  }
);
SkeletonLoader.displayName = "SkeletonLoader";

export { Loader, LoaderText, FullLoader, SkeletonLoader };

// Optional: Loading Button component
export interface LoadingButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  loaderProps?: Omit<LoaderProps, "size">;
  children: React.ReactNode;
}

const LoadingButton = React.forwardRef<HTMLButtonElement, LoadingButtonProps>(
  ({ loading, loaderProps, children, disabled, className, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
          "bg-primary text-primary-foreground hover:bg-primary/90 h-10 px-4 py-2",
          className
        )}
        {...props}
      >
        {loading && (
          <Loader
            size="sm"
            color="default"
            variant={loaderProps?.variant || "spinner"}
            className="mr-2"
          />
        )}
        {children}
      </button>
    );
  }
);
LoadingButton.displayName = "LoadingButton";

export default Loader;