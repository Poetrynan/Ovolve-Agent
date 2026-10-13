import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { DayPicker } from "react-day-picker"
import { cn } from "@/lib/utils"

export type CalendarProps = React.ComponentProps<typeof DayPicker>

// Hoisted out of Calendar's body on purpose: defined inline it is a brand-new
// component type on every render, so react-day-picker tears down and remounts
// both nav chevrons each time the month changes.
function CalendarChevron({ orientation }: { orientation?: "up" | "down" | "left" | "right" }) {
  const Icon = orientation === "left" ? ChevronLeft : ChevronRight
  return <Icon className="h-4 w-4" />
}

const calendarComponents = { Chevron: CalendarChevron }

function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={classNames as any}
      components={calendarComponents}
      {...props}
    />
  )
}
Calendar.displayName = "Calendar"

export { Calendar }
