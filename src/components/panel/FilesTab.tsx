import React, { useState } from 'react';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/button';
import { useI18n } from '../../store';
import styles from './DetailsPanel.module.css';

export interface FileChange {
  id: string;
  path: string;
  status: 'added' | 'modified' | 'deleted';
  addedLines: number;
  removedLines: number;
  diff?: string;
}

const DEFAULT_SAMPLE_FILES: FileChange[] = [
  {
    id: 'f1',
    path: 'src/store/themeStore.ts',
    status: 'modified',
    addedLines: 18,
    removedLines: 6,
    diff: `@@ -10,8 +10,12 @@
-  mode: ThemeMode = 'system',
+  mode: ThemeMode = 'dark',
   isDark: boolean;`,
  },
  {
    id: 'f2',
    path: 'src/pages/SettingsPage.tsx',
    status: 'modified',
    addedLines: 12,
    removedLines: 4,
    diff: `@@ -45,6 +45,8 @@
+  onClick={() => setMode('light')}
+  onClick={() => setMode('dark')}`,
  },
  {
    id: 'f3',
    path: 'src/components/ui/Input.module.css',
    status: 'modified',
    addedLines: 15,
    removedLines: 4,
    diff: `@@ -28,5 +28,8 @@
-  background: var(--oa-alias-bg-layer-1);
+  background: var(--oa-alias-bg-layer-2);
+  color: var(--oa-alias-text-primary);`,
  }
];

export function FilesTab({ files }: { files?: FileChange[] }) {
  const { locale } = useI18n();
  const displayFiles = files && files.length > 0 ? files : DEFAULT_SAMPLE_FILES;
  const [selectedFile, setSelectedFile] = useState<string | null>(displayFiles[0]?.id || null);
  const [filter, setFilter] = useState<'all' | 'modified' | 'added' | 'deleted'>('all');

  const filtered = displayFiles.filter(
    (f) => filter === 'all' || f.status === filter
  );

  const activeFileData = displayFiles.find((f) => f.id === selectedFile);

  return (
    <>
      {/* File Stats & Filter */}
      <div className={styles.cardSection}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            <Icon name="file" size={14} />
            {locale === 'zh' ? '会话变更文件列表' : 'Modified Files'}
          </span>
          <span className={styles.itemBadge}>
            {filtered.length} {locale === 'zh' ? '个文件' : 'files'}
          </span>
        </div>

        {/* Filter Pills */}
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          {(['all', 'modified', 'added', 'deleted'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setFilter(mode)}
              style={{
                padding: '4px 8px',
                borderRadius: 6,
                border: filter === mode ? '1px solid var(--oa-alias-brand-primary)' : '1px solid var(--oa-alias-border-l1)',
                background: filter === mode ? 'var(--oa-alias-button-primary-fill)' : 'var(--oa-alias-bg-layer-2)',
                color: filter === mode ? 'var(--oa-alias-brand-primary)' : 'var(--oa-alias-text-secondary)',
                fontSize: 11,
                fontWeight: filter === mode ? 650 : 500,
                cursor: 'pointer',
                transition: 'all 150ms ease'
              }}
            >
              {mode === 'all'
                ? locale === 'zh' ? '全部' : 'All'
                : mode === 'modified'
                ? locale === 'zh' ? '修改' : 'Mod'
                : mode === 'added'
                ? locale === 'zh' ? '新增' : 'Add'
                : locale === 'zh' ? '删除' : 'Del'}
            </button>
          ))}
        </div>
      </div>

      {/* File list */}
      <div className={styles.cardSection}>
        {filtered.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIconBadge}>
              <Icon name="file" size={20} />
            </div>
            <div className={styles.emptyTitle}>{locale === 'zh' ? '无匹配文件' : 'No Files Found'}</div>
          </div>
        ) : (
          filtered.map((file) => {
            const isSelected = file.id === selectedFile;
            return (
              <div
                key={file.id}
                className={styles.item}
                onClick={() => setSelectedFile(isSelected ? null : file.id)}
                style={{
                  cursor: 'pointer',
                  borderColor: isSelected ? 'var(--oa-alias-brand-primary)' : undefined,
                  background: isSelected ? 'var(--oa-alias-interactive-bg-hover)' : undefined
                }}
              >
                <span className={styles.itemIcon}>
                  <Icon name="code" size={13} />
                </span>
                <div className={styles.itemContent}>
                  <div className={styles.itemLabel}>{file.path}</div>
                  <div className={styles.itemMeta}>
                    <span className={styles.diffAdded}>+{file.addedLines}</span>
                    {'  '}
                    <span className={styles.diffRemoved}>-{file.removedLines}</span>
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background:
                      file.status === 'added'
                        ? 'rgba(16, 185, 129, 0.15)'
                        : file.status === 'deleted'
                        ? 'rgba(239, 68, 68, 0.15)'
                        : 'rgba(59, 130, 246, 0.15)',
                    color:
                      file.status === 'added'
                        ? '#10B981'
                        : file.status === 'deleted'
                        ? '#EF4444'
                        : '#3B82F6',
                  }}
                >
                  {file.status.toUpperCase()}
                </span>
              </div>
            );
          })
        )}
      </div>

      {/* Diff preview card */}
      {activeFileData && (
        <div className={styles.cardSection}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>
              <Icon name="terminal" size={14} />
              {locale === 'zh' ? '差异补丁预览 (AST Diff)' : 'AST Diff Preview'}
            </span>
            <span className={styles.sectionAction}>
              {locale === 'zh' ? '单文件还原' : 'Rollback'}
            </span>
          </div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontSize: 11,
              lineHeight: 1.5,
              background: 'var(--oa-alias-bg-base)',
              border: '1px solid var(--oa-alias-border-l1)',
              borderRadius: 8,
              padding: 10,
              whiteSpace: 'pre-wrap',
              color: 'var(--oa-alias-text-primary)',
              overflowX: 'auto'
            }}
          >
            {activeFileData.diff?.split('\n').map((line, idx) => {
              const isAdd = line.startsWith('+');
              const isDel = line.startsWith('-');
              const isHeader = line.startsWith('@');
              return (
                <div
                  key={idx}
                  style={{
                    color: isAdd ? '#10B981' : isDel ? '#EF4444' : isHeader ? '#8B5CF6' : 'var(--oa-alias-text-secondary)',
                    background: isAdd ? 'rgba(16, 185, 129, 0.08)' : isDel ? 'rgba(239, 68, 68, 0.08)' : 'transparent',
                    padding: '1px 4px',
                    borderRadius: 3
                  }}
                >
                  {line}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

export default FilesTab;
