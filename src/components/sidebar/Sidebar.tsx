/**
 * Sidebar — Main sidebar container (left panel)
 * 
 * Contains:
 * - New chat button
 * - Search filter
 * - Session list grouped by workspace
 * - Navigation links (Goals, Settings, Capabilities, Evolution, Usage)
 * - Evolution proposal badge
 * - Collapsible workspace folders
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/button';
import { Input } from '../ui/Input';
import { NavLinks, NavItem } from './NavLinks';
import { SessionList, WorkspaceGroup } from './SessionList';
import { useI18n, useThemeStore } from '../../store';
import styles from './Sidebar.module.css';

export interface SidebarProps {
  workspaces: WorkspaceGroup[];
  activeSessionId?: string;
  activeNavId?: string;
  navItems?: NavItem[];
  evolutionBadge?: number;
  collapsed?: boolean;
  onNewChat?: () => void;
  onSessionSelect?: (id: string) => void;
  onSessionPin?: (id: string) => void;
  onSessionRename?: (id: string) => void;
  onSessionDelete?: (id: string) => void;
  onSessionFork?: (id: string) => void;
  onNavClick?: (id: string) => void;
}

export function Sidebar({
  workspaces,
  activeSessionId,
  activeNavId,
  navItems,
  evolutionBadge,
  collapsed = false,
  onNewChat,
  onSessionSelect,
  onSessionPin,
  onSessionRename,
  onSessionDelete,
  onSessionFork,
  onNavClick,
}: SidebarProps) {
  const { locale, setLocale, t } = useI18n();
  const { mode, isDark, setMode } = useThemeStore();
  const [searchQuery, setSearchQuery] = useState('');

  // Filter sessions by search query
  const filteredWorkspaces = useMemo(() => {
    if (!searchQuery.trim()) return workspaces;
    const query = searchQuery.toLowerCase();
    return workspaces
      .map((ws) => ({
        ...ws,
        sessions: ws.sessions.filter((s) =>
          s.title.toLowerCase().includes(query)
        ),
      }))
      .filter((ws) => ws.sessions.length > 0);
  }, [workspaces, searchQuery]);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
    },
    []
  );

  const toggleTheme = useCallback(() => {
    if (mode === 'light') setMode('dark');
    else if (mode === 'dark') setMode('system');
    else setMode('light');
  }, [mode, setMode]);

  const toggleLanguage = useCallback(() => {
    setLocale(locale === 'zh' ? 'en' : 'zh');
  }, [locale, setLocale]);

  if (collapsed) {
    return (
      <div className={`${styles.sidebar} ${styles.sidebarCollapsed}`}>
        <div className={styles.collapsedActions}>
          <button className={styles.collapsedBtn} onClick={onNewChat} title={t('sidebar.newChat')}>
            <Icon name="plus" size={18} />
          </button>
          <button className={styles.collapsedBtn} title={t('common.search')}>
            <Icon name="search" size={18} />
          </button>
          <button
            className={styles.collapsedBtn}
            onClick={toggleTheme}
            title={mode === 'light' ? t('settings.theme.light') : mode === 'dark' ? t('settings.theme.dark') : t('settings.theme.system')}
          >
            <Icon name={mode === 'light' ? 'sun' : mode === 'dark' ? 'moon' : 'monitor'} size={18} />
          </button>
          <button
            className={styles.collapsedBtn}
            onClick={toggleLanguage}
            title={t('settings.language')}
          >
            <Icon name="globe" size={18} />
          </button>
        </div>
        <div className={styles.collapsedDots}>
          {workspaces.flatMap((ws) => ws.sessions).slice(0, 8).map((s) => (
            <div
              key={s.id}
              className={`${styles.collapsedDot} ${s.id === activeSessionId ? styles.collapsedDotActive : ''}`}
              title={s.title}
              onClick={() => onSessionSelect?.(s.id)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.sidebar}>
      {/* Header */}
      <div className={styles.header}>
        <Button
          variant="primary"
          size="md"
          icon={<Icon name="plus" size={16} />}
          fullWidth
          onClick={onNewChat}
        >
          {t('sidebar.newChat')}
        </Button>
      </div>

      {/* Search */}
      <div className={styles.search}>
        <Input
          placeholder={t('sidebar.searchPlaceholder')}
          value={searchQuery}
          onChange={handleSearchChange}
          icon={<Icon name="search" size={14} />}
          fullWidth
        />
      </div>

      {/* Navigation */}
      <NavLinks
        items={navItems?.map((item) =>
          item.id === 'evolution' && evolutionBadge
            ? { ...item, badge: evolutionBadge }
            : item
        )}
        activeId={activeNavId}
        onItemClick={onNavClick}
      />

      {/* Session List */}
      <div className={styles.sessions}>
        <SessionList
          workspaces={filteredWorkspaces}
          activeSessionId={activeSessionId}
          onSessionSelect={onSessionSelect}
          onSessionPin={onSessionPin}
          onSessionRename={onSessionRename}
          onSessionDelete={onSessionDelete}
          onSessionFork={onSessionFork}
        />
      </div>

      {/* Footer with Theme & Language Switches */}
      <div className={styles.footer}>
        <div className={styles.footerBrand}>
          <img src="/favicon-32x32.png" alt="logo" style={{ width: 18, height: 18, borderRadius: 5 }} />
          <span className={styles.brandTitle}>OvolveAgent</span>
          <span className={styles.versionBadge}>v1.0</span>
        </div>
        
        <div className={styles.footerControls}>
          {/* Language toggle */}
          <button
            type="button"
            className={styles.footerIconBtn}
            onClick={toggleLanguage}
            title={locale === 'zh' ? '切换为 English' : 'Switch to 简体中文'}
            aria-label="Toggle language"
          >
            <span className={styles.langText}>{locale === 'zh' ? '中' : 'EN'}</span>
          </button>

          {/* Theme toggle */}
          <button
            type="button"
            className={styles.footerIconBtn}
            onClick={toggleTheme}
            title={mode === 'light' ? '切换为深色模式' : mode === 'dark' ? '跟随系统外观' : '切换为浅色模式'}
            aria-label="Toggle theme"
          >
            <Icon name={mode === 'light' ? 'sun' : mode === 'dark' ? 'moon' : 'monitor'} size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default Sidebar;

