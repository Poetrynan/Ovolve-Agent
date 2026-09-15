import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useBotStore } from '@store/botStore'
import type { PlatformStatus } from '@store/botStore'
import {
  Send, Bot, Globe, Radio, ExternalLink, Save, RefreshCw, CheckCircle2,
  XCircle, AlertTriangle, Eye, EyeOff, Copy, Check, MessageSquare, ShieldCheck, Lock,
} from 'lucide-react'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Card, CardContent, CardHeader } from '@components/ui/card'
import { ScrollArea } from '@components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@components/ui/dialog'
import { BrandIcon } from '@components/ui/BrandIcon'
import { ChannelsPanel } from '@components/bot/ChannelsPanel'
import { API_BASE } from '@lib/api'
import { cn } from '@/lib/utils'

/** Official API doc / credential page per platform. */
const PLATFORM_LINKS: Record<string, { label: string; url: string }> = {
  telegram: {
    label: '@BotFather',
    url: 'https://t.me/BotFather',
  },
  feishu: {
    label: '飞书开放平台',
    url: 'https://open.feishu.cn/app',
  },
  dingtalk: {
    label: '钉钉开放平台',
    url: 'https://open-dev.dingtalk.com/',
  },
  wecom: {
    label: '企业微信管理后台',
    url: 'https://work.weixin.qq.com/wework_admin/',
  },
  slack: {
    label: 'Slack API',
    url: 'https://api.slack.com/apps',
  },
  discord: {
    label: 'Discord Developer Portal',
    url: 'https://discord.com/developers/applications',
  },
}

/** What fields each platform needs + placeholder hints. */
const PLATFORM_FIELDS: Record<string, { key: string; label: string; secret?: boolean; placeholder: string; hint?: string; colSpan?: number }[]> = {
  telegram: [
    { key: 'bot_token', label: 'Bot Token', secret: true, placeholder: '123456:ABC-DEF1234...' },
    { key: 'allowed_users', label: '允许的用户 ID（逗号分隔）', placeholder: '123456789, 987654321' },
  ],
  feishu: [
    { key: 'app_id', label: 'App ID', placeholder: 'cli_xxxxx' },
    { key: 'app_secret', label: 'App Secret', secret: true, placeholder: '••••••••••••••••' },
    { key: 'encrypt_key', label: 'Encrypt Key', secret: true, placeholder: '事件订阅验证 Key' },
    { key: 'verification_token', label: 'Verification Token', placeholder: '验证 Token' },
    { key: 'allowed_users', label: '允许的 Open ID（逗号分隔）', placeholder: 'ou_xxxxx, ou_yyyyy', colSpan: 2 },
  ],
  dingtalk: [
    { key: 'webhook', label: '自定义机器人 Webhook', secret: true, placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...', hint: 'botPage.hint.dingtalkWebhook', colSpan: 2 },
    { key: 'secret', label: '加签 Secret（发送加签）', secret: true, placeholder: 'SEC...' },
    { key: 'app_secret', label: 'App Secret（接收回调验签）', secret: true, placeholder: '', hint: 'botPage.hint.dingtalkAppSecret' },
    { key: 'allowed_users', label: '允许的 staffId（逗号分隔）', placeholder: 'staff1, staff2', colSpan: 2 },
  ],
  wecom: [
    { key: 'webhook_key', label: '群机器人 Webhook Key', secret: true, placeholder: '693a91f6-...', hint: 'botPage.hint.wecomWebhookKey' },
    { key: 'corp_id', label: 'CorpID（企业 ID）', placeholder: 'wwxxxxxx' },
    { key: 'app_secret', label: '应用 Secret', secret: true, placeholder: '••••••••••••••••' },
    { key: 'agent_id', label: 'AgentId', placeholder: '1000002' },
    { key: 'callback_token', label: '回调 Token', secret: true, placeholder: '接收消息用', hint: 'botPage.hint.wecomCallback' },
    { key: 'encoding_aes_key', label: 'EncodingAESKey', secret: true, placeholder: '43 位 AES 密钥' },
    { key: 'allowed_users', label: '允许的成员 UserID（逗号分隔）', placeholder: 'zhangsan, lisi', colSpan: 2 },
  ],
  slack: [
    { key: 'bot_token', label: 'Bot Token (xoxb-)', secret: true, placeholder: 'xoxb-...' },
    { key: 'app_token', label: 'App-Level Token (xapp-)', secret: true, placeholder: 'xapp-...', hint: 'botPage.hint.slackAppToken' },
    { key: 'allowed_users', label: '允许的用户 ID（逗号分隔）', placeholder: 'U01ABCDEF', colSpan: 2 },
  ],
  discord: [
    { key: 'bot_token', label: 'Bot Token', secret: true, placeholder: 'OTk...' },
    { key: 'allowed_users', label: '允许的用户 ID（逗号分隔）', placeholder: '123456789012345678' },
  ],
}

/** Webhook / event subscription path relative to API_BASE. */
const PLATFORM_CALLBACK: Record<string, string> = {
  feishu: '/api/bot/feishu/events',
  dingtalk: '/api/bot/dingtalk/callback',
  wecom: '/api/bot/wecom/callback',
}

function StatusPill({ status }: { status?: PlatformStatus }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-muted text-[11px] text-muted-foreground border border-border/40">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" /> 未知
      </span>
    )
  }
  if (status.listening) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-emerald-500/15 text-[11px] text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 font-medium">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> 运行监听中
      </span>
    )
  }
  if (status.configured) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-amber-500/15 text-[11px] text-amber-600 dark:text-amber-400 border border-amber-500/30 font-medium">
        <AlertTriangle className="w-3 h-3" /> 已配置 (待启动)
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-muted/60 text-[11px] text-muted-foreground border border-border/40">
      <XCircle className="w-3 h-3" /> 未配置凭据
    </span>
  )
}

function openExternal(url: string) {
  const api = (window as any)?.electronAPI
  if (api?.isElectron && typeof api.invoke === 'function') {
    api.invoke('system:openExternal', url).catch(() => window.open(url, '_blank'))
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

interface ConfigEditorProps {
  platform: string
  status?: PlatformStatus
}

function ConfigEditor({ platform, status }: ConfigEditorProps) {
  const { t } = useTranslation()
  const { config, fetchConfig, saveConfig, savingConfig } = useBotStore()
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  const [savedTick, setSavedTick] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void fetchConfig(platform)
  }, [platform, fetchConfig])

  useEffect(() => {
    const seed: Record<string, string> = {}
    for (const f of PLATFORM_FIELDS[platform] || []) {
      const v = (config as any)[f.key]
      seed[f.key] = Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)
    }
    setDraft(seed)
  }, [config, platform])

  const fields = PLATFORM_FIELDS[platform] || []
  const link = PLATFORM_LINKS[platform]
  const callbackPath = PLATFORM_CALLBACK[platform]
  const callbackUrl = callbackPath ? `${API_BASE}${callbackPath}` : ''

  const copyCallback = useCallback(() => {
    navigator.clipboard?.writeText(callbackUrl).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  }, [callbackUrl])

  const onSave = useCallback(async () => {
    const patch: Record<string, any> = { ...draft }
    if (typeof patch.allowed_users === 'string') {
      patch.allowed_users = patch.allowed_users
        .split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
    }
    const ok = await saveConfig(platform, patch)
    if (ok) {
      setSavedTick(true)
      setTimeout(() => setSavedTick(false), 1500)
      await fetchConfig(platform)
    }
  }, [draft, platform, saveConfig, fetchConfig])

  return (
    <div className="space-y-5">
      {/* Header bar: Platform Identity + Status + Official Portal Link */}
      <div className="flex items-center justify-between pb-3 border-b border-border/40">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-1.5 rounded-xl bg-card border border-border/50 shadow-2xs">
            <BrandIcon platform={platform} size={20} className="shrink-0" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-foreground capitalize">{platform}</span>
              <StatusPill status={status} />
            </div>
          </div>
        </div>

        {link && (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground rounded-xl border-border/50 bg-background/50 shadow-2xs"
            onClick={() => openExternal(link.url)}
          >
            <ExternalLink className="w-3.5 h-3.5 text-foreground/80" />
            <span>{link.label}</span>
            <span className="text-[10px] text-muted-foreground/70 hidden sm:inline">· 获取凭据</span>
          </Button>
        )}
      </div>

      {/* Structured Left-Label Right-Input Setting Group */}
      <div className="divide-y divide-border/30 rounded-xl border border-border/40 bg-background/40 overflow-hidden">
        {fields.map((f) => {
          const isSecret = !!f.secret
          const revealed = !!reveal[f.key]
          return (
            <div
              key={f.key}
              className="flex flex-col sm:flex-row sm:items-center justify-between p-3.5 sm:px-4.5 gap-3 hover:bg-muted/20 transition-colors"
            >
              <div className="space-y-0.5 max-w-sm">
                <div className="flex items-center gap-2">
                  <label className="text-xs font-bold text-foreground">
                    {f.label}
                  </label>
                  {isSecret && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 font-mono border border-border/30">
                      加密
                    </span>
                  )}
                </div>
                {f.hint && (
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {t(f.hint)}
                  </p>
                )}
              </div>

              <div className="relative w-full sm:w-80 shrink-0">
                <Input
                  type={isSecret && !revealed ? 'password' : 'text'}
                  value={draft[f.key] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="rounded-lg bg-background border-border/50 text-xs font-mono pr-8 h-9"
                />
                {isSecret && (
                  <button
                    type="button"
                    onClick={() => setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-1"
                    aria-label={revealed ? 'Hide' : 'Show'}
                  >
                    {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {/* Callback Webhook URL row */}
        {callbackPath && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between p-3.5 sm:px-4.5 gap-3 hover:bg-muted/20 transition-colors">
            <div className="space-y-0.5 max-w-sm">
              <div className="flex items-center gap-2">
                <label className="text-xs font-bold text-foreground">
                  {t('botPage.callbackUrl')}
                </label>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/70 font-mono border border-border/30">
                  公网回调
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {t('botPage.callbackHint')}
              </p>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-80 shrink-0">
              <Input
                readOnly
                value={callbackUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="rounded-lg bg-muted/40 border-border/50 text-xs font-mono h-9 flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={copyCallback}
                aria-label={t('botPage.copy')}
                title={t('botPage.copy')}
                className="h-9 px-3 shrink-0 rounded-lg border-border/50 bg-background/60 shadow-2xs font-semibold text-xs"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-500 mr-1" />
                    <span className="text-emerald-600 dark:text-emerald-400">已复制</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-muted-foreground mr-1" />
                    <span>复制</span>
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Allow-list warning */}
      {status?.configured && status.allowedUsers === 0 && (
        <div className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-2 bg-amber-500/10 p-3 rounded-xl border border-amber-500/20">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
          <span className="leading-relaxed">{t('botPage.emptyAllowList')}</span>
        </div>
      )}

      {/* Footer Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t border-border/40 mt-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0" />
          <span>
            {status && !status.listening && status.configured
              ? '凭据更新后需重启后端服务以激活监听'
              : '凭据经由本地加密沙箱隔离存储，仅用于对接平台鉴权'}
          </span>
        </div>

        <Button
          size="sm"
          onClick={onSave}
          disabled={savingConfig}
          className="rounded-xl px-6 h-10 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-xs select-none transition-all self-end sm:self-center shrink-0"
        >
          {savingConfig ? (
            <RefreshCw className="w-3.5 h-3.5 mr-2 animate-spin" />
          ) : savedTick ? (
            <CheckCircle2 className="w-3.5 h-3.5 mr-2 text-emerald-500" />
          ) : (
            <Save className="w-3.5 h-3.5 mr-2" />
          )}
          {savedTick ? '已保存凭据' : '保存凭据'}
        </Button>
      </div>
    </div>
  )
}

export default function BotPage() {
  const { t } = useTranslation()
  const {
    messages, platform, userId, sendError,
    setPlatform, setUserId, fetchMessages, fetchStatuses, sendMessage, statuses,
  } = useBotStore()
  const [input, setInput] = useState('')
  const [testModalOpen, setTestModalOpen] = useState(false)

  useEffect(() => {
    void fetchMessages()
    void fetchStatuses()
  }, [fetchMessages, fetchStatuses])

  useEffect(() => {
    void fetchMessages()
  }, [platform, userId, fetchMessages])

  const platforms = [
    { id: 'telegram', label: 'Telegram' },
    { id: 'feishu', label: '飞书 / Lark' },
    { id: 'dingtalk', label: '钉钉' },
    { id: 'wecom', label: '企业微信' },
    { id: 'slack', label: 'Slack' },
    { id: 'discord', label: 'Discord' },
  ]

  const currentStatus = statuses.find((s) => s.platform === platform)
  const currentPlatformObj = platforms.find((p) => p.id === platform)

  const handleSend = () => {
    if (!input.trim()) return
    void sendMessage(input)
    setInput('')
    setTestModalOpen(false)
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl space-y-8 animate-fade-in">
      {/* Standard Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-border/40">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-foreground/10 text-foreground border border-border/40 shadow-xs">
              <Bot size={22} className="stroke-[2.2]" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-heading font-extrabold tracking-tight text-foreground">
              {t('botPage.title')}
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 ml-1">
            {t('botPage.subtitle')}
          </p>
        </div>
      </div>

      {/* Platform tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {platforms.map((p) => {
          const isCurrent = platform === p.id
          const st = statuses.find((s) => s.platform === p.id)
          return (
            <button
              key={p.id}
              onClick={() => setPlatform(p.id)}
              className={cn(
                'px-4 py-2 rounded-xl text-xs font-bold border shrink-0 whitespace-nowrap flex items-center gap-2.5 select-none transition-all shadow-2xs',
                isCurrent
                  ? 'bg-card border-foreground/40 text-foreground shadow-xs'
                  : 'bg-card/70 text-muted-foreground border-border/50 hover:bg-card hover:text-foreground',
              )}
            >
              <BrandIcon platform={p.id} size={16} className="shrink-0" />
              <span>{p.label}</span>
              {st?.listening && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse ml-0.5" />}
            </button>
          )
        })}
      </div>

      {/* Platform Config Form Card */}
      <Card className="rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md overflow-hidden shadow-xs">
        <CardContent className="p-5 sm:p-7">
          <ConfigEditor platform={platform} status={currentStatus} />
        </CardContent>
      </Card>

      {/* 外部消息接入（通用 Webhook 渠道）——厂商机器人之外的第二条接入路径 */}
      <ChannelsPanel />

      {/* Message log with Send Test Action */}
      <Card className="rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md shadow-xs overflow-hidden">
        <div className="px-5 py-3.5 border-b border-border/40 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-foreground/70" />
            <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">
              {t('botPage.logsTitle', { count: messages.length })}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => setTestModalOpen(true)}
              className="h-8 px-3 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 rounded-xl shadow-xs select-none gap-1.5"
            >
              <Radio className="w-3.5 h-3.5" />
              <span>{t('botPage.sendTestSection')}</span>
            </Button>
            <Button
              size="sm" variant="ghost"
              onClick={() => fetchMessages()}
              className="h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground rounded-xl"
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> {t('botPage.refresh')}
            </Button>
          </div>
        </div>
        <CardContent className="p-4">
          <ScrollArea className="h-80">
            <div className="space-y-2.5 pr-3">
              {messages.length === 0 ? (
                <div className="text-center py-16 text-muted-foreground space-y-2">
                  <Globe className="w-8 h-8 mx-auto opacity-30" />
                  <p className="text-xs">{t('botPage.emptyLogs')}</p>
                </div>
              ) : (
                messages.map((msg, i) => {
                  const isOut = msg.direction === 'outbound'
                  return (
                    <div
                      key={msg.id || i}
                      className={cn(
                        'p-3.5 rounded-2xl text-xs max-w-xl transition-all',
                        isOut
                          ? 'ml-auto bg-foreground text-background rounded-br-xs shadow-xs'
                          : 'mr-auto bg-muted/80 text-foreground border border-border/40 rounded-bl-xs',
                      )}
                    >
                      <div className="flex items-center justify-between gap-4 mb-1 opacity-75 text-[10px]">
                        <span>{isOut ? t('botPage.localSent') : t('botPage.remoteReceived')}</span>
                        <span className="font-mono">{msg.platform || platform}</span>
                      </div>
                      <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                    </div>
                  )
                })
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Test Message Modal Dialog — Zero Wasted Space */}
      <Dialog open={testModalOpen} onOpenChange={setTestModalOpen}>
        <DialogContent className="max-w-md rounded-2xl border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl p-6 space-y-4">
          <DialogHeader className="space-y-1">
            <div className="flex items-center gap-2">
              <Radio className="w-5 h-5 text-foreground" />
              <DialogTitle className="text-base font-bold text-foreground">
                向 {currentPlatformObj?.label || platform} 推送测试消息
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-muted-foreground">
              验证机器人的出站投递能力与网络连通性。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground">接收方用户 ID / 群 ID</label>
              <Input
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder={t('botPage.receiverPlaceholder')}
                className="rounded-xl bg-background/80 border-border/50 text-xs font-mono h-9.5"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground">测试消息正文</label>
              <Input
                autoFocus
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t('botPage.messagePlaceholder')}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                className="rounded-xl bg-background/80 border-border/50 text-sm h-10"
              />
            </div>

            {sendError && (
              <p className="text-xs text-rose-500 flex items-center gap-1.5 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20">
                <XCircle className="w-4 h-4 shrink-0" />
                <span>{sendError}</span>
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2 border-t border-border/30">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTestModalOpen(false)}
              className="rounded-xl h-9 px-4 text-xs"
            >
              取消
            </Button>
            <Button
              onClick={handleSend}
              disabled={!input.trim()}
              className="rounded-xl h-9 px-5 font-semibold text-xs bg-foreground text-background hover:bg-foreground/90 shadow-xs select-none"
            >
              <Send className="h-3.5 w-3.5 mr-1.5" /> {t('botPage.send')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
