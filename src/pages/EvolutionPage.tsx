import React, { useState } from 'react';
import { Icon } from '../components/ui/Icon';
import { Button } from '../components/ui/button';
import { useI18n } from '../store';
import styles from './EvolutionPage.module.css';

interface EvolutionProposal {
  id: string;
  title: string;
  source: string;
  reason: string;
  fileName: string;
  diffBefore: string;
  diffAfter: string;
  impact: string;
  status: 'pending' | 'accepted' | 'rejected';
  date: string;
}

const LOCAL_STORAGE_EVO_KEY = 'ovolve_agent_evolution_proposals';

function loadProposals(): EvolutionProposal[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_EVO_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveProposals(proposals: EvolutionProposal[]) {
  try {
    localStorage.setItem(LOCAL_STORAGE_EVO_KEY, JSON.stringify(proposals));
  } catch {
    // Ignore
  }
}

export function EvolutionPage({ onBackToChat }: { onBackToChat?: () => void }) {
  const { locale } = useI18n();
  const [proposals, setProposals] = useState<EvolutionProposal[]>(loadProposals);
  const [filter, setFilter] = useState<'all' | 'pending' | 'accepted' | 'rejected'>('all');

  const handleAction = (id: string, action: 'accepted' | 'rejected') => {
    const updated = proposals.map((p) => (p.id === id ? { ...p, status: action } : p));
    setProposals(updated);
    saveProposals(updated);
  };

  const filteredProposals = proposals.filter((p) => {
    if (filter === 'all') return true;
    return p.status === filter;
  });

  const pendingCount = proposals.filter((p) => p.status === 'pending').length;
  const acceptedCount = proposals.filter((p) => p.status === 'accepted').length;

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <Icon name="evolution" size={18} />
          </div>
          <div>
            <h1 className={styles.title}>{locale === 'zh' ? '系统进化与自愈规则' : 'Self-Evolution & Heuristics'}</h1>
            <p className={styles.subtitle}>
              {locale === 'zh' ? '从异常修复与代码重构中提炼的启发式规则库' : 'Autonomous heuristics distilled from error recovery & refactoring'}
            </p>
          </div>
        </div>
        <div className={styles.headerActions}>
          {onBackToChat && (
            <Button variant="secondary" size="sm" onClick={onBackToChat} icon={<Icon name="chat" size={14} />}>
              {locale === 'zh' ? '返回会话' : 'Back to Chat'}
            </Button>
          )}
        </div>
      </div>

      {/* Clean Status Summary Strip */}
      <div className={styles.summaryStrip}>
        <div className={styles.summaryItem}>
          <span>{locale === 'zh' ? '待审阅提案' : 'Pending Proposals'}:</span>
          <span className={styles.summaryNum}>{pendingCount}</span>
        </div>
        <div className={styles.summaryDivider} />
        <div className={styles.summaryItem}>
          <span>{locale === 'zh' ? '已生效启发规则' : 'Active Heuristics'}:</span>
          <span className={styles.summaryNum}>{18 + acceptedCount}</span>
        </div>
        <div className={styles.summaryDivider} />
        <div className={styles.summaryItem}>
          <span>{locale === 'zh' ? '反思触发' : 'Status'}:</span>
          <span className={styles.summaryNum}>{proposals.length > 0 ? '活跃' : (locale === 'zh' ? '就绪' : 'Idle')}</span>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className={styles.filterBar}>
        <button
          className={`${styles.filterBtn} ${filter === 'all' ? styles.filterBtnActive : ''}`}
          onClick={() => setFilter('all')}
        >
          {locale === 'zh' ? '全部' : 'All'} ({proposals.length})
        </button>
        <button
          className={`${styles.filterBtn} ${filter === 'pending' ? styles.filterBtnActive : ''}`}
          onClick={() => setFilter('pending')}
        >
          {locale === 'zh' ? '待审阅' : 'Pending'} ({pendingCount})
        </button>
        <button
          className={`${styles.filterBtn} ${filter === 'accepted' ? styles.filterBtnActive : ''}`}
          onClick={() => setFilter('accepted')}
        >
          {locale === 'zh' ? '已采纳' : 'Accepted'} ({acceptedCount})
        </button>
        <button
          className={`${styles.filterBtn} ${filter === 'rejected' ? styles.filterBtnActive : ''}`}
          onClick={() => setFilter('rejected')}
        >
          {locale === 'zh' ? '已忽略' : 'Rejected'} ({proposals.filter((p) => p.status === 'rejected').length})
        </button>
      </div>

      {/* Proposals List / Empty State */}
      <div className={styles.proposalsList}>
        {filteredProposals.length === 0 ? (
          <div className={styles.emptyState}>
            <Icon name="evolution" size={32} style={{ color: 'var(--oa-alias-text-dimmed)', marginBottom: 8 }} />
            <p style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--oa-alias-text-primary)', fontWeight: 500 }}>
              {locale === 'zh' ? '暂无待审阅的进化与自愈提案' : 'No evolution proposals recorded yet'}
            </p>
            <p style={{ margin: 0, fontSize: 11.5, color: 'var(--oa-alias-text-secondary)' }}>
              {locale === 'zh'
                ? '智能体在会话执行、异常拦截与多轮重构反思后，将在此自动提炼启发式规则'
                : 'Proposals will appear here when the agent distills heuristic rules from session reflection and error recovery'}
            </p>
          </div>
        ) : (
          filteredProposals.map((proposal) => {
            const isPending = proposal.status === 'pending';
            const isAccepted = proposal.status === 'accepted';

            return (
              <div key={proposal.id} className={styles.proposalCard}>
                {/* Header */}
                <div className={styles.cardHeader}>
                  <h3 className={styles.cardTitle}>{proposal.title}</h3>
                  <span
                    className={`${styles.statusPill} ${
                      isAccepted
                        ? styles.statusAccepted
                        : isPending
                        ? styles.statusPending
                        : styles.statusRejected
                    }`}
                  >
                    {isAccepted
                      ? locale === 'zh' ? '已采纳' : 'Accepted'
                      : isPending
                      ? locale === 'zh' ? '待审阅' : 'Pending'
                      : locale === 'zh' ? '已忽略' : 'Rejected'}
                  </span>
                </div>

                <div className={styles.cardMeta}>
                  {proposal.source} · {proposal.date}
                </div>

                <p className={styles.cardReason}>{proposal.reason}</p>

                {/* Diff Box */}
                <div className={styles.diffBox}>
                  <div className={styles.diffFileHeader}>
                    <Icon name="code" size={12} />
                    <span>{proposal.fileName}</span>
                  </div>
                  <div className={`${styles.diffLine} ${styles.diffLineRemoved}`}>
                    <span className={styles.diffSign}>-</span>
                    <span>{proposal.diffBefore}</span>
                  </div>
                  <div className={`${styles.diffLine} ${styles.diffLineAdded}`}>
                    <span className={styles.diffSign}>+</span>
                    <span>{proposal.diffAfter}</span>
                  </div>
                </div>

                {/* Footer */}
                <div className={styles.cardFooter}>
                  <span className={styles.impactText}>
                    {locale === 'zh' ? '预期收益：' : 'Impact: '}{proposal.impact}
                  </span>

                  {isPending && (
                    <div className={styles.btnGroup}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleAction(proposal.id, 'rejected')}
                      >
                        {locale === 'zh' ? '忽略' : 'Reject'}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<Icon name="check" size={13} />}
                        onClick={() => handleAction(proposal.id, 'accepted')}
                      >
                        {locale === 'zh' ? '采纳' : 'Accept'}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default EvolutionPage;
