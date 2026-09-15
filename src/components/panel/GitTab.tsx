import React, { useState } from 'react';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/button';
import { useI18n } from '../../store';
import styles from './DetailsPanel.module.css';

export interface GitFile {
  path: string;
  status: 'staged' | 'unstaged' | 'untracked';
  additions?: number;
  deletions?: number;
}

const DEFAULT_STAGED: GitFile[] = [
  { path: 'src/store/themeStore.ts', status: 'staged', additions: 18, deletions: 6 },
  { path: 'src/pages/SettingsPage.tsx', status: 'staged', additions: 12, deletions: 4 },
];

const DEFAULT_UNSTAGED: GitFile[] = [
  { path: 'src/components/ui/Input.module.css', status: 'unstaged', additions: 15, deletions: 4 },
  { path: 'src/components/panel/DetailsPanel.module.css', status: 'unstaged', additions: 45, deletions: 20 },
];

export function GitTab({
  branch = 'main',
  stagedFiles = DEFAULT_STAGED,
  unstagedFiles = DEFAULT_UNSTAGED,
}: {
  branch?: string;
  stagedFiles?: GitFile[];
  unstagedFiles?: GitFile[];
}) {
  const { locale } = useI18n();
  const [staged, setStaged] = useState<GitFile[]>(stagedFiles);
  const [unstaged, setUnstaged] = useState<GitFile[]>(unstagedFiles);
  const [commitMsg, setCommitMsg] = useState('fix(ui): enhance high contrast themes and inspector cards');

  const handleStageFile = (file: GitFile) => {
    setUnstaged(unstaged.filter((f) => f.path !== file.path));
    setStaged([...staged, { ...file, status: 'staged' }]);
  };

  const handleUnstageFile = (file: GitFile) => {
    setStaged(staged.filter((f) => f.path !== file.path));
    setUnstaged([...unstaged, { ...file, status: 'unstaged' }]);
  };

  const handleStageAll = () => {
    setStaged([...staged, ...unstaged.map((f) => ({ ...f, status: 'staged' as const }))]);
    setUnstaged([]);
  };

  const handleUnstageAll = () => {
    setUnstaged([...unstaged, ...staged.map((f) => ({ ...f, status: 'unstaged' as const }))]);
    setStaged([]);
  };

  const handleGenerateAiCommit = () => {
    setCommitMsg(locale === 'zh' ? 'feat(ux): 优化主题工坊壁纸矢量渲染与检查器卡片高对比度' : 'feat(ux): improve wallpaper vector rendering and high-contrast inspector');
  };

  return (
    <>
      {/* Branch & Sync Status */}
      <div className={styles.cardSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            <Icon name="git-branch" size={14} />
            {locale === 'zh' ? '当前 Git 分支' : 'Git Branch'}
          </span>
          <span className={styles.itemBadge} style={{ background: 'rgba(16, 185, 129, 0.12)', color: '#10B981', fontWeight: 600 }}>
            {locale === 'zh' ? '与远程已同步' : 'Synced'}
          </span>
        </div>
        <div className={styles.item} style={{ margin: 0 }}>
          <span className={styles.itemIcon}>
            <Icon name="git-branch" size={13} />
          </span>
          <div className={styles.itemContent}>
            <div className={styles.itemLabel} style={{ fontWeight: 650 }}>{branch}</div>
            <div className={styles.itemMeta}>origin/{branch} · ↑0 ↓0 Commits</div>
          </div>
        </div>
      </div>

      {/* Staged changes */}
      <div className={styles.cardSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            <Icon name="check" size={14} />
            {locale === 'zh' ? '已暂存更改' : 'Staged Changes'}
          </span>
          {staged.length > 0 && (
            <button className={styles.sectionAction} onClick={handleUnstageAll}>
              {locale === 'zh' ? '全部取消暂存' : 'Unstage all'}
            </button>
          )}
        </div>
        {staged.length > 0 ? (
          staged.map((file) => (
            <div key={file.path} className={styles.item}>
              <span className={styles.itemIcon} style={{ color: '#10B981' }}>
                <Icon name="check" size={13} />
              </span>
              <div className={styles.itemContent}>
                <div className={styles.itemLabel}>{file.path}</div>
                {file.additions !== undefined && (
                  <div className={styles.itemMeta}>
                    <span className={styles.diffAdded}>+{file.additions}</span>{' '}
                    <span className={styles.diffRemoved}>-{file.deletions}</span>
                  </div>
                )}
              </div>
              <button
                onClick={() => handleUnstageFile(file)}
                title={locale === 'zh' ? '取消暂存' : 'Unstage'}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--oa-alias-text-tertiary)',
                  cursor: 'pointer',
                  padding: 4
                }}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ))
        ) : (
          <div className={styles.empty} style={{ padding: '16px 12px' }}>
            <span style={{ fontSize: 11.5, color: 'var(--oa-alias-text-secondary)' }}>
              {locale === 'zh' ? '暂无已暂存的文件' : 'No staged changes'}
            </span>
          </div>
        )}
      </div>

      {/* Unstaged changes */}
      <div className={styles.cardSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            <Icon name="edit" size={14} />
            {locale === 'zh' ? '工作区未暂存更改' : 'Unstaged Changes'}
          </span>
          {unstaged.length > 0 && (
            <button className={styles.sectionAction} onClick={handleStageAll}>
              {locale === 'zh' ? '全部暂存' : 'Stage all'}
            </button>
          )}
        </div>
        {unstaged.length > 0 ? (
          unstaged.map((file) => (
            <div key={file.path} className={styles.item}>
              <span className={styles.itemIcon} style={{ color: '#F59E0B' }}>
                <Icon name="edit" size={13} />
              </span>
              <div className={styles.itemContent}>
                <div className={styles.itemLabel}>{file.path}</div>
                {file.additions !== undefined && (
                  <div className={styles.itemMeta}>
                    <span className={styles.diffAdded}>+{file.additions}</span>{' '}
                    <span className={styles.diffRemoved}>-{file.deletions}</span>
                  </div>
                )}
              </div>
              <button
                onClick={() => handleStageFile(file)}
                title={locale === 'zh' ? '暂存此文件' : 'Stage'}
                style={{
                  background: 'var(--oa-alias-button-primary-fill)',
                  border: '1px solid var(--oa-alias-border-l2)',
                  color: 'var(--oa-alias-brand-primary)',
                  borderRadius: 4,
                  cursor: 'pointer',
                  padding: '2px 6px',
                  fontSize: 11,
                  fontWeight: 600
                }}
              >
                + {locale === 'zh' ? '暂存' : 'Stage'}
              </button>
            </div>
          ))
        ) : (
          <div className={styles.empty} style={{ padding: '16px 12px' }}>
            <span style={{ fontSize: 11.5, color: '#10B981', fontWeight: 600 }}>
              ✓ {locale === 'zh' ? '工作区干净，无未暂存修改' : 'Working tree clean'}
            </span>
          </div>
        )}
      </div>

      {/* AI Commit & Actions */}
      <div className={styles.cardSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            <Icon name="terminal" size={14} />
            {locale === 'zh' ? '提交信息 (Commit)' : 'Commit Changes'}
          </span>
          <button
            className={styles.sectionAction}
            onClick={handleGenerateAiCommit}
            title={locale === 'zh' ? '根据当前 Diff 自动生成标准 Conventional Commit' : 'Generate with AI'}
          >
            ✨ {locale === 'zh' ? 'AI 生成' : 'AI Generate'}
          </button>
        </div>

        <textarea
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder={locale === 'zh' ? '输入提交信息 (例如 feat: ...)' : 'Commit message...'}
          rows={3}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--oa-alias-border-l2)',
            background: 'var(--oa-alias-bg-layer-2)',
            color: 'var(--oa-alias-text-primary)',
            fontFamily: 'var(--oa-font-family)',
            fontSize: 12,
            resize: 'none',
            outline: 'none',
            lineHeight: 1.4,
          }}
        />

        <div className={styles.buttonRow}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleStageAll}
            disabled={unstaged.length === 0}
            icon={<Icon name="plus" size={13} />}
            fullWidth
          >
            {locale === 'zh' ? '全部暂存' : 'Stage All'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={staged.length === 0 || !commitMsg.trim()}
            icon={<Icon name="check" size={13} />}
            fullWidth
          >
            {locale === 'zh' ? `提交 (${staged.length})` : `Commit (${staged.length})`}
          </Button>
        </div>
      </div>
    </>
  );
}

export default GitTab;
