import React, { useState, useCallback } from 'react';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/button';
import { Input } from '../ui/Input';
import { useI18n } from '../../store';
import styles from './DetailsPanel.module.css';

export interface Memory {
  id: string;
  content: string;
  category: 'code' | 'pref' | 'rule' | 'fact';
  tier: 'short' | 'long' | 'persistent';
  timestamp: number;
}

const LOCAL_STORAGE_MEMORIES_KEY = 'ovolve_agent_memories';

const PRESET_MEMORY_TAGS = [
  { label: '偏好 TypeScript 严格模式', labelEn: 'Strict TypeScript Mode', cat: 'code' },
  { label: '默认中文注释与文档', labelEn: 'Default Chinese Comments', cat: 'pref' },
  { label: '遵循 RESTful API 规范', labelEn: 'Follow RESTful Specs', cat: 'rule' },
  { label: '编写高覆盖率单元测试', labelEn: 'Write High Coverage Tests', cat: 'code' },
];

function loadMemories(): Memory[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_MEMORIES_KEY);
    return raw ? JSON.parse(raw) : [
      {
        id: 'mem-default-1',
        content: '优先采用不可变数据流与纯函数架构设计',
        category: 'code',
        tier: 'persistent',
        timestamp: Date.now() - 3600000 * 24,
      },
      {
        id: 'mem-default-2',
        content: '严禁生成虚构依赖包，严格核验 package.json',
        category: 'rule',
        tier: 'long',
        timestamp: Date.now() - 3600000 * 4,
      }
    ];
  } catch {
    return [];
  }
}

function saveMemories(memories: Memory[]) {
  try {
    localStorage.setItem(LOCAL_STORAGE_MEMORIES_KEY, JSON.stringify(memories));
  } catch {
    // Ignore
  }
}

function formatTime(ts: number, locale: string): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return locale === 'zh' ? '刚刚' : 'Just now';
  if (minutes < 60) return locale === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`;
  if (hours < 24) return locale === 'zh' ? `${hours} 小时前` : `${hours}h ago`;
  return locale === 'zh' ? `${days} 天前` : `${days}d ago`;
}

export function MemoryTab() {
  const { locale } = useI18n();
  const [memories, setMemories] = useState<Memory[]>(loadMemories);
  const [searchQuery, setSearchQuery] = useState('');
  const [newMemoryText, setNewMemoryText] = useState('');
  const [selectedCat, setSelectedCat] = useState<'code' | 'pref' | 'rule' | 'fact'>('code');

  const filteredMemories = searchQuery
    ? memories.filter((m) =>
        m.content.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : memories;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
    },
    []
  );

  const handleAddMemory = (content?: string, cat?: 'code' | 'pref' | 'rule' | 'fact') => {
    const text = (content || newMemoryText).trim();
    if (!text) return;
    const item: Memory = {
      id: `mem-${Date.now()}`,
      content: text,
      category: cat || selectedCat,
      tier: 'long',
      timestamp: Date.now(),
    };
    const updated = [item, ...memories];
    setMemories(updated);
    saveMemories(updated);
    if (!content) setNewMemoryText('');
  };

  const handleDeleteMemory = (id: string) => {
    const updated = memories.filter((m) => m.id !== id);
    setMemories(updated);
    saveMemories(updated);
  };

  const getCategoryBadge = (cat: string) => {
    switch (cat) {
      case 'code':
        return { label: locale === 'zh' ? '🛠️ 编程偏好' : '🛠️ Code', color: '#3B82F6', bg: 'rgba(59, 130, 246, 0.12)' };
      case 'rule':
        return { label: locale === 'zh' ? '📋 架构规则' : '📋 Rule', color: '#10B981', bg: 'rgba(16, 185, 129, 0.12)' };
      case 'pref':
        return { label: locale === 'zh' ? '👤 用户习惯' : '👤 Habit', color: '#8B5CF6', bg: 'rgba(139, 92, 246, 0.12)' };
      default:
        return { label: locale === 'zh' ? '🧠 长期事实' : '🧠 Fact', color: '#F59E0B', bg: 'rgba(245, 158, 11, 0.12)' };
    }
  };

  return (
    <>
      {/* Search Bar */}
      <div className={styles.cardSection}>
        <Input
          placeholder={locale === 'zh' ? '搜索记忆或工程偏好条目...' : 'Search memories or rules...'}
          value={searchQuery}
          onChange={handleSearchChange}
          icon={<Icon name="search" size={14} />}
          fullWidth
        />
      </div>

      {/* Add Memory Card */}
      <div className={styles.cardSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            <Icon name="plus" size={14} />
            {locale === 'zh' ? '记录新记忆 / 偏好' : 'Record New Memory'}
          </span>
          <select
            value={selectedCat}
            onChange={(e) => setSelectedCat(e.target.value as any)}
            style={{
              padding: '3px 8px',
              borderRadius: 6,
              border: '1px solid var(--oa-alias-border-l2)',
              background: 'var(--oa-alias-bg-layer-2)',
              color: 'var(--oa-alias-text-primary)',
              fontSize: 11,
              fontWeight: 500,
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            <option value="code">{locale === 'zh' ? '🛠️ 编程偏好' : 'Code'}</option>
            <option value="rule">{locale === 'zh' ? '📋 架构规则' : 'Rule'}</option>
            <option value="pref">{locale === 'zh' ? '👤 用户习惯' : 'Habit'}</option>
            <option value="fact">{locale === 'zh' ? '🧠 长期事实' : 'Fact'}</option>
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <input
            type="text"
            placeholder={locale === 'zh' ? '例如：始终使用中文输出注释，优先使用 Vitest...' : 'e.g. Always write Chinese docstrings...'}
            value={newMemoryText}
            onChange={(e) => setNewMemoryText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddMemory()}
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--oa-alias-border-l2)',
              background: 'var(--oa-alias-bg-layer-2)',
              color: 'var(--oa-alias-text-primary)',
              fontSize: 12,
              outline: 'none',
            }}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => handleAddMemory()}
            disabled={!newMemoryText.trim()}
            icon={<Icon name="check" size={13} />}
          >
            {locale === 'zh' ? '保存' : 'Save'}
          </Button>
        </div>

        {/* Quick Presets */}
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--oa-alias-text-tertiary)', marginBottom: 4 }}>
            {locale === 'zh' ? '快捷预设推荐：' : 'Quick Presets:'}
          </div>
          <div className={styles.tagGrid}>
            {PRESET_MEMORY_TAGS.map((tag, idx) => (
              <button
                key={idx}
                className={styles.quickTag}
                onClick={() => handleAddMemory(locale === 'zh' ? tag.label : tag.labelEn, tag.cat as any)}
                title={locale === 'zh' ? '点击快速添加此记忆' : 'Click to add'}
              >
                + {locale === 'zh' ? tag.label : tag.labelEn}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Memory List */}
      <div className={styles.cardSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            <Icon name="memory" size={14} />
            {searchQuery ? (locale === 'zh' ? '搜索结果' : 'Results') : (locale === 'zh' ? '已持久化记忆库' : 'Active Memories')}
          </span>
          <span className={styles.itemBadge}>
            {filteredMemories.length} {locale === 'zh' ? '条' : 'items'}
          </span>
        </div>

        {filteredMemories.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIconBadge}>
              <Icon name="memory" size={20} />
            </div>
            <div className={styles.emptyTitle}>{locale === 'zh' ? '暂无记忆条目' : 'No Memories Found'}</div>
            <div className={styles.emptyDesc}>
              {locale === 'zh' ? '智能体将在跨会话任务中自动感知并严格遵守上述记忆偏好。' : 'Agent will persist and respect your rules across sessions.'}
            </div>
          </div>
        ) : (
          filteredMemories.map((mem) => {
            const badge = getCategoryBadge(mem.category);
            return (
              <div key={mem.id} className={styles.item}>
                <span className={styles.itemIcon}>
                  <Icon
                    name={mem.tier === 'persistent' ? 'lock' : 'database'}
                    size={13}
                  />
                </span>
                <div className={styles.itemContent}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 4, background: badge.bg, color: badge.color }}>
                      {badge.label}
                    </span>
                    <span className={styles.itemMeta}>{formatTime(mem.timestamp, locale)}</span>
                  </div>
                  <div className={styles.itemLabel}>{mem.content}</div>
                </div>
                <button
                  onClick={() => handleDeleteMemory(mem.id)}
                  title={locale === 'zh' ? '删除此条记忆' : 'Delete'}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--oa-alias-text-tertiary)',
                    cursor: 'pointer',
                    padding: 6,
                    borderRadius: 6,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 150ms ease'
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--oa-alias-error)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--oa-alias-text-tertiary)')}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

export default MemoryTab;
