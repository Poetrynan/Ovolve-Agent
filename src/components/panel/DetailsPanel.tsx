/**
 * DetailsPanel — Right panel container with Silky Smooth Segmented Control
 * Tab navigation (Context, Files, Git, Memory)
 * Dynamic gliding indicator pill with physics-inspired easing
 */

import React, { useState, useEffect, useRef } from 'react';
import { Icon, IconName } from '../ui/Icon';
import { ContextTab } from './ContextTab';
import { FilesTab } from './FilesTab';
import { GitTab } from './GitTab';
import { MemoryTab } from './MemoryTab';
import { useI18n } from '../../store';
import styles from './DetailsPanel.module.css';

export type PanelTab = 'context' | 'files' | 'git' | 'memory';

interface TabDef {
  id: PanelTab;
  labelKey: 'panel.tab.context' | 'panel.tab.files' | 'panel.tab.git' | 'panel.tab.memory';
  icon: IconName;
}

const TABS: TabDef[] = [
  { id: 'context', labelKey: 'panel.tab.context', icon: 'context' },
  { id: 'files', labelKey: 'panel.tab.files', icon: 'file' },
  { id: 'git', labelKey: 'panel.tab.git', icon: 'git-branch' },
  { id: 'memory', labelKey: 'panel.tab.memory', icon: 'memory' },
];

interface DetailsPanelProps {
  activeTab?: PanelTab;
  onTabChange?: (tab: PanelTab) => void;
  onClose?: () => void;
}

export function DetailsPanel({
  activeTab = 'context',
  onTabChange,
  onClose,
}: DetailsPanelProps) {
  const { t, locale } = useI18n();
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number }>({
    left: 3,
    width: 0,
  });
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Recalculate gliding indicator on tab change or window resize or locale change
  useEffect(() => {
    const updateIndicator = () => {
      const activeEl = tabRefs.current[activeTab];
      if (activeEl) {
        setIndicatorStyle({
          left: activeEl.offsetLeft,
          width: activeEl.offsetWidth,
        });
      }
    };

    updateIndicator();
    // A micro-tick ensures DOM bounding box is settled
    const timer = setTimeout(updateIndicator, 50);
    window.addEventListener('resize', updateIndicator);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', updateIndicator);
    };
  }, [activeTab, t, locale]);

  return (
    <div className={styles.panel}>
      {/* Top Header with Segmented Control and Close Button */}
      <div className={styles.header}>
        <div className={styles.segmentedControl} role="tablist">
          {/* Gliding Active Pill */}
          {indicatorStyle.width > 0 && (
            <div
              className={styles.indicator}
              style={{
                transform: `translateX(${indicatorStyle.left}px)`,
                width: `${indicatorStyle.width}px`,
              }}
            />
          )}

          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[tab.id] = el;
                }}
                className={`${styles.segmentBtn} ${isActive ? styles.segmentBtnActive : ''}`}
                onClick={() => onTabChange?.(tab.id)}
                role="tab"
                aria-selected={isActive}
              >
                <Icon name={tab.icon} size={13} />
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className={styles.tabContent}>
        {activeTab === 'context' && <ContextTab />}
        {activeTab === 'files' && <FilesTab />}
        {activeTab === 'git' && <GitTab />}
        {activeTab === 'memory' && <MemoryTab />}
      </div>
    </div>
  );
}

export default DetailsPanel;
