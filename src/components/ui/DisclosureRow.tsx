/**
 * DisclosureRow — Collapsible section header
 * Used for workspace folders, reasoning blocks, tool call cards
 */

import React, { useState, useCallback } from 'react';
import styles from './DisclosureRow.module.css';

interface DisclosureRowProps {
  children: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  icon?: React.ReactNode;
  label: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  level?: 1 | 2 | 3;
}

export function DisclosureRow({
  children,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  icon,
  label,
  badge,
  actions,
  level = 1,
}: DisclosureRowProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;

  const handleToggle = useCallback(() => {
    const next = !isOpen;
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  }, [isOpen, isControlled, onOpenChange]);

  return (
    <div className={`${styles.container} ${styles[`level${level}`]}`}>
      <button
        className={styles.header}
        onClick={handleToggle}
        aria-expanded={isOpen}
      >
        <span className={`${styles.chevron} ${isOpen ? styles.open : ''}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </span>
        {icon && <span className={styles.icon}>{icon}</span>}
        <span className={styles.label}>{label}</span>
        {badge && <span className={styles.badge}>{badge}</span>}
        {actions && <span className={styles.actions}>{actions}</span>}
      </button>
      {isOpen && <div className={styles.content}>{children}</div>}
    </div>
  );
}

export default DisclosureRow;
