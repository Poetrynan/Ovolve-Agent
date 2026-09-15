/**
 * WorkspaceTree — Workspace folder tree
 * Collapsible folders with session count badges
 * Pin/hide/rename actions
 */

import React, { useState, useCallback } from 'react';
import { Icon } from '../ui/Icon';
import { DisclosureRow } from '../ui/DisclosureRow';
import { Menu, MenuItem } from '../ui/Menu';
import styles from './Sidebar.module.css';

export interface WorkspaceNode {
  id: string;
  name: string;
  sessionCount: number;
  pinned?: boolean;
  hidden?: boolean;
  children?: WorkspaceNode[];
}

interface WorkspaceTreeProps {
  workspaces: WorkspaceNode[];
  activeWorkspaceId?: string;
  onWorkspaceSelect?: (id: string) => void;
  onWorkspacePin?: (id: string) => void;
  onWorkspaceRename?: (id: string) => void;
  onWorkspaceHide?: (id: string) => void;
  onWorkspaceDelete?: (id: string) => void;
}

export function WorkspaceTree({
  workspaces,
  activeWorkspaceId,
  onWorkspaceSelect,
  onWorkspacePin,
  onWorkspaceRename,
  onWorkspaceHide,
  onWorkspaceDelete,
}: WorkspaceTreeProps) {
  return (
    <div className={styles.workspaceTree}>
      {workspaces.map((ws) => (
        <WorkspaceNodeItem
          key={ws.id}
          node={ws}
          activeWorkspaceId={activeWorkspaceId}
          onSelect={onWorkspaceSelect}
          onPin={onWorkspacePin}
          onRename={onWorkspaceRename}
          onHide={onWorkspaceHide}
          onDelete={onWorkspaceDelete}
        />
      ))}
    </div>
  );
}

function WorkspaceNodeItem({
  node,
  activeWorkspaceId,
  onSelect,
  onPin,
  onRename,
  onHide,
  onDelete,
  level = 1,
}: {
  node: WorkspaceNode;
  activeWorkspaceId?: string;
  onSelect?: (id: string) => void;
  onPin?: (id: string) => void;
  onRename?: (id: string) => void;
  onHide?: (id: string) => void;
  onDelete?: (id: string) => void;
  level?: 1 | 2 | 3;
}) {
  const menuItems: MenuItem[] = [
    {
      id: 'pin',
      label: node.pinned ? 'Unpin workspace' : 'Pin workspace',
      icon: <Icon name={node.pinned ? 'pin-filled' : 'pin'} size={14} />,
      onClick: () => onPin?.(node.id),
    },
    {
      id: 'rename',
      label: 'Rename',
      icon: <Icon name="edit" size={14} />,
      onClick: () => onRename?.(node.id),
    },
    {
      id: 'hide',
      label: node.hidden ? 'Show workspace' : 'Hide workspace',
      icon: <Icon name="x" size={14} />,
      onClick: () => onHide?.(node.id),
    },
    { id: 'div1', label: '', divider: true },
    {
      id: 'delete',
      label: 'Delete workspace',
      icon: <Icon name="trash" size={14} />,
      danger: true,
      onClick: () => onDelete?.(node.id),
    },
  ];

  return (
    <DisclosureRow
      label={node.name}
      icon={<Icon name="folder" size={14} />}
      badge={node.sessionCount}
      level={level}
      defaultOpen={true}
      actions={
        <Menu items={menuItems}>
          <button
            className={styles.workspaceActionBtn}
            onClick={(e) => e.stopPropagation()}
            title="Workspace actions"
          >
            <Icon name="more" size={14} />
          </button>
        </Menu>
      }
    >
      {node.children?.map((child) => (
        <WorkspaceNodeItem
          key={child.id}
          node={child}
          activeWorkspaceId={activeWorkspaceId}
          onSelect={onSelect}
          onPin={onPin}
          onRename={onRename}
          onHide={onHide}
          onDelete={onDelete}
          level={Math.min(level + 1, 3) as 1 | 2 | 3}
        />
      ))}
    </DisclosureRow>
  );
}

export default WorkspaceTree;
