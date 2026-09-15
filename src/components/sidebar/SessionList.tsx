/**
 * SessionList — Session list grouped by workspace
 * Supports pin/rename/delete actions, activity indicators, fork relationships
 */

import React, { useCallback } from 'react';
import { SessionItem, SessionItemData } from './SessionItem';
import { DisclosureRow } from '../ui/DisclosureRow';
import { Icon } from '../ui/Icon';
import styles from './Sidebar.module.css';

export interface WorkspaceGroup {
  workspaceId: string;
  workspaceName: string;
  sessions: SessionItemData[];
}

interface SessionListProps {
  workspaces: WorkspaceGroup[];
  activeSessionId?: string;
  onSessionSelect?: (id: string) => void;
  onSessionPin?: (id: string) => void;
  onSessionRename?: (id: string) => void;
  onSessionDelete?: (id: string) => void;
  onSessionFork?: (id: string) => void;
}

export function SessionList({
  workspaces,
  activeSessionId,
  onSessionSelect,
  onSessionPin,
  onSessionRename,
  onSessionDelete,
  onSessionFork,
}: SessionListProps) {
  const handleSelect = useCallback(
    (id: string) => onSessionSelect?.(id),
    [onSessionSelect]
  );

  const handlePin = useCallback(
    (id: string) => onSessionPin?.(id),
    [onSessionPin]
  );

  const handleRename = useCallback(
    (id: string) => onSessionRename?.(id),
    [onSessionRename]
  );

  const handleDelete = useCallback(
    (id: string) => onSessionDelete?.(id),
    [onSessionDelete]
  );

  const handleFork = useCallback(
    (id: string) => onSessionFork?.(id),
    [onSessionFork]
  );

  if (workspaces.length === 0) {
    return (
      <div className={styles.emptySessions}>
        <Icon name="chat" size={24} />
        <p>No sessions yet</p>
        <span>Start a new conversation</span>
      </div>
    );
  }

  return (
    <div className={styles.sessionList}>
      {workspaces.map((workspace) => {
        // Sort: pinned first, then by timestamp
        const sortedSessions = [...workspace.sessions].sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return b.timestamp - a.timestamp;
        });

        return (
          <DisclosureRow
            key={workspace.workspaceId}
            label={workspace.workspaceName}
            icon={<Icon name="folder" size={14} />}
            badge={workspace.sessions.length}
            defaultOpen={true}
          >
            {sortedSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                active={session.id === activeSessionId}
                onSelect={handleSelect}
                onPin={handlePin}
                onRename={handleRename}
                onDelete={handleDelete}
                onFork={handleFork}
              />
            ))}
          </DisclosureRow>
        );
      })}
    </div>
  );
}

export default SessionList;
