import * as React from "react"

import { cn } from "@/lib/utils"

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Motion mode. ``pulse`` (default) matches the shadcn baseline — a soft
   * opacity blink that reads as "waiting". ``sweep`` runs a light band across
   * the surface which reads as "actively loading right now"; use it for
   * cards the user just clicked on so the click feels acknowledged.
   *
   * Both modes obey ``prefers-reduced-motion``: users with motion suppressed
   * see a static placeholder, never a wobble that can't be turned off.
   */
  motion?: "pulse" | "sweep" | "none"
}

/**
 * Placeholder surface for content that hasn't arrived yet.
 *
 * The sweep variant is intentionally a mask over the same muted background,
 * not a color change — a skeleton that shifts hue draws the eye away from
 * whatever is actually loading in beside it.
 */
function Skeleton({ className, motion = "pulse", ...props }: SkeletonProps) {
  return (
    <div
      data-motion={motion}
      className={cn(
        "rounded-md bg-muted relative overflow-hidden",
        motion === "pulse" && "motion-safe:animate-pulse",
        motion === "sweep" && "motion-safe:skeleton-sweep",
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
