/**
 * SessionItem — Single session list item
 * Shows title, timestamp, message count, activity dot
 * Hover actions: pin, rename, delete
 * Pin indicator and fork relationship
 */

import React, { useState, useCallback } from 'react';
import { Icon } from '../ui/Icon';
import { StateDot, StateDotState } from '../ui/StateDot';
import { Menu, MenuItem } from '../ui/Menu';
import styles from './Sidebar.module.css';

export interface SessionItemData {
  id: string;
  title: string;
  timestamp: number;
  messageCount: number;
  state: StateDotState;
  pinned?: boolean;
  forkedFrom?: string;
  workspaceId: string;
}

interface SessionItemProps {
  session: SessionItemData;
  active?: boolean;
  onSelect?: (id: string) => void;
  onPin?: (id: string) => void;
  onRename?: (id: string) => void;
  onDelete?: (id: string) => void;
  onFork?: (id: string) => void;
}

function formatTimestamp(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function SessionItem({
  session,
  active = false,
  onSelect,
  onPin,
  onRename,
  onDelete,
  onFork,
}: SessionItemProps) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const menuItems: MenuItem[] = [
    {
      id: 'pin',
      label: session.pinned ? '取消置顶 (Unpin)' : '置顶会话 (Pin)',
      icon: <Icon name={session.pinned ? 'pin-filled' : 'pin'} size={14} />,
      shortcut: '⇧P',
      onClick: () => onPin?.(session.id),
    },
    {
      id: 'rename',
      label: '重命名 (Rename)',
      icon: <Icon name="edit" size={14} />,
      shortcut: 'F2',
      onClick: () => onRename?.(session.id),
    },
    {
      id: 'fork',
      label: '派生分支 (Fork)',
      icon: <Icon name="git-branch" size={14} />,
      onClick: () => onFork?.(session.id),
    },
    { id: 'div1', label: '', divider: true },
    {
      id: 'delete',
      label: '删除会话 (Delete)',
      icon: <Icon name="trash" size={14} />,
      danger: true,
      shortcut: '⌫',
      onClick: () => onDelete?.(session.id),
    },
  ];

  return (
    <div
      className={`${styles.sessionItem} ${active ? styles.sessionItemActive : ''}`}
      onClick={() => onSelect?.(session.id)}
      onAuxClick={(e) => {
        // 鼠标中键（auxclick button===1）直接关闭/删除会话——与桌面惯例一致。
        if (e.button === 1) {
          e.preventDefault()
          onDelete?.(session.id)
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
    >
      {/* Activity dot */}
      <StateDot state={session.state} size={7} />

      {/* Content */}
      <div className={styles.sessionContent}>
        <div className={styles.sessionTitleRow}>
          <span className={styles.sessionTitle} title={session.title}>
            {session.title}
          </span>
          {session.pinned && (
            <span className={styles.pinIndicator} title="Pinned">
              <Icon name="pin-filled" size={10} />
            </span>
          )}
        </div>
        <div className={styles.sessionMeta}>
          <span className={styles.sessionTime}>{formatTimestamp(session.timestamp)}</span>
          <span className={styles.sessionDot}>·</span>
          <span className={styles.sessionCount}>{session.messageCount} msgs</span>
          {session.forkedFrom && (
            <>
              <span className={styles.sessionDot}>·</span>
              <span className={styles.sessionFork}>forked</span>
            </>
          )}
        </div>
      </div>

      {/* Hover actions & persistent on menuOpen */}
      {(hovered || menuOpen) && (
        <div className={styles.sessionActions} onClick={(e) => e.stopPropagation()}>
          <button
            className={styles.sessionActionBtn}
            onClick={(e) => {
              e.stopPropagation();
              onPin?.(session.id);
            }}
            title={session.pinned ? 'Unpin' : 'Pin'}
          >
            <Icon name={session.pinned ? 'pin-filled' : 'pin'} size={14} />
          </button>
          <Menu items={menuItems} side="bottom" align="end" onOpenChange={setMenuOpen}>
            <button
              className={styles.sessionActionBtn}
              title="More actions"
              aria-label="More actions"
            >
              <Icon name="more" size={14} />
            </button>
          </Menu>
        </div>
      )}
    </div>
  );
}

export default SessionItem;
