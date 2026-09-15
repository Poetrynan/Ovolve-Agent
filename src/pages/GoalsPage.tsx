import React, { useState, useEffect, useMemo } from 'react';
import { Icon } from '../components/ui/Icon';
import { Button } from '../components/ui/button';
// 流水线阶段条：消费后端 goal_state_change 的 stage 字段。
import { GoalPipelineProgress } from '../components/goals/GoalPipelineProgress';
// 接管横幅（U5）：goal_state_change 的 handoff_required 信号 → 琥珀警示条。
import { GoalHandoffBanner } from '../components/goals/GoalHandoffBanner';
import { useGoalStore, connectGoalEvents } from '../store/goalStore';
import { useI18n } from '../store';
import styles from './Pages.module.css';

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

interface Goal {
  id: string;
  title: string;
  description: string;
  progress: number;
  status: 'active' | 'completed' | 'paused';
  subtasks: Subtask[];
  updatedAt: string;
}

/** 本地 Goal（localStorage 形态）→ 后端 wire Goal 的诚实映射：
 * 缺失的运行时字段一律填"未知"语义（0/null/false），绝不虚构预算或成本。 */
function toWireGoal(g: Goal): import('../types/goal').Goal {
  return {
    id: g.id,
    description: g.description,
    status: g.status,
    iteration: 0,
    maxIterations: 0,
    maxIterationsKnown: false,
    subtasksCompleted: g.subtasks.filter((s) => s.done).length,
    subtasksTotal: g.subtasks.length,
    progressRatio: null,
    plan: g.subtasks.map((s) => ({ id: s.id, title: s.title, status: s.done ? 'completed' : 'pending' })),
    costUsd: 0,
    costCapUsd: 0,
    tokensUsed: 0,
    lastError: '',
    verification: null,
    handoffRequired: false,
    handoffDetail: '',
    deliveryHints: null,
    updatedAt: Date.now(),
    sessionId: '',
    createdAt: 0,
    startedAt: 0,
  };
}

const LOCAL_STORAGE_GOALS_KEY = 'ovolve_agent_goals';

function loadGoals(): Goal[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_GOALS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveGoals(goals: Goal[]) {
  try {
    localStorage.setItem(LOCAL_STORAGE_GOALS_KEY, JSON.stringify(goals));
  } catch {
    // Ignore
  }
}

export function GoalsPage({ onBackToChat }: { onBackToChat?: () => void }) {
  const { locale } = useI18n();
  const [goals, setGoals] = useState<Goal[]>(loadGoals);
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  // U5 接管横幅：后端 goal_state_change 的 handoff_required 信号经 goalStore
  // 落地；store 拉取失败（无后端 / 离线）静默——横幅缺席即"无接管信号"，
  // 绝不因后端不可达打扰本地目标卡。selector 只取稳定引用（zustand v5 下
  // selector 内 filter 每次产出新数组会让 getSnapshot 失去缓存）。
  const storeGoals = useGoalStore((s) => s.goals);
  const handoffGoals = useMemo(
    () => storeGoals.filter((g) => g.handoffRequired === true),
    [storeGoals],
  );

  useEffect(() => {
    connectGoalEvents();
    void useGoalStore.getState().fetchGoals();
  }, []);

  const filteredGoals = goals.filter((g) => {
    if (filter === 'all') return true;
    return g.status === filter;
  });

  const handleCreateGoal = () => {
    if (!newTitle.trim()) return;
    const newGoal: Goal = {
      id: `g-${Date.now()}`,
      title: newTitle.trim(),
      description: newDesc.trim() || (locale === 'zh' ? '自主执行目标' : 'Autonomous execution goal'),
      progress: 0,
      status: 'active',
      subtasks: [],
      updatedAt: locale === 'zh' ? '刚刚' : 'Just now',
    };
    const updated = [newGoal, ...goals];
    setGoals(updated);
    saveGoals(updated);
    setNewTitle('');
    setNewDesc('');
    setShowCreateModal(false);
  };

  const handleToggleSubtask = (goalId: string, subtaskId: string) => {
    const updated = goals.map((g) => {
      if (g.id !== goalId) return g;
      const subtasks = g.subtasks.map((st) => (st.id === subtaskId ? { ...st, done: !st.done } : st));
      const doneCount = subtasks.filter((st) => st.done).length;
      const progress = subtasks.length > 0 ? Math.round((doneCount / subtasks.length) * 100) : 0;
      const status: Goal['status'] = progress === 100 ? 'completed' : 'active';
      return { ...g, subtasks, progress, status };
    });
    setGoals(updated);
    saveGoals(updated);
  };

  const handleDeleteGoal = (goalId: string) => {
    const updated = goals.filter((g) => g.id !== goalId);
    setGoals(updated);
    saveGoals(updated);
  };

  return (
    <div className={styles.pageContainer}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <Icon name="target" size={20} />
          </div>
          <div>
            <h1 className={styles.pageTitle}>{locale === 'zh' ? '目标规划与自主执行' : 'Goals & Autonomy'}</h1>
            <p className={styles.pageSubtitle}>
              {locale === 'zh' ? '管理长周期自主任务目标、里程碑进度与拆解步骤' : 'Manage long-running autonomous goals, milestones & progress'}
            </p>
          </div>
        </div>
        <div className={styles.headerActions}>
          {onBackToChat && (
            <Button variant="secondary" size="sm" onClick={onBackToChat} icon={<Icon name="chat" size={14} />}>
              {locale === 'zh' ? '返回会话' : 'Back to Chat'}
            </Button>
          )}
          <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setShowCreateModal(true)}>
            {locale === 'zh' ? '创建目标' : 'Create Goal'}
          </Button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className={styles.subTabBar}>
        <button
          className={`${styles.subTabBtn} ${filter === 'all' ? styles.subTabBtnActive : ''}`}
          onClick={() => setFilter('all')}
        >
          {locale === 'zh' ? '全部目标' : 'All Goals'} ({goals.length})
        </button>
        <button
          className={`${styles.subTabBtn} ${filter === 'active' ? styles.subTabBtnActive : ''}`}
          onClick={() => setFilter('active')}
        >
          {locale === 'zh' ? '执行中' : 'In Progress'} ({goals.filter((g) => g.status === 'active').length})
        </button>
        <button
          className={`${styles.subTabBtn} ${filter === 'completed' ? styles.subTabBtnActive : ''}`}
          onClick={() => setFilter('completed')}
        >
          {locale === 'zh' ? '已完成' : 'Completed'} ({goals.filter((g) => g.status === 'completed').length})
        </button>
      </div>

      {/* U5 接管横幅：需要人接管的目标逐条警示（无信号时不渲染任何节点） */}
      {handoffGoals.map((g) => (
        <GoalHandoffBanner key={g.id} goal={g} onJump={onBackToChat} />
      ))}

      {/* Goal Cards / Empty State */}
      {filteredGoals.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 16px', color: 'var(--oa-alias-text-caption)' }}>
          <Icon name="target" size={36} style={{ color: 'var(--oa-alias-text-dimmed)', marginBottom: 10 }} />
          <p style={{ fontSize: 13, margin: '0 0 16px' }}>{locale === 'zh' ? '当前暂无目标规划' : 'No active goals recorded'}</p>
          <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setShowCreateModal(true)}>
            {locale === 'zh' ? '创建首个目标规划' : 'Create First Goal'}
          </Button>
        </div>
      ) : (
        <div className={styles.cardGrid}>
          {filteredGoals.map((goal) => (
            <div key={goal.id} className={styles.card}>
              <div className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>{goal.title}</h3>
                <span
                  className={`${styles.cardBadge} ${
                    goal.status === 'completed'
                      ? styles.badgeSuccess
                      : goal.status === 'active'
                      ? styles.badgePrimary
                      : styles.badgeWarning
                  }`}
                >
                  {goal.status === 'completed'
                    ? locale === 'zh' ? '已完成' : 'Completed'
                    : locale === 'zh' ? '执行中' : 'Active'}
                </span>
              </div>

              <p className={styles.cardDescription}>{goal.description}</p>

              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--oa-alias-text-secondary)', marginBottom: 4 }}>
                  <span>{locale === 'zh' ? '达成进度' : 'Progress'}</span>
                  <span style={{ fontWeight: 600, color: 'var(--oa-alias-text-primary)' }}>{goal.progress}%</span>
                </div>
                <div className={styles.progressBar}>
                  <div className={styles.progressFill} style={{ width: `${goal.progress}%` }} />
                </div>
              </div>

              {/* Pipeline stages (plan/execute/verify) — stage 字段由后端 WS 事件驱动 */}
              <GoalPipelineProgress goal={toWireGoal(goal)} />

              {/* Subtasks */}
              {goal.subtasks.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '8px 0 16px' }}>
                  {goal.subtasks.map((st) => (
                    <div
                      key={st.id}
                      onClick={() => handleToggleSubtask(goal.id, st.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}
                    >
                      <Icon
                        name={st.done ? 'check' : 'dot'}
                        size={13}
                        style={{ color: st.done ? 'var(--oa-alias-success)' : 'var(--oa-alias-text-caption)', flexShrink: 0 }}
                      />
                      <span
                        style={{
                          color: st.done ? 'var(--oa-alias-text-secondary)' : 'var(--oa-alias-text-primary)',
                          textDecoration: st.done ? 'line-through' : 'none',
                        }}
                      >
                        {st.title}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.cardFooter}>
                <span>{locale === 'zh' ? '更新于' : 'Updated'} {goal.updatedAt}</span>
                <button
                  onClick={() => handleDeleteGoal(goal.id)}
                  title={locale === 'zh' ? '删除目标' : 'Delete goal'}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--oa-alias-text-caption)',
                    cursor: 'pointer',
                    fontSize: 11,
                  }}
                >
                  {locale === 'zh' ? '删除' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Simple Creation Modal */}
      {showCreateModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0, 0, 0, 0.45)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
        }}>
          <div style={{
            width: 420,
            background: 'var(--oa-alias-bg-base)',
            border: '1px solid var(--oa-alias-border-l2)',
            borderRadius: 16,
            padding: 24,
            boxShadow: 'var(--oa-shadow-floating)',
          }}>
            <h2 style={{ fontSize: 16, margin: '0 0 12px', color: 'var(--oa-alias-text-primary)' }}>
              {locale === 'zh' ? '创建新的自主规划目标' : 'Create Autonomous Goal'}
            </h2>
            <input
              type="text"
              placeholder={locale === 'zh' ? '目标标题 (例: 重构编译器解析流程)' : 'Goal title...'}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--oa-alias-border-l2)',
                background: 'var(--oa-alias-bg-layer-1)',
                color: 'var(--oa-alias-text-primary)',
                fontSize: 13,
                marginBottom: 12,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <textarea
              placeholder={locale === 'zh' ? '目标描述与预期产物...' : 'Goal description...'}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              rows={3}
              style={{
                width: '100%',
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--oa-alias-border-l2)',
                background: 'var(--oa-alias-bg-layer-1)',
                color: 'var(--oa-alias-text-primary)',
                fontSize: 13,
                marginBottom: 16,
                outline: 'none',
                boxSizing: 'border-box',
                resize: 'none',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Button variant="secondary" size="sm" onClick={() => setShowCreateModal(false)}>
                {locale === 'zh' ? '取消' : 'Cancel'}
              </Button>
              <Button variant="primary" size="sm" onClick={handleCreateGoal} disabled={!newTitle.trim()}>
                {locale === 'zh' ? '确认创建' : 'Create'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default GoalsPage;
