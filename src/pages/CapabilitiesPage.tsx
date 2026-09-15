import React, { useState } from 'react';
import { Icon } from '../components/ui/Icon';
import { Button } from '../components/ui/button';
import { useI18n } from '../store';
import { BUILTIN_MODEL_CATALOG, ModelSpecification } from '../lib/cache';
import styles from './Pages.module.css';

export interface CapabilityItem {
  id: string;
  nameZh: string;
  nameEn: string;
  category: 'tools' | 'skills' | 'mcp' | 'plugins';
  descZh: string;
  descEn: string;
  enabled: boolean;
  permission: 'auto' | 'confirm' | 'deny';
  tagZh: string;
  tagEn: string;
  timeoutSec?: number;
  allowedPaths?: string;
}

const STORAGE_CAPABILITIES_KEY = 'ovolve_agent_capabilities_v3';

const DEFAULT_CAPABILITIES: CapabilityItem[] = [
  {
    id: 'tool-bash',
    nameZh: '终端执行器 (Shell)',
    nameEn: 'Shell Executor',
    category: 'tools',
    descZh: '在受控的沙箱环境中执行 PowerShell / Bash 脚本与构建指令',
    descEn: 'Run shell commands and build scripts in isolated workspace environment',
    enabled: true,
    permission: 'confirm',
    tagZh: '内置',
    tagEn: 'Built-in',
    timeoutSec: 30,
    allowedPaths: './',
  },
  {
    id: 'tool-fs',
    nameZh: '文件系统读写 (Atomic FS)',
    nameEn: 'File System (Atomic FS)',
    category: 'tools',
    descZh: '支持大文件精准检索、代码块 Diff 替换与原子化写入',
    descEn: 'Precise file reading, chunked diff replacement and atomic writes',
    enabled: true,
    permission: 'auto',
    tagZh: '内置',
    tagEn: 'Built-in',
    timeoutSec: 15,
    allowedPaths: './',
  },
  {
    id: 'tool-search',
    nameZh: '代码检索 (Ripgrep & AST)',
    nameEn: 'Code Search (Ripgrep & AST)',
    category: 'tools',
    descZh: '提供亚毫秒级全工作区正则搜索与 AST 抽象语法树符号索引',
    descEn: 'Sub-millisecond regex search & AST symbol indexing across workspace',
    enabled: true,
    permission: 'auto',
    tagZh: '内置',
    tagEn: 'Built-in',
    timeoutSec: 10,
    allowedPaths: './',
  },
  {
    id: 'skill-science',
    nameZh: '生命科学技能包',
    nameEn: 'Bio / Science Skills',
    category: 'skills',
    descZh: '集成 AlphaFold 结构预测分析、PDB 分子检索与 PubMed 文献解析',
    descEn: 'AlphaFold structural analysis, PDB molecular search and PubMed fetch',
    enabled: true,
    permission: 'auto',
    tagZh: '技能包',
    tagEn: 'Skill Pack',
    timeoutSec: 60,
    allowedPaths: './',
  },
  {
    id: 'skill-refactor',
    nameZh: '架构重构技能包',
    nameEn: 'Architecture Refactoring',
    category: 'skills',
    descZh: '识别代码坏味道、模块解耦、类型守卫与全工程 TypeScript 完整性维护',
    descEn: 'Identify anti-patterns, modularize components & preserve TS integrity',
    enabled: true,
    permission: 'auto',
    tagZh: '技能包',
    tagEn: 'Skill Pack',
    timeoutSec: 45,
    allowedPaths: './src',
  },
  {
    id: 'mcp-git',
    nameZh: 'MCP Git 协作服务',
    nameEn: 'MCP Git Service',
    category: 'mcp',
    descZh: '基于 Model Context Protocol 协议的 Git 分支、Diff 审阅与提交服务',
    descEn: 'Model Context Protocol server for git branches, diffs and commits',
    enabled: true,
    permission: 'auto',
    tagZh: 'MCP 协议',
    tagEn: 'MCP Protocol',
    timeoutSec: 20,
    allowedPaths: './',
  },
  {
    id: 'mcp-browser',
    nameZh: 'MCP 无头浏览器',
    nameEn: 'MCP Headless Browser',
    category: 'mcp',
    descZh: '支持 Headless Chromium 自动化渲染、DOM 树提取与页面快照截屏',
    descEn: 'Headless Chromium page scraping, DOM extraction and screenshot capture',
    enabled: false,
    permission: 'confirm',
    tagZh: 'MCP 协议',
    tagEn: 'MCP Protocol',
    timeoutSec: 60,
    allowedPaths: './',
  },
  {
    id: 'plug-prettier',
    nameZh: '代码格式化插件',
    nameEn: 'Auto-Formatter Plugin',
    category: 'plugins',
    descZh: '在智能体保存或修改文件后，自动执行工程 Prettier 与 ESLint 校验',
    descEn: 'Automatically run Prettier and ESLint on tool edits',
    enabled: true,
    permission: 'auto',
    tagZh: '插件',
    tagEn: 'Plugin',
    timeoutSec: 15,
    allowedPaths: './',
  },
];

function loadCapabilities(): CapabilityItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_CAPABILITIES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // Ignore
  }
  return DEFAULT_CAPABILITIES;
}

function saveCapabilities(items: CapabilityItem[]) {
  try {
    localStorage.setItem(STORAGE_CAPABILITIES_KEY, JSON.stringify(items));
  } catch {
    // Ignore
  }
}

export function CapabilitiesPage({ onBackToChat }: { onBackToChat?: () => void }) {
  const { locale } = useI18n();
  const [activeCategory, setActiveCategory] = useState<'tools' | 'skills' | 'mcp' | 'plugins' | 'models'>('tools');
  const [capabilities, setCapabilities] = useState<CapabilityItem[]>(loadCapabilities);

  // Config modal state
  const [editingItem, setEditingItem] = useState<CapabilityItem | null>(null);
  const [editPermission, setEditPermission] = useState<'auto' | 'confirm' | 'deny'>('auto');
  const [editTimeout, setEditTimeout] = useState<number>(30);
  const [editPaths, setEditPaths] = useState<string>('./');
  const [showAddModal, setShowAddModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const toggleEnabled = (id: string) => {
    const updated = capabilities.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c));
    setCapabilities(updated);
    saveCapabilities(updated);
  };

  const handleOpenConfig = (item: CapabilityItem) => {
    setEditingItem(item);
    setEditPermission(item.permission);
    setEditTimeout(item.timeoutSec ?? 30);
    setEditPaths(item.allowedPaths ?? './');
  };

  const handleSaveConfig = () => {
    if (!editingItem) return;
    const updated = capabilities.map((c) =>
      c.id === editingItem.id
        ? { ...c, permission: editPermission, timeoutSec: editTimeout, allowedPaths: editPaths }
        : c
    );
    setCapabilities(updated);
    saveCapabilities(updated);
    setEditingItem(null);
  };

  const handleAddCapability = () => {
    if (!newName.trim()) return;
    const isZh = locale === 'zh';
    const newItem: CapabilityItem = {
      id: `custom-${Date.now()}`,
      nameZh: newName.trim(),
      nameEn: newName.trim(),
      category: activeCategory === 'models' ? 'tools' : activeCategory,
      descZh: newDesc.trim() || '自定义扩展能力服务',
      descEn: newDesc.trim() || 'Custom extended capability',
      enabled: true,
      permission: 'confirm',
      tagZh: '自定义',
      tagEn: 'Custom',
      timeoutSec: 30,
      allowedPaths: './',
    };
    const updated = [newItem, ...capabilities];
    setCapabilities(updated);
    saveCapabilities(updated);
    setNewName('');
    setNewDesc('');
    setShowAddModal(false);
  };

  const filtered = capabilities.filter((c) => c.category === activeCategory);

  return (
    <div className={styles.pageContainer}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <Icon name="capabilities" size={20} />
          </div>
          <div>
            <h1 className={styles.pageTitle}>{locale === 'zh' ? '能力与工具集' : 'Capabilities & Tools'}</h1>
            <p className={styles.pageSubtitle}>
              {locale === 'zh' ? '管理智能体内置工具、技能包、MCP 服务与模型目录缓存' : 'Manage built-in tools, skill packs, MCP servers & model catalog cache'}
            </p>
          </div>
        </div>
        <div className={styles.headerActions}>
          {onBackToChat && (
            <Button variant="secondary" size="sm" onClick={onBackToChat} icon={<Icon name="chat" size={14} />}>
              {locale === 'zh' ? '返回会话' : 'Back to Chat'}
            </Button>
          )}
          <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setShowAddModal(true)}>
            {locale === 'zh' ? '添加能力 / MCP' : 'Add Capability / MCP'}
          </Button>
        </div>
      </div>

      {/* Segmented Filter Bar */}
      <div className={styles.subTabBar}>
        <button
          className={`${styles.subTabBtn} ${activeCategory === 'tools' ? styles.subTabBtnActive : ''}`}
          onClick={() => setActiveCategory('tools')}
        >
          <Icon name="tool" size={14} />
          {locale === 'zh' ? '核心工具' : 'Core Tools'}
        </button>
        <button
          className={`${styles.subTabBtn} ${activeCategory === 'skills' ? styles.subTabBtnActive : ''}`}
          onClick={() => setActiveCategory('skills')}
        >
          <Icon name="zap" size={14} />
          {locale === 'zh' ? '智能体技能' : 'Skill Packs'}
        </button>
        <button
          className={`${styles.subTabBtn} ${activeCategory === 'mcp' ? styles.subTabBtnActive : ''}`}
          onClick={() => setActiveCategory('mcp')}
        >
          <Icon name="database" size={14} />
          {locale === 'zh' ? 'MCP 服务' : 'MCP Servers'}
        </button>
        <button
          className={`${styles.subTabBtn} ${activeCategory === 'plugins' ? styles.subTabBtnActive : ''}`}
          onClick={() => setActiveCategory('plugins')}
        >
          <Icon name="code" size={14} />
          {locale === 'zh' ? '扩展插件' : 'Plugins'}
        </button>
        <button
          className={`${styles.subTabBtn} ${activeCategory === 'models' ? styles.subTabBtnActive : ''}`}
          onClick={() => setActiveCategory('models')}
        >
          <Icon name="brain" size={14} />
          {locale === 'zh' ? '模型目录' : 'Model Catalog'}
        </button>
      </div>

      {/* Capabilities / Model Catalog Cache Grid */}
      {activeCategory === 'models' ? (
        <div className={styles.cardGrid}>
          {BUILTIN_MODEL_CATALOG.map((model: ModelSpecification) => (
            <div key={model.id} className={styles.card}>
              <div className={styles.cardHeader}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <h3 className={styles.cardTitle}>{model.name}</h3>
                  <span className={styles.cardBadge} style={{ background: 'rgba(59, 130, 246, 0.1)', color: 'var(--oa-alias-brand-primary)' }}>
                    {model.provider}
                  </span>
                </div>
                <span className={styles.cardBadge} style={{ background: 'rgba(16, 185, 129, 0.1)', color: '#16A34A' }}>
                  {locale === 'zh' ? '已缓存' : 'Cached'}
                </span>
              </div>

              <p className={styles.cardDescription}>
                {model.supportsThinking
                  ? locale === 'zh' ? '支持深度链式思考与反思' : 'Supports deep reasoning & chain-of-thought'
                  : locale === 'zh' ? '通用高吞吐主力编程模型' : 'General high-velocity model'}
                {' · '}
                {locale === 'zh' ? '上下文配额' : 'Context'}: {model.contextWindow / 1000}k tokens
              </p>

              <div style={{ fontSize: 11, color: 'var(--oa-alias-text-secondary)', margin: '4px 0 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div>{locale === 'zh' ? `输入: $${model.cost.input}/M · 输出: $${model.cost.output}/M` : `In: $${model.cost.input}/M · Out: $${model.cost.output}/M`}</div>
                <div>{locale === 'zh' ? '缓存读取: ' : 'Cache read: '}<strong style={{ color: '#16A34A' }}>${model.cost.cacheRead}/M {locale === 'zh' ? '(节省 90%)' : '(Save 90%)'}</strong></div>
              </div>

              <div className={styles.cardFooter}>
                <span>{model.supportsPromptCache ? (locale === 'zh' ? '支持前缀缓存' : 'Prompt Cache: ✔') : '-'}</span>
                <span style={{ color: 'var(--oa-alias-brand-primary)', fontWeight: 500 }}>
                  TTL: 3600s
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.cardGrid}>
          {filtered.map((item) => {
            const title = locale === 'zh' ? item.nameZh : item.nameEn;
            const desc = locale === 'zh' ? item.descZh : item.descEn;
            const tag = locale === 'zh' ? item.tagZh : item.tagEn;

            return (
              <div key={item.id} className={styles.card}>
                <div className={styles.cardHeader}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <h3 className={styles.cardTitle}>{title}</h3>
                    <span className={styles.cardBadge} style={{ background: 'var(--oa-alias-interactive-solid-hover)', color: 'var(--oa-alias-text-secondary)' }}>
                      {tag}
                    </span>
                  </div>
                  <label className={styles.switch}>
                    <input
                      type="checkbox"
                      checked={item.enabled}
                      onChange={() => toggleEnabled(item.id)}
                    />
                    <span className={styles.slider} />
                  </label>
                </div>

                <p className={styles.cardDescription}>{desc}</p>

                <div className={styles.cardFooter}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Icon name="lock" size={11} />
                    {locale === 'zh' ? '权限模式：' : 'Access: '}
                    <strong>
                      {item.permission === 'auto'
                        ? locale === 'zh' ? '自动' : 'Auto'
                        : item.permission === 'confirm'
                        ? locale === 'zh' ? '确认' : 'Ask'
                        : locale === 'zh' ? '禁用' : 'Deny'}
                    </strong>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleOpenConfig(item)}
                  >
                    {locale === 'zh' ? '配置' : 'Config'} →
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Real Tool Configuration Modal */}
      {editingItem && (
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
            width: 440,
            background: 'var(--oa-alias-bg-base)',
            border: '1px solid var(--oa-alias-border-l2)',
            borderRadius: 16,
            padding: 24,
            boxShadow: 'var(--oa-shadow-floating)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h2 style={{ fontSize: 16, margin: 0, color: 'var(--oa-alias-text-primary)' }}>
                {locale === 'zh' ? `配置能力：${editingItem.nameZh}` : `Configure: ${editingItem.nameEn}`}
              </h2>
              <span style={{ fontSize: 11, color: 'var(--oa-alias-text-caption)' }}>
                {locale === 'zh' ? editingItem.tagZh : editingItem.tagEn}
              </span>
            </div>

            <p style={{ fontSize: 12, color: 'var(--oa-alias-text-secondary)', margin: '0 0 16px', lineHeight: 1.4 }}>
              {locale === 'zh' ? editingItem.descZh : editingItem.descEn}
            </p>

            {/* Permission policy */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--oa-alias-text-primary)', display: 'block', marginBottom: 6 }}>
                {locale === 'zh' ? '授权策略' : 'Permission Policy'}
              </label>
              <div className={styles.toggleGroup} style={{ width: '100%', justifyContent: 'space-between' }}>
                <button
                  className={`${styles.toggleBtn} ${editPermission === 'auto' ? styles.toggleBtnActive : ''}`}
                  onClick={() => setEditPermission('auto')}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  {locale === 'zh' ? '自动执行' : 'Auto'}
                </button>
                <button
                  className={`${styles.toggleBtn} ${editPermission === 'confirm' ? styles.toggleBtnActive : ''}`}
                  onClick={() => setEditPermission('confirm')}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  {locale === 'zh' ? '人工确认' : 'Ask'}
                </button>
                <button
                  className={`${styles.toggleBtn} ${editPermission === 'deny' ? styles.toggleBtnActive : ''}`}
                  onClick={() => setEditPermission('deny')}
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  {locale === 'zh' ? '禁用拦截' : 'Deny'}
                </button>
              </div>
            </div>

            {/* Sandbox Paths */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--oa-alias-text-primary)', display: 'block', marginBottom: 6 }}>
                {locale === 'zh' ? '沙箱访问路径' : 'Sandbox Allowed Paths'}
              </label>
              <input
                type="text"
                value={editPaths}
                onChange={(e) => setEditPaths(e.target.value)}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--oa-alias-border-l2)',
                  background: 'var(--oa-alias-bg-layer-1)',
                  color: 'var(--oa-alias-text-primary)',
                  fontSize: 12.5,
                  boxSizing: 'border-box',
                  outline: 'none',
                }}
              />
            </div>

            {/* Timeout */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--oa-alias-text-primary)', display: 'block', marginBottom: 6 }}>
                {locale === 'zh' ? '执行超时限制 (秒)' : 'Execution Timeout (seconds)'}
              </label>
              <input
                type="number"
                value={editTimeout}
                onChange={(e) => setEditTimeout(parseInt(e.target.value) || 10)}
                min={5}
                max={300}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: 8,
                  border: '1px solid var(--oa-alias-border-l2)',
                  background: 'var(--oa-alias-bg-layer-1)',
                  color: 'var(--oa-alias-text-primary)',
                  fontSize: 12.5,
                  boxSizing: 'border-box',
                  outline: 'none',
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Button variant="secondary" size="sm" onClick={() => setEditingItem(null)}>
                {locale === 'zh' ? '取消' : 'Cancel'}
              </Button>
              <Button variant="primary" size="sm" onClick={handleSaveConfig}>
                {locale === 'zh' ? '保存配置' : 'Save Config'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add Custom Capability Modal */}
      {showAddModal && (
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
              {locale === 'zh' ? '接入新工具或 MCP 协议服务' : 'Add Tool / MCP Server'}
            </h2>
            <input
              type="text"
              placeholder={locale === 'zh' ? '能力名称 (例: MCP Postgres 数据库)' : 'Name (e.g. MCP Postgres)'}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
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
              placeholder={locale === 'zh' ? '功能描述与权限边界...' : 'Description & scope...'}
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
              <Button variant="secondary" size="sm" onClick={() => setShowAddModal(false)}>
                {locale === 'zh' ? '取消' : 'Cancel'}
              </Button>
              <Button variant="primary" size="sm" onClick={handleAddCapability} disabled={!newName.trim()}>
                {locale === 'zh' ? '确认接入' : 'Add'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CapabilitiesPage;
