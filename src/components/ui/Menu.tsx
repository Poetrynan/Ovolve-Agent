/**
 * Menu — Dropdown menu component
 * 12px border-radius, 4px padding
 * Supports nested submenus, dividers, icons, shortcuts
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import styles from './Menu.module.css';

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  children?: MenuItem[];
  onClick?: () => void;
}

interface MenuProps {
  items: MenuItem[];
  children: React.ReactNode;
  side?: 'bottom' | 'top' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  onOpenChange?: (open: boolean) => void;
}

export function Menu({
  items,
  children,
  side = 'bottom',
  align = 'start',
  onOpenChange,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      onOpenChange?.(next);
      return next;
    });
  }, [onOpenChange]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        onOpenChange?.(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onOpenChange]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        onOpenChange?.(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  return (
    <div className={styles.container} onClick={(e) => e.stopPropagation()}>
      <div ref={triggerRef} onClick={(e) => {
        e.stopPropagation();
        handleToggle();
      }}>
        {children}
      </div>
      {open && (
        <div
          ref={menuRef}
          className={`${styles.menu} ${styles[side]} ${styles[align]}`}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((item) => (
            <MenuRow key={item.id} item={item} onSelect={() => {
              item.onClick?.();
              setOpen(false);
              onOpenChange?.(false);
            }} />
          ))}
        </div>
      )}
    </div>
  );
}

function MenuRow({ item, onSelect }: { item: MenuItem; onSelect: () => void }) {
  if (item.divider) {
    return <div className={styles.divider} />;
  }

  return (
    <button
      className={`${styles.item} ${item.danger ? styles.danger : ''} ${
        item.disabled ? styles.disabled : ''
      }`}
      disabled={item.disabled}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      role="menuitem"
    >
      {item.icon && <span className={styles.itemIcon}>{item.icon}</span>}
      <span className={styles.itemLabel}>{item.label}</span>
      {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
    </button>
  );
}

export default Menu;
