// components/ui/resizable.tsx
//
// Thin wrapper over the installed `react-resizable-panels` build (v4.x, this
// fork exports Group/Panel/Separator, not the more common bvaughn API), so
// the rest of the app can import familiar shadcn-style names:
//
//   ResizablePanelGroup / ResizablePanel / ResizableHandle
//
// Notes on the API drift this file hides:
//   - `direction` → `orientation`
//   - React `ref` on Panel → `panelRef` prop (custom API, not forwardRef)
//   - `PanelResizeHandle` → `Separator`
//   - `ImperativePanelHandle` → `PanelImperativeHandle`
//
// Persistence is DIY (this build has no `autoSaveId`): callers pass an `id` to
// the group and pair it with `defaultLayout` + `onLayoutChanged`. See
// WorkspaceShell / ChatPage for the localStorage pattern.
import { useCallback, useState, type Ref } from "react"
import { GripVertical } from "lucide-react"
import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type Layout,
  type PanelProps,
  type PanelImperativeHandle,
  type SeparatorProps,
} from "react-resizable-panels"
import { cn } from "@/lib/utils"

export type { PanelImperativeHandle }

/**
 * Remember a group's layout across reloads.
 *
 * This build has no `autoSaveId`, so persistence is wired by hand: read once on
 * mount for `defaultLayout`, write back from `onLayoutChanged`. That callback
 * only fires when a drag ENDS (not on every pointer move), so there is no need
 * to debounce the write.
 *
 * `onlyUserInteraction` filters out layout changes the library makes on its own
 * (initial mount, window resize, imperative collapse/expand). Without it, an
 * automatic collapse would overwrite the width the user had chosen, and their
 * preferred size would be lost the first time they hid the panel.
 */
export function useStoredLayout(storageKey: string) {
  const [defaultLayout] = useState<Layout | undefined>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw ? (JSON.parse(raw) as Layout) : undefined
    } catch {
      return undefined
    }
  })

  const onLayoutChanged = useCallback(
    (layout: Layout, meta: { isUserInteraction: boolean }) => {
      if (!meta.isUserInteraction) return
      try {
        localStorage.setItem(storageKey, JSON.stringify(layout))
      } catch {
        /* ignore quota */
      }
    },
    [storageKey],
  )

  return { defaultLayout, onLayoutChanged }
}

/** Horizontal by default — pass `orientation="vertical"` for a stacked group. */
export const ResizablePanelGroup = ({ className, ...props }: GroupProps) => (
  <Group
    className={cn(
      "flex h-full w-full data-[orientation=vertical]:flex-col",
      className
    )}
    {...props}
  />
)

/** Panel — same as underlying; use `panelRef` (NOT React `ref`) for the
 *  imperative handle (`collapse()` / `expand()` / `isCollapsed()`). */
export const ResizablePanel = (props: PanelProps & { panelRef?: Ref<PanelImperativeHandle | null> }) => (
  <Panel {...(props as PanelProps)} />
)

/** The draggable divider between panels. `withHandle` renders a grip icon
 *  that makes the affordance obvious the first time; skip it for a slimmer
 *  IDE-style splitter. */
export const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: SeparatorProps & { withHandle?: boolean }) => (
  <Separator
    className={cn(
      // Base: hairline divider with a fatter invisible hit target either side.
      "relative flex w-px items-center justify-center bg-border",
      "after:absolute after:inset-y-0 after:left-1/2 after:w-2 after:-translate-x-1/2",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
      // Vertical orientation flips the hairline to a horizontal one.
      "data-[orientation=vertical]:h-px data-[orientation=vertical]:w-full",
      "data-[orientation=vertical]:after:left-0 data-[orientation=vertical]:after:h-2 data-[orientation=vertical]:after:w-full data-[orientation=vertical]:after:-translate-y-1/2 data-[orientation=vertical]:after:translate-x-0",
      "[&[data-orientation=vertical]>div]:rotate-90",
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
        <GripVertical className="h-2.5 w-2.5" />
      </div>
    )}
  </Separator>
)
