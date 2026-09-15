/**
 * AppFrame — Three-panel layout
 * 
 * Three-panel application shell:
 * - Left sidebar (280px, collapsible to 56px)
 * - Center content (flex, min 640px)
 * - Right details panel (360px, auto-collapse)
 * 
 * Features:
 * - CSS Grid with smooth transitions
 * - Drag handles for resizing
 * - Auto-collapse below 1024px viewport
 * - Concession chain for overflow
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import styles from './AppFrame.module.css';

// Column dimensions
const SIDEBAR_DEFAULT = 300;
const SIDEBAR_MIN = 260;
const SIDEBAR_MAX = 460;
const SIDEBAR_COLLAPSED = 56;
const DETAILS_DEFAULT = 360;
const DETAILS_MIN = 300;
const DETAILS_MAX = 520;
const CENTER_MIN = 640;
const SIDEBAR_AUTO_COLLAPSE = 1024;

interface AppFrameProps {
  sidebar: React.ReactNode;
  children: React.ReactNode;  // Center content
  details?: React.ReactNode;  // Right panel
  detailsOpen?: boolean;
  onDetailsOpenChange?: (open: boolean) => void;
}

export function AppFrame({
  sidebar,
  children,
  details,
  detailsOpen = false,
  onDetailsOpenChange,
}: AppFrameProps) {
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [detailsWidth, setDetailsWidth] = useState(DETAILS_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dragging, setDragging] = useState<'sidebar' | 'details' | null>(null);
  
  const frameRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // Auto-collapse sidebar below breakpoint
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${SIDEBAR_AUTO_COLLAPSE}px)`);
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      setSidebarCollapsed(e.matches);
    };
    handler(mq);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Drag handlers
  const handleDragStart = useCallback((type: 'sidebar' | 'details', e: React.PointerEvent) => {
    setDragging(type);
    dragStartX.current = e.clientX;
    dragStartWidth.current = type === 'sidebar' ? sidebarWidth : detailsWidth;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [sidebarWidth, detailsWidth]);

  const handleDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    
    const delta = e.clientX - dragStartX.current;
    if (dragging === 'sidebar') {
      const newWidth = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, dragStartWidth.current + delta));
      setSidebarWidth(newWidth);
      if (newWidth < SIDEBAR_DEFAULT * 0.7) {
        setSidebarCollapsed(true);
      }
    } else {
      const newWidth = Math.max(DETAILS_MIN, Math.min(DETAILS_MAX, dragStartWidth.current - delta));
      setDetailsWidth(newWidth);
    }
  }, [dragging]);

  const handleDragEnd = useCallback(() => {
    setDragging(null);
  }, []);

  // Toggle sidebar
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev);
  }, []);

  const effectiveSidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED : sidebarWidth;
  const effectiveDetailsWidth = detailsOpen ? DETAILS_DEFAULT : 0;

  return (
    <div
      ref={frameRef}
      className={styles.frame}
      style={{
        gridTemplateColumns: `${effectiveSidebarWidth}px minmax(0, 1fr) ${effectiveDetailsWidth}px`,
      }}
      onPointerMove={handleDragMove}
      onPointerUp={handleDragEnd}
    >
      {/* Left Sidebar */}
      <div className={`${styles.sidebar} ${sidebarCollapsed ? styles.collapsed : ''}`}>
        {sidebar}
      </div>

      {/* Sidebar Drag Handle */}
      {!sidebarCollapsed && (
        <div
          className={styles.dragHandle}
          style={{ left: effectiveSidebarWidth }}
          onPointerDown={(e) => handleDragStart('sidebar', e)}
        />
      )}

      {/* Center Content */}
      <main className={styles.center}>
        {children}
      </main>

      {/* Details Drag Handle */}
      {detailsOpen && details && (
        <div
          className={styles.dragHandle}
          style={{ left: `calc(100% - ${effectiveDetailsWidth}px)` }}
          onPointerDown={(e) => handleDragStart('details', e)}
        />
      )}

      {/* Right Details Panel */}
      {detailsOpen && details && (
        <div className={styles.details}>
          {details}
        </div>
      )}

      {/* Drag overlay */}
      {dragging && <div className={styles.dragOverlay} />}
    </div>
  );
}
