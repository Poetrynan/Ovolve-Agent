/**
 * NavLinks — Navigation links for the sidebar
 * Goals, Settings, Capabilities, Evolution, Usage
 * Active state styling with badge counts
 */

import React from 'react';
import { Icon, IconName } from '../ui/Icon';
import styles from './Sidebar.module.css';

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  badge?: number;
  active?: boolean;
  onClick?: () => void;
}

interface NavLinksProps {
  items?: NavItem[];
  activeId?: string;
  onItemClick?: (id: string) => void;
}

const DEFAULT_ITEMS: NavItem[] = [
  { id: 'goals', label: 'Goals', icon: 'target' },
  { id: 'capabilities', label: 'Capabilities', icon: 'capabilities' },
  { id: 'evolution', label: 'Evolution', icon: 'evolution' },
  { id: 'usage', label: 'Usage', icon: 'usage' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function NavLinks({ items = DEFAULT_ITEMS, activeId, onItemClick }: NavLinksProps) {
  return (
    <nav className={styles.nav} aria-label="Main navigation">
      {items.map((item) => (
        <button
          key={item.id}
          className={`${styles.navItem} ${item.id === activeId ? styles.navItemActive : ''}`}
          onClick={() => {
            onItemClick?.(item.id);
            item.onClick?.();
          }}
          aria-current={item.id === activeId ? 'page' : undefined}
        >
          <span className={styles.navIcon}>
            <Icon name={item.icon} size={17} />
          </span>
          <span className={styles.navLabel}>{item.label}</span>
          {item.badge !== undefined && item.badge > 0 && (
            <span className={styles.navBadge}>{item.badge}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

export default NavLinks;
