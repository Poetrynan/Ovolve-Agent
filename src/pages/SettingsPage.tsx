import React from 'react';
import { Icon } from '../components/ui/Icon';
import { Button } from '../components/ui/button';
import { useI18n, useThemeStore, useSettingsStore } from '../store';
import styles from './Pages.module.css';

export function SettingsPage({
  onBackToChat,
}: {
  onBackToChat?: () => void;
}) {
  const { locale, setLocale } = useI18n();
  const {
    mode,
    setMode,
  } = useThemeStore();

  const {
    apiKey,
    baseUrl,
    temperature,
    confirmRiskyCommands,
    sandboxIsolation,
    cacheSemanticEnabled,
    cacheSemanticThreshold,
    cacheAttentionSinkEnabled,
    cacheAttentionSinkKeepFirst,
    cacheAttentionSinkKeepRecent,
    cachePromptEnabled,
    cachePromptPrefixTurns,
    setApiKey,
    setBaseUrl,
    setTemperature,
    setConfirmRiskyCommands,
    setSandboxIsolation,
    setCacheSemanticEnabled,
    setCacheSemanticThreshold,
    setCacheAttentionSinkEnabled,
    setCacheAttentionSinkKeepFirst,
    setCacheAttentionSinkKeepRecent,
    setCachePromptEnabled,
    setCachePromptPrefixTurns,
    saveSettings,
  } = useSettingsStore();

  const [savedToast, setSavedToast] = React.useState(false);

  const handleSave = () => {
    saveSettings();
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 2000);
  };

  return (
    <div className={styles.pageContainer}>
      {/* Header */}
      <div className={styles.pageHeader}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>
            <Icon name="settings" size={20} />
          </div>
          <div>
            <h1 className={styles.pageTitle}>{locale === 'zh' ? '偏好设置' : 'Preferences & Settings'}</h1>
            <p className={styles.pageSubtitle}>
              {locale === 'zh' ? '配置大模型供应商、推理参数、安全权限与界面外观' : 'Configure model providers, parameters, safeguards and appearance'}
            </p>
          </div>
        </div>
        <div className={styles.headerActions}>
          {onBackToChat && (
            <Button variant="secondary" size="md" onClick={onBackToChat} icon={<Icon name="chat" size={15} />}>
              {locale === 'zh' ? '返回会话' : 'Back to Chat'}
            </Button>
          )}
          <Button variant="primary" size="md" icon={<Icon name="check" size={15} />} onClick={handleSave}>
            {savedToast ? (locale === 'zh' ? '已保存 ✔' : 'Saved ✔') : (locale === 'zh' ? '保存更改' : 'Save Changes')}
          </Button>
        </div>
      </div>

      {/* General Settings */}
      <div className={styles.settingsSection}>
        <h2 className={styles.sectionTitle}>{locale === 'zh' ? '通用与外观' : 'General & Appearance'}</h2>
        <p className={styles.sectionSubtitle}>{locale === 'zh' ? '管理语言与外观模式' : 'Manage language and display mode'}</p>

        <div className={styles.formGroup}>
          <div className={styles.formLabel}>
            <span className={styles.formTitle}>{locale === 'zh' ? '界面语言' : 'Display Language'}</span>
            <span className={styles.formDesc}>{locale === 'zh' ? '选择客户端界面的默认显示语言' : 'Select client UI display language'}</span>
          </div>
          <div className={styles.formControl}>
            <div className={styles.toggleGroup}>
              <button
                className={`${styles.toggleBtn} ${locale === 'zh' ? styles.toggleBtnActive : ''}`}
                onClick={() => setLocale('zh')}
              >
                简体中文
              </button>
              <button
                className={`${styles.toggleBtn} ${locale === 'en' ? styles.toggleBtnActive : ''}`}
                onClick={() => setLocale('en')}
              >
                English
              </button>
            </div>
          </div>
        </div>

        <div className={styles.formGroup}>
          <div className={styles.formLabel}>
            <span className={styles.formTitle}>{locale === 'zh' ? '主题模式' : 'Theme Mode'}</span>
            <span className={styles.formDesc}>{locale === 'zh' ? '浅色模式、深色模式或自动跟随操作系统' : 'Light mode, dark mode or follow system theme'}</span>
          </div>
          <div className={styles.formControl}>
            <div className={styles.toggleGroup}>
              <button
                className={`${styles.toggleBtn} ${mode === 'light' ? styles.toggleBtnActive : ''}`}
                onClick={() => setMode('light')}
              >
                <Icon name="sun" size={14} />
                {locale === 'zh' ? '浅色' : 'Light'}
              </button>
              <button
                className={`${styles.toggleBtn} ${mode === 'dark' ? styles.toggleBtnActive : ''}`}
                onClick={() => setMode('dark')}
              >
                <Icon name="moon" size={14} />
                {locale === 'zh' ? '深色' : 'Dark'}
              </button>
              <button
                className={`${styles.toggleBtn} ${mode === 'system' ? styles.toggleBtnActive : ''}`}
                onClick={() => setMode('system')}
              >
                <Icon name="monitor" size={14} />
                {locale === 'zh' ? '跟随系统' : 'System'}
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* Model & Providers */}
      <div className={styles.settingsSection}>
        <h2 className={styles.sectionTitle}>{locale === 'zh' ? '推理模型引擎' : 'Model Providers'}</h2>
        <p className={styles.sectionSubtitle}>{locale === 'zh' ? '配置 API Key 鉴权凭据与 Endpoint 代理地址' : 'Manage API credentials and endpoint URLs'}</p>

        <div className={styles.formGroup}>
          <div className={styles.formLabel}>
            <span className={styles.formTitle}>{locale === 'zh' ? 'DeepSeek API 密钥' : 'DeepSeek API Key'}</span>
            <span className={styles.formDesc}>{locale === 'zh' ? '驱动 DeepSeek-R1 深度推理与 V3 通用编程模型' : 'Powers DeepSeek-R1 and V3 reasoning models'}</span>
          </div>
          <div className={styles.formControl}>
            <input
              type="password"
              className={styles.formInput}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
            />
          </div>
        </div>

        <div className={styles.formGroup}>
          <div className={styles.formLabel}>
            <span className={styles.formTitle}>{locale === 'zh' ? '接口请求地址' : 'API Base URL'}</span>
            <span className={styles.formDesc}>{locale === 'zh' ? '兼容 OpenAI / DeepSeek 标准接口地址' : 'Compatible with OpenAI-standard endpoint'}</span>
          </div>
          <div className={styles.formControl}>
            <input
              type="text"
              className={styles.formInput}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
        </div>

        <div className={styles.formGroup}>
          <div className={styles.formLabel}>
            <span className={styles.formTitle}>{locale === 'zh' ? '采样温度 (Temperature)' : 'Default Temperature'}</span>
            <span className={styles.formDesc}>{locale === 'zh' ? '编程与数学任务建议 0.0 - 0.3，创意发散任务建议 0.7' : '0.0 - 0.3 for coding/math, 0.7 for creative tasks'}</span>
          </div>
          <div className={styles.formControl}>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              className={styles.formInput}
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value) || 0)}
            />
          </div>
        </div>
      </div>

      {/* Security & Permissions */}
      <div className={styles.settingsSection}>
        <h2 className={styles.sectionTitle}>{locale === 'zh' ? '安全守卫与权限' : 'Security & Permissions'}</h2>
        <p className={styles.sectionSubtitle}>{locale === 'zh' ? '设置危险 Shell 命令拦截与沙箱目录隔离' : 'Control execution safeguards and prompt injections'}</p>

        <div className={styles.formGroup}>
          <div className={styles.formLabel}>
            <span className={styles.formTitle}>{locale === 'zh' ? '高危 Shell 指令确认' : 'Confirm Risky Shell Commands'}</span>
            <span className={styles.formDesc}>{locale === 'zh' ? '在执行 rm -rf、git reset --hard 等破坏性命令前主动弹窗确认' : 'Prompt before executing destructive commands'}</span>
          </div>
          <label className={styles.switch}>
            <input
              type="checkbox"
              checked={confirmRiskyCommands}
              onChange={(e) => setConfirmRiskyCommands(e.target.checked)}
            />
            <span className={styles.slider} />
          </label>
        </div>

        <div className={styles.formGroup}>
          <div className={styles.formLabel}>
            <span className={styles.formTitle}>{locale === 'zh' ? '工作区沙箱路径限制' : 'Workspace Sandbox Isolation'}</span>
            <span className={styles.formDesc}>{locale === 'zh' ? '严格禁止智能体读写当前打开项目目录之外的文件' : 'Prevent access to paths outside active workspace'}</span>
          </div>
          <label className={styles.switch}>
            <input
              type="checkbox"
              checked={sandboxIsolation}
              onChange={(e) => setSandboxIsolation(e.target.checked)}
            />
            <span className={styles.slider} />
          </label>
        </div>
      </div>

      {/* Cache & Performance */}
      <div className={styles.settingsSection}>
        <h2 className={styles.sectionTitle}>
          {locale === 'zh' ? '缓存与性能' : 'Cache & Performance'}
        </h2>
        <p className={styles.sectionSubtitle}>
          {locale === 'zh' ? '优化缓存命中率，减少 Token 消耗与响应延迟' : 'Optimize cache hit rate, reduce token usage and latency'}
        </p>

        {/* Semantic Embedding Cache */}
        <div className={styles.formGroup}>
          <div className={styles.formLabel}>
            <span className={styles.formTitle}>
              {locale === 'zh' ? '语义嵌入缓存' : 'Semantic Embedding Cache'}
              <span className={styles.helpIcon} title={locale === 'zh' ? '通过向量相似度匹配已计算的嵌入，避免重复计算相似内容的嵌入向量，显著降低embedding计算开销' : 'Matches previously computed embeddings by vector similarity, avoiding redundant embedding computations for similar content, significantly reducing embedding overhead'}>
                <Icon name="help" size={12} />
              </span>
            </span>
            <span className={styles.formDesc}>
              {locale === 'zh' ? '基于向量相似度的模糊匹配缓存' : 'Fuzzy matching cache based on vector similarity'}
            </span>
          </div>
          <label className={styles.switch}>
            <input
              type="checkbox"
              checked={cacheSemanticEnabled}
              onChange={(e) => setCacheSemanticEnabled(e.target.checked)}
            />
            <span className={styles.slider} />
          </label>
        </div>

        {cacheSemanticEnabled && (
          <div className={styles.formGroup}>
            <div className={styles.formLabel}>
              <span className={styles.formTitle}>
                {locale === 'zh' ? '相似度阈值' : 'Similarity Threshold'}
                <span className={styles.helpIcon} title={locale === 'zh' ? '决定两个嵌入向量被视为"相似"的最小值。阈值越高匹配越严格（推荐0.85），过低可能返回不相关结果' : 'Minimum value for two embedding vectors to be considered similar. Higher = stricter matching (0.85 recommended), too low may return unrelated results'}>
                  <Icon name="help" size={12} />
                </span>
              </span>
              <span className={styles.formDesc}>
                {locale === 'zh' ? '越高匹配越严格' : 'Higher = stricter matching'}
              </span>
            </div>
            <div className={styles.formControl}>
              <input
                type="range"
                min="0.5"
                max="0.99"
                step="0.05"
                value={cacheSemanticThreshold}
                onChange={(e) => setCacheSemanticThreshold(parseFloat(e.target.value))}
                className={styles.formInput}
              />
              <span className={styles.formValue}>{(cacheSemanticThreshold * 100).toFixed(0)}%</span>
            </div>
          </div>
        )}

        {/* Attention Sink */}
        <div className={styles.formGroup}>
          <div className={styles.formLabel}>
            <span className={styles.formTitle}>
              {locale === 'zh' ? '注意力锚点保留' : 'Attention Sink'}
              <span className={styles.helpIcon} title={locale === 'zh' ? 'LLM对对话开头和结尾的关注度最高（U型曲线）。启用后，折叠时会保留开头（系统提示）和结尾（最近消息）不被压缩，避免丢失关键上下文' : 'LLMs pay most attention to the beginning and end of conversations (U-shaped curve). When enabled, preserves the start (system prompt) and end (recent messages) from being compressed during folding, avoiding loss of critical context'}>
                <Icon name="help" size={12} />
              </span>
            </span>
            <span className={styles.formDesc}>
              {locale === 'zh' ? '折叠时保留开头和结尾消息' : 'Preserve first and last messages when folding'}
            </span>
          </div>
          <label className={styles.switch}>
            <input
              type="checkbox"
              checked={cacheAttentionSinkEnabled}
              onChange={(e) => setCacheAttentionSinkEnabled(e.target.checked)}
            />
            <span className={styles.slider} />
          </label>
        </div>

        {cacheAttentionSinkEnabled && (
          <>
            <div className={styles.formGroup}>
              <div className={styles.formLabel}>
                <span className={styles.formTitle}>
                  {locale === 'zh' ? '保留开头消息数' : 'Keep First Messages'}
                  <span className={styles.helpIcon} title={locale === 'zh' ? '对话开头的消息数量，通常包含系统提示和初始任务描述。这些消息对模型理解任务至关重要' : 'Number of messages at the start of conversation, typically containing system prompt and initial task description. These are critical for model to understand the task'}>
                    <Icon name="help" size={12} />
                  </span>
                </span>
                <span className={styles.formDesc}>
                  {locale === 'zh' ? '系统提示和初始上下文' : 'System prompt and initial context'}
                </span>
              </div>
              <div className={styles.formControl}>
                <input
                  type="number"
                  min="0"
                  max="10"
                  value={cacheAttentionSinkKeepFirst}
                  onChange={(e) => setCacheAttentionSinkKeepFirst(parseInt(e.target.value) || 0)}
                  className={styles.formInput}
                />
              </div>
            </div>
            <div className={styles.formGroup}>
              <div className={styles.formLabel}>
                <span className={styles.formTitle}>
                  {locale === 'zh' ? '保留最近消息数' : 'Keep Recent Messages'}
                  <span className={styles.helpIcon} title={locale === 'zh' ? '保留最近N条消息不被压缩，确保模型能看到最新的对话上下文和工具调用结果' : 'Keep the most recent N messages from being compressed, ensuring the model can see the latest conversation context and tool call results'}>
                    <Icon name="help" size={12} />
                  </span>
                </span>
                <span className={styles.formDesc}>
                  {locale === 'zh' ? '最近的对话轮次' : 'Recent conversation turns'}
                </span>
              </div>
              <div className={styles.formControl}>
                <input
                  type="number"
                  min="2"
                  max="20"
                  value={cacheAttentionSinkKeepRecent}
                  onChange={(e) => setCacheAttentionSinkKeepRecent(parseInt(e.target.value) || 4)}
                  className={styles.formInput}
                />
              </div>
            </div>
          </>
        )}

        {/* Prompt Prefix Cache */}
        <div className={styles.formGroup}>
          <div className={styles.formLabel}>
            <span className={styles.formTitle}>
              {locale === 'zh' ? '提示前缀缓存' : 'Prompt Prefix Cache'}
              <span className={styles.helpIcon} title={locale === 'zh' ? '将系统提示和早期对话标记为可缓存，LLM服务商会复用已计算的KV Cache，显著降低重复请求的成本和延迟' : 'Marks system prompt and early conversation as cacheable. LLM providers reuse already computed KV Cache, significantly reducing cost and latency for repeated requests'}>
                <Icon name="help" size={12} />
              </span>
            </span>
            <span className={styles.formDesc}>
              {locale === 'zh' ? '复用系统提示的 KV Cache，降低成本' : 'Reuse KV cache for system prompt, reduce cost'}
            </span>
          </div>
          <label className={styles.switch}>
            <input
              type="checkbox"
              checked={cachePromptEnabled}
              onChange={(e) => setCachePromptEnabled(e.target.checked)}
            />
            <span className={styles.slider} />
          </label>
        </div>

        {cachePromptEnabled && (
          <div className={styles.formGroup}>
            <div className={styles.formLabel}>
              <span className={styles.formTitle}>
                {locale === 'zh' ? '前缀对话轮数' : 'Prefix Conversation Turns'}
                <span className={styles.helpIcon} title={locale === 'zh' ? '早期对话轮次纳入缓存的数量。这些轮次通常变化较小，适合缓存复用。增加轮数可提高缓存命中率，但占用更多缓存空间' : 'Number of early conversation turns to include in cache. These turns typically change less and are suitable for cache reuse. More turns = higher hit rate but uses more cache space'}>
                  <Icon name="help" size={12} />
                </span>
              </span>
              <span className={styles.formDesc}>
                {locale === 'zh' ? '纳入缓存的早期对话轮数' : 'Early conversation turns to include in cache'}
              </span>
            </div>
            <div className={styles.formControl}>
              <input
                type="number"
                min="1"
                max="10"
                value={cachePromptPrefixTurns}
                onChange={(e) => setCachePromptPrefixTurns(parseInt(e.target.value) || 3)}
                className={styles.formInput}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SettingsPage;
