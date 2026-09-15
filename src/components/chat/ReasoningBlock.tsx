/**
 * ReasoningBlock — Chain-of-thought display
 * Collapsible reasoning with streaming text support
 * Phase indicators for multi-step reasoning
 */

import React, { useState, useCallback } from 'react';
import { Icon } from '../ui/Icon';
import { useI18n } from '../../store';
import styles from './ChatPage.module.css';

export interface ReasoningPhase {
  id: string;
  label: string;
  content: string;
  status: 'pending' | 'active' | 'complete';
}

interface ReasoningBlockProps {
  content?: string;
  phases?: ReasoningPhase[];
  isStreaming?: boolean;
  defaultExpanded?: boolean;
}

export function ReasoningBlock({
  content,
  phases,
  isStreaming = false,
  defaultExpanded = false,
}: ReasoningBlockProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(defaultExpanded);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <div className={styles.reasoningBlock}>
      {/* Header */}
      <button
        className={styles.reasoningHeader}
        onClick={handleToggle}
        aria-expanded={expanded}
      >
        <span className={`${styles.reasoningChevron} ${expanded ? styles.reasoningChevronOpen : ''}`}>
          <Icon name="chevron-right" size={14} />
        </span>
        <Icon name="brain" size={14} className={styles.reasoningIcon} />
        <span className={styles.reasoningLabel}>
          {isStreaming ? t('chat.thinking') : t('chat.reasoning')}
        </span>
        <span style={{ fontSize: 11, color: 'var(--oa-alias-text-caption)', fontFamily: 'var(--oa-font-family-code)', marginLeft: 'auto', marginRight: 8 }}>
          DeepSeek-R1
        </span>
        {isStreaming && <span className={styles.reasoningSpinner} />}
      </button>

      {/* Content */}
      {expanded && (
        <div className={styles.reasoningContent}>
          {phases && phases.length > 0 ? (
            <div className={styles.reasoningPhases}>
              {phases.map((phase, index) => (
                <div
                  key={phase.id}
                  className={`${styles.reasoningPhase} ${
                    styles[`reasoningPhase${phase.status}`]
                  }`}
                >
                  <div className={styles.reasoningPhaseIndicator}>
                    <div
                      className={`${styles.reasoningPhaseDot} ${
                        phase.status === 'active'
                          ? styles.reasoningPhaseDotActive
                          : phase.status === 'complete'
                          ? styles.reasoningPhaseDotComplete
                          : ''
                      }`}
                    />
                    {index < phases.length - 1 && (
                      <div className={styles.reasoningPhaseLine} />
                    )}
                  </div>
                  <div className={styles.reasoningPhaseContent}>
                    <div className={styles.reasoningPhaseLabel}>{phase.label}</div>
                    {phase.content && (
                      <div className={styles.reasoningPhaseText}>{phase.content}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.reasoningText}>
              {content}
              {isStreaming && <span className={styles.cursor}>|</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ReasoningBlock;
