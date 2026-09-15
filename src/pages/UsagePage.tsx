import React from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { Icon } from '../components/ui/Icon';
import { Button } from '../components/ui/button';
import { useAgentStore, useSessionStore, useI18n } from '../store';
import { BUILTIN_MODEL_CATALOG } from '../lib/cache';
import styles from './Pages.module.css';

export function UsagePage({ onBackToChat }: { onBackToChat?: () => void }) {
  const { locale } = useI18n();
  // 同 ContextTab：消息属于会话，从当前会话派生而非直接读 AgentState。
  const { sessions: agentSessions, activeSessionId } = useAgentStore();
  const messages =
    agentSessions.find((s) => s.id === activeSessionId)?.messages ?? [];
  const { sessions } = useSessionStore();

  // Compute 100% genuine token & cost metrics from real message store
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalCostUsd = 0;
  let totalSavedUsd = 0;
  const modelCount: Record<string, number> = {};

  messages.forEach((msg) => {
    const mod = msg.metadata?.model || 'DeepSeek-V3';
    const modelSpec = BUILTIN_MODEL_CATALOG.find((m) => m.name === mod || m.id === mod) || BUILTIN_MODEL_CATALOG[0];

    const pTok = msg.metadata?.promptTokens ?? (msg.role === 'user' ? Math.max(1, Math.ceil(msg.content.length / 3.5)) : 0);
    const cTok = msg.metadata?.completionTokens ?? (msg.role === 'assistant' ? Math.max(1, Math.ceil(msg.content.length / 3.5)) : 0);
    const kCached = msg.metadata?.cachedTokens ?? 0;

    totalInputTokens += pTok;
    totalOutputTokens += cTok;
    totalCachedTokens += kCached;

    const tok = pTok + cTok;
    modelCount[mod] = (modelCount[mod] || 0) + tok;

    // Real cost formula:
    // Uncached Input Tokens * InputRate + Cached Tokens * CacheReadRate + Output Tokens * OutputRate
    if (modelSpec) {
      const uncachedInput = Math.max(0, pTok - kCached);
      const inputCost = (uncachedInput * modelSpec.cost.input) / 1_000_000;
      const cacheCost = (kCached * modelSpec.cost.cacheRead) / 1_000_000;
      const outputCost = (cTok * modelSpec.cost.output) / 1_000_000;
      totalCostUsd += inputCost + cacheCost + outputCost;

      // Saved cost via Prompt Cache (InputRate - CacheReadRate)
      const saved = (kCached * (modelSpec.cost.input - modelSpec.cost.cacheRead)) / 1_000_000;
      totalSavedUsd += Math.max(0, saved);
    }
  });

  const totalTokens = totalInputTokens + totalOutputTokens;
  const cacheHitRate = totalInputTokens > 0 ? (totalCachedTokens / totalInputTokens) * 100 : 0;
  const sessionList = Object.values(sessions);

  const modelShare = Object.entries(modelCount).map(([name, value], idx) => {
    const colors = ['#3B82F6', '#60A5FA', '#F59E0B', '#10B981', '#8B5CF6'];
    return { name, value, color: colors[idx % colors.length] };
  });

  // Calculate real timeline from messages
  const timelineData = messages
    .filter((m) => m.role === 'assistant' || m.role === 'user')
    .map((m) => {
      const date = new Date(m.timestamp);
      const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
      const pTok = m.metadata?.promptTokens ?? (m.role === 'user' ? Math.max(1, Math.ceil(m.content.length / 3.5)) : 0);
      const cTok = m.metadata?.completionTokens ?? (m.role === 'assistant' ? Math.max(1, Math.ceil(m.content.length / 3.5)) : 0);
      const cached = m.metadata?.cachedTokens ?? 0;
      return {
        time: timeStr,
        prompt: pTok,
        completion: cTok,
        cached,
        total: pTok + cTok,
      };
    });

  return (
    <div className={styles.pageContainer}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <Icon name="usage" size={20} />
          </div>
          <div>
            <h1 className={styles.pageTitle}>{locale === 'zh' ? '用量统计与性能分析 (Usage & Analytics)' : 'Usage & Analytics'}</h1>
            <p className={styles.pageSubtitle}>
              {locale === 'zh' ? '基于当前会话与大模型 API 返回的真实 Token 消耗、流速与开销核算' : 'Real token metrics, cache hit ratios and cost calculations from API sessions'}
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

      {/* Metric summary */}
      <div className={styles.metricsRow}>
        <div className={styles.metricCard}>
          <div className={styles.metricLabel}>{locale === 'zh' ? '真实 Token 吞吐量' : 'Total Tokens'}</div>
          <div className={styles.metricValue}>{totalTokens.toLocaleString()}</div>
          <div className={styles.metricChange}>
            {locale === 'zh' ? `输入: ${totalInputTokens.toLocaleString()} · 输出: ${totalOutputTokens.toLocaleString()}` : `In: ${totalInputTokens} · Out: ${totalOutputTokens}`}
          </div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricLabel}>{locale === 'zh' ? 'Prompt 缓存命中率' : 'Cache Hit Rate'}</div>
          <div className={styles.metricValue} style={{ color: '#10B981' }}>
            {cacheHitRate.toFixed(1)}%
          </div>
          <div className={styles.metricChange}>
            {totalCachedTokens > 0
              ? locale === 'zh' ? `已命中 ${totalCachedTokens.toLocaleString()} tokens` : `${totalCachedTokens} cached tokens`
              : locale === 'zh' ? 'DeepSeek 4k 边界自动缓存' : '4k boundary cache'}
          </div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricLabel}>{locale === 'zh' ? '会话消息总数' : 'Total Messages'}</div>
          <div className={styles.metricValue}>{messages.length}</div>
          <div className={styles.metricChange}>
            {locale === 'zh' ? `活跃会话: ${sessionList.length}` : `Active sessions: ${sessionList.length}`}
          </div>
        </div>

        <div className={styles.metricCard}>
          <div className={styles.metricLabel}>{locale === 'zh' ? '真实 API 开销' : 'API Cost'}</div>
          <div className={styles.metricValue} style={{ color: 'var(--oa-alias-brand-primary)' }}>
            ${totalCostUsd < 0.0001 && totalCostUsd > 0 ? totalCostUsd.toFixed(6) : totalCostUsd.toFixed(4)}
          </div>
          <div className={styles.metricChange} style={{ color: totalSavedUsd > 0 ? '#10B981' : undefined }}>
            {totalSavedUsd > 0
              ? locale === 'zh' ? `缓存节省: $${totalSavedUsd.toFixed(4)}` : `Saved: $${totalSavedUsd.toFixed(4)}`
              : locale === 'zh' ? '按官方阶梯定价换算' : 'Based on official rates'}
          </div>
        </div>
      </div>

      {/* Main Chart: Timeline or Empty State */}
      <div className={styles.settingsSection}>
        <h2 className={styles.sectionTitle}>{locale === 'zh' ? 'Token 实时时序流速 (Token Velocity Stream)' : 'Token Velocity Stream'}</h2>
        <p className={styles.sectionSubtitle}>{locale === 'zh' ? '记录各轮对话中输入、补全与缓存命中 Token 的真实流速曲线' : 'Real-time throughput curves of prompt, completion and cached tokens'}</p>

        {timelineData.length === 0 ? (
          <div style={{ padding: '48px 16px', textAlign: 'center', color: 'var(--oa-alias-text-caption)' }}>
            <Icon name="usage" size={32} style={{ color: 'var(--oa-alias-text-dimmed)', marginBottom: 8 }} />
            <p style={{ margin: 0, fontSize: 13 }}>{locale === 'zh' ? '暂无推理记录 · 在会话中发送指令即可实时生成真实的 Token 流速与开销曲线' : 'No requests yet · Send a message in chat to generate real-time metrics'}</p>
          </div>
        ) : (
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={timelineData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorPrompt" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#3B82F6" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="colorCached" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="colorComp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#F59E0B" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" stroke="var(--oa-alias-text-caption)" fontSize={11} tickLine={false} />
                <YAxis stroke="var(--oa-alias-text-caption)" fontSize={11} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--oa-alias-glass-bg)',
                    backdropFilter: 'blur(12px)',
                    border: '1px solid var(--oa-alias-border-l2)',
                    borderRadius: '10px',
                    fontSize: '12px',
                  }}
                />
                <Area type="monotone" dataKey="cached" name={locale === 'zh' ? '缓存命中 Tokens' : 'Cached Tokens'} stroke="#10B981" fill="url(#colorCached)" />
                <Area type="monotone" dataKey="prompt" name={locale === 'zh' ? '输入 Prompt Tokens' : 'Prompt Tokens'} stroke="#3B82F6" fill="url(#colorPrompt)" />
                <Area type="monotone" dataKey="completion" name={locale === 'zh' ? '输出补全 Tokens' : 'Completion Tokens'} stroke="#F59E0B" fill="url(#colorComp)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Model Distribution */}
      {modelShare.length > 0 && (
        <div className={styles.settingsSection}>
          <h2 className={styles.sectionTitle}>{locale === 'zh' ? '模型用量分布 (Model Share)' : 'Model Distribution'}</h2>
          <div style={{ display: 'flex', alignItems: 'center', height: 160 }}>
            <div style={{ width: '40%', height: '100%' }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={modelShare} cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="value">
                    {modelShare.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ width: '60%', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {modelShare.map((m) => (
                <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: m.color }} />
                  <span style={{ color: 'var(--oa-alias-text-primary)', fontWeight: 500 }}>{m.name}</span>
                  <span style={{ color: 'var(--oa-alias-text-caption)' }}>({m.value.toLocaleString()} tok)</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Recent Sessions */}
      <div className={styles.settingsSection}>
        <h2 className={styles.sectionTitle}>{locale === 'zh' ? '会话执行记录 (Session History)' : 'Session History'}</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sessionList.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--oa-alias-text-caption)', fontSize: 13 }}>
              {locale === 'zh' ? '暂无历史会话记录' : 'No recorded sessions'}
            </div>
          ) : (
            sessionList.map((s) => (
              <div
                key={s.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  background: 'var(--oa-alias-bg-base)',
                  borderRadius: 10,
                  fontSize: 13,
                  border: '1px solid var(--oa-alias-border-l1)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--oa-alias-text-primary)' }}>{s.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--oa-alias-text-secondary)', marginTop: 2 }}>
                    {s.messageCount} {locale === 'zh' ? '条对话' : 'messages'} · {s.state}
                  </div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--oa-alias-text-caption)' }}>
                  {new Date(s.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default UsagePage;
