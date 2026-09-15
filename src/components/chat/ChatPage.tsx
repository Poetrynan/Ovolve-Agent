/**
 * ChatPage — Main chat page (center panel)
 * Two-state layout: Hero (empty) → Conversation (with messages)
 * Message scroller, composer integration
 * Top bar with Right Panel (Context / Files / Git / Memory) Toggle
 */

import React from 'react';
import { Icon } from '../ui/Icon';
import { MessageList } from './MessageList';
import { MessageData } from './MessageBubble';
import { Composer } from './Composer';
import type { ThoughtLevel } from '../../types/agent';
import { useI18n } from '../../store';
import styles from './ChatPage.module.css';

interface ChatPageProps {
  messages: MessageData[];
  thoughtLevel?: ThoughtLevel;
  model?: string;
  tokenCount?: number;
  disabled?: boolean;
  detailsOpen?: boolean;
  onToggleDetails?: () => void;
  onSend?: (text: string) => void;
  onSteer?: (text: string) => void;
  onStop?: () => void;
  onResume?: () => void;
  onThoughtChange?: (level: ThoughtLevel) => void;
  onModelChange?: (model: string) => void;
  onCopy?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRegenerate?: (id: string) => void;
}

export function ChatPage({
  messages,
  thoughtLevel = 'high',
  model = 'DeepSeek-V3',
  tokenCount = 0,
  disabled = false,
  detailsOpen = true,
  onToggleDetails,
  onSend,
  onSteer,
  onStop,
  onResume,
  onThoughtChange,
  onModelChange,
  onCopy,
  onDelete,
  onRegenerate,
}: ChatPageProps) {
  const hasMessages = messages.length > 0;
  const { locale } = useI18n();

  return (
    <div className={styles.chatPage}>
      {/* Top action bar */}
      <div className={styles.topBar}>
        <div className={styles.topBarLeft}>
          <div
            className={styles.connectionIndicator}
            title={locale === 'zh' ? 'Ovolve Agent 核心引擎已就绪' : 'Ovolve Agent Engine Ready'}
          >
            <span className={styles.statusDot} />
            <span className={styles.statusLabel}>{locale === 'zh' ? '在线' : 'Ready'}</span>
          </div>
        </div>
        <div className={styles.topBarRight}>
          <button
            type="button"
            className={`${styles.panelToggleBtn} ${detailsOpen ? styles.panelToggleBtnActive : ''}`}
            onClick={onToggleDetails}
            title={detailsOpen ? (locale === 'zh' ? '收起右侧面板' : 'Collapse Right Panel') : (locale === 'zh' ? '展开右侧面板' : 'Expand Right Panel')}
            aria-label="Toggle right panel"
          >
            <Icon name={detailsOpen ? 'panel-right-close' : 'panel-right-open'} size={16} />
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div className={styles.chatContent}>
        {hasMessages ? (
          <MessageList
            messages={messages}
            onCopy={onCopy}
            onDelete={onDelete}
            onRegenerate={onRegenerate}
          />
        ) : (
          <HeroState onSend={onSend} />
        )}
      </div>

      {/* Composer */}
      {/* Composer 已改为自洽组件：自行从 store 取 dispatchPrompt /
          enqueuePrompt / stopGeneration，并在内部管理输入、附件与思考等级，
          不再接受受控 props。原先转发的一批回调对它而言本就是无效入参。 */}
      <Composer isHero={!hasMessages} />
    </div>
  );
}

/* ─── Hero State (empty conversation) ───────────────────── */
function HeroState({ onSend }: { onSend?: (text: string) => void }) {
  const { t } = useI18n();

  const suggestions = [
    { icon: 'code' as const, label: t('hero.prompt.code'), prompt: t('hero.prompt.codeDesc') },
    { icon: 'brain' as const, label: t('hero.prompt.reason'), prompt: t('hero.prompt.reasonDesc') },
    { icon: 'file' as const, label: t('hero.prompt.file'), prompt: t('hero.prompt.fileDesc') },
    { icon: 'search' as const, label: t('hero.prompt.search'), prompt: t('hero.prompt.searchDesc') },
  ];

  return (
    <div className={styles.hero}>
      <div className={styles.heroContent}>
        {/* Title & Subtitle in High-Contrast Frosted Card */}
        <div className={styles.heroTextCard}>
          <h1 className={styles.heroTitle}>{t('hero.title')}</h1>
          <p className={styles.heroSubtitle}>{t('hero.subtitle')}</p>
        </div>

        {/* Action cards */}
        <div className={styles.heroActions}>
          {suggestions.map((s, i) => (
            <button
              key={i}
              className={styles.heroCard}
              onClick={() => onSend?.(s.prompt)}
            >
              <div className={styles.heroCardIcon}>
                <Icon name={s.icon} size={20} />
              </div>
              <div className={styles.heroCardText}>
                <div className={styles.heroCardTitle}>{s.label}</div>
                <div className={styles.heroCardDesc}>{s.prompt}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ChatPage;
