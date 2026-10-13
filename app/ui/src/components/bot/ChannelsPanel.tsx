// src/components/bot/ChannelsPanel.tsx
// 外部消息接入 —— 通用 Webhook 渠道管理面板。
//
// 产品定位：厂商机器人（飞书/钉钉/企微…）之外的第二条接入路径——任何能发出站
// Webhook 的系统，按开放约定接入。文案原则：不出现 HMAC/签名/重放这类词，
// 全部翻译成"来源可信 / 先审后办 / 已加密保存"这类用户视角的说法。
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Webhook, Plus, Trash2, KeyRound, ShieldCheck, Inbox, Loader2,
  ChevronDown, Lock, ExternalLink, AlertTriangle,
} from 'lucide-react'
import { Card, CardContent } from '@components/ui/card'
import { Input } from '@components/ui/input'
import { Button } from '@components/ui/button'
import { cn } from '@/lib/utils'
import {
  listChannels, upsertChannel, removeChannel,
  type ChannelInfo,
} from '@lib/channelsApi'

type HandleMode = 'untrusted' | 'trusted'

/** 处理方式两档的人话解释——选档时用户最需要的是"后果"而不是机制。 */
const MODE_META: Record<HandleMode, { label: string; hint: string }> = {
  untrusted: {
    label: '先审后办',
    hint: '每条消息先进入待处理列表，由你逐条放行。适合第一次接入、还不放心的机器人。',
  },
  trusted: {
    label: '自动执行',
    hint: '消息直接开始处理，不再逐条询问。只建议给完全可信、且在网络内的机器人。',
  },
}

interface DraftState {
  id: string
  secret: string
  mode: HandleMode
  replyUrl: string
  session: string
}

const EMPTY_DRAFT: DraftState = { id: '', secret: '', mode: 'untrusted', replyUrl: '', session: '' }

export function ChannelsPanel() {
  const { t } = useTranslation()
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT)
  const [showSecret, setShowSecret] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError('')
      const res = await listChannels()
      setChannels(res.channels || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const startAdd = () => {
    setDraft(EMPTY_DRAFT)
    setEditingId('__new__')
    setAdding(true)
    setFormError('')
    setShowSecret(false)
  }

  const startEdit = (c: ChannelInfo) => {
    setDraft({
      id: c.id, secret: '', mode: c.trust, replyUrl: c.replyUrl || '', session: c.session || '',
    })
    setEditingId(c.id)
    setAdding(false)
    setFormError('')
    setShowSecret(false)
  }

  const cancelForm = () => {
    setAdding(false)
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setFormError('')
  }

  const save = async () => {
    const id = draft.id.trim()
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
      setFormError(t('botPage.channels.errId', '名称只能用小写字母、数字和短横线（最多 40 个字符）'))
      return
    }
    const isEdit = editingId && editingId !== '__new__'
    // 新建必须有密钥；编辑留空 = 沿用原密钥（后端对已存在渠道保留原密封值）
    if (!draft.secret.trim() && !isEdit) {
      setFormError(t('botPage.channels.errSecret', '请设置一个连接密钥——对方发消息时要靠它证明身份'))
      return
    }
    setSaving(true)
    setFormError('')
    try {
      await upsertChannel({
        id,
        secret: draft.secret.trim(),
        trust: draft.mode,
        enabled: true,
        replyUrl: draft.replyUrl.trim() || undefined,
        session: draft.session.trim() || undefined,
      })
      cancelForm()
      await refresh()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (c: ChannelInfo) => {
    try {
      // 启停不带密钥：后端对已存在渠道保留原密钥
      await upsertChannel({
        id: c.id,
        secret: '',
        trust: c.trust,
        enabled: !c.enabled,
        replyUrl: c.replyUrl || undefined,
        session: c.session || undefined,
      })
      await refresh()
    } catch {
      /* 静默失败可接受：列表会刷新出真实状态 */
    }
  }

  const doDelete = async (id: string) => {
    setConfirmDelete(null)
    try {
      await removeChannel(id)
      await refresh()
    } catch {
      /* 同上 */
    }
  }

  return (
    <Card className="rounded-2xl border border-border/50 bg-card/70 backdrop-blur-md shadow-xs overflow-hidden">
      <div className="px-5 py-3.5 border-b border-border/40 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Webhook className="w-4 h-4 text-foreground/70" />
          <h3 className="text-xs font-bold text-foreground uppercase tracking-wider">
            {t('botPage.channels.title', '外部消息接入')}
          </h3>
          <span className="text-[10px] text-muted-foreground/60">
            {t('botPage.channels.count', '{{n}} 个渠道', { n: channels.length })}
          </span>
        </div>
        {!adding && (
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={startAdd}>
            <Plus size={13} />
            {t('botPage.channels.add', '新建接入')}
          </Button>
        )}
      </div>

      <CardContent className="p-5 sm:p-6 space-y-4">
        {/* 面板说明——解释价值与安全承诺，不出现任何协议名词 */}
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t('botPage.channels.desc',
            '把你的聊天工具接进来：任何能对外发送消息的机器人都能接入 Ovolve。'
            + '每条消息都会先验证来源身份，全部处理过程自动留痕。')}
        </p>

        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('common.loading', '加载中…')}
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </div>
        ) : channels.length === 0 && !adding ? (
          <div className="rounded-xl border border-dashed border-border/50 px-4 py-6 text-center">
            <Inbox className="h-5 w-5 mx-auto text-muted-foreground/50 mb-2" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('botPage.channels.empty',
                '还没有接入任何外部渠道。新建一个，把消息从你的聊天工具送进来。')}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {channels.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border border-border/40 bg-muted/20 px-3.5 py-3"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs font-semibold text-foreground">{c.id}</span>
                  {/* 处理方式徽标——先审后办=盾（有人把关），自动执行=闪电（直接干活） */}
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border',
                      c.trust === 'trusted'
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                        : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
                    )}
                  >
                    <ShieldCheck size={10} />
                    {c.trust === 'trusted'
                      ? t('botPage.channels.modeTrusted', '自动执行')
                      : t('botPage.channels.modeUntrusted', '先审后办')}
                  </span>
                  {c.secretProtected && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground border border-border/40">
                      <Lock size={10} />
                      {t('botPage.channels.secretSealed', '密钥已加密保存')}
                    </span>
                  )}
                  {!c.enabled && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground border border-border/40">
                      {t('botPage.channels.disabled', '已停用')}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => startEdit(c)}
                      className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {t('common.edit', '编辑')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(c.id)}
                      className="text-[11px] text-muted-foreground hover:text-destructive transition-colors"
                    >
                      {t('common.delete', '删除')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void toggleEnabled(c)}
                      className={cn(
                        'relative inline-flex h-[18px] w-8 items-center rounded-full transition-colors',
                        c.enabled ? 'bg-primary' : 'bg-muted-foreground/30',
                      )}
                      aria-label={c.enabled
                        ? t('botPage.channels.disable', '停用')
                        : t('botPage.channels.enable', '启用')}
                    >
                      <span
                        className={cn(
                          'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
                          c.enabled ? 'translate-x-4' : 'translate-x-0.5',
                        )}
                      />
                    </button>
                  </span>
                </div>
                {c.replyUrl && (
                  <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <ExternalLink size={10} className="shrink-0" />
                    <span className="truncate">{t('botPage.channels.replyTo', '回信送到')} {c.replyUrl}</span>
                  </div>
                )}
                {c.trust === 'untrusted' && (
                  <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground/70">
                    <Inbox size={10} className="shrink-0" />
                    {t('botPage.channels.untrustedHint', '这个渠道的消息会先进入待处理列表，等你放行')}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 新建 / 编辑表单 */}
        {(adding || editingId !== null) && (
          <div className="rounded-xl border border-border/50 bg-muted/20 p-4 space-y-3.5">
            <div>
              <label className="text-[11px] font-medium text-foreground/80 block mb-1">
                {t('botPage.channels.fieldName', '渠道名称')}
              </label>
              <Input
                value={draft.id}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                placeholder={t('botPage.channels.phName', '例如：ops-bot（小写字母、数字、短横线）')}
                disabled={saving || editingId !== '__new__'}
                className="h-8 text-xs font-mono"
              />
            </div>

            <div>
              <label className="text-[11px] font-medium text-foreground/80 block mb-1">
                {t('botPage.channels.fieldSecret', '连接密钥')}
                {editingId !== '__new__' && (
                  <span className="ml-1.5 font-normal text-muted-foreground">
                    {t('botPage.channels.secretKeepHint', '（编辑时留空表示不变）')}
                  </span>
                )}
              </label>
              <div className="relative">
                <KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type={showSecret ? 'text' : 'password'}
                  value={draft.secret}
                  onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
                  placeholder={t('botPage.channels.phSecret', '自己起一串足够长、别人猜不到的字符')}
                  disabled={saving}
                  className="h-8 text-xs pl-8 pr-8"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  <KeyRound size={13} />
                </button>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground/70 leading-relaxed">
                {t('botPage.channels.secretHint',
                  '会加密保存在本机，界面上不再显示。对方每次发消息都要用它证明身份——两边配对一致才能接进来。')}
              </p>
            </div>

            <div>
              <label className="text-[11px] font-medium text-foreground/80 block mb-1.5">
                {t('botPage.channels.fieldMode', '消息怎么处理')}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(MODE_META) as HandleMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setDraft({ ...draft, mode: m })}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-left transition-all',
                      draft.mode === m
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-border/40 hover:border-border',
                    )}
                  >
                    <div className="text-xs font-medium text-foreground">{MODE_META[m].label}</div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground leading-snug">
                      {MODE_META[m].hint}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[11px] font-medium text-foreground/80 block mb-1">
                {t('botPage.channels.fieldReply', '回信地址')}
                <span className="ml-1 font-normal text-muted-foreground">
                  {t('botPage.channels.optional', '（可选）')}
                </span>
              </label>
              <Input
                value={draft.replyUrl}
                onChange={(e) => setDraft({ ...draft, replyUrl: e.target.value })}
                placeholder="https://your-bot.example.com/reply"
                disabled={saving}
                className="h-8 text-xs"
              />
              <p className="mt-1 text-[10px] text-muted-foreground/70">
                {t('botPage.channels.replyHint', '填了之后，系统处理完会把结果发回这个地址。')}
              </p>
            </div>

            {formError && (
              <div className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {formError}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={cancelForm} disabled={saving}>
                {t('common.cancel', '取消')}
              </Button>
              <Button size="sm" className="h-8 text-xs gap-1" onClick={() => void save()} disabled={saving}>
                {saving && <Loader2 className="h-3 w-3 animate-spin" />}
                {t('common.save', '保存')}
              </Button>
            </div>
          </div>
        )}

        {/* 删除确认 */}
        {confirmDelete && (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3">
            <p className="text-xs text-foreground/90">
              {t('botPage.channels.deleteConfirm',
                '确定删除渠道「{{id}}」吗？删除后它发来的消息将被拒绝。已产生的记录会保留。',
                { id: confirmDelete })}
            </p>
            <div className="mt-2.5 flex items-center justify-end gap-2">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmDelete(null)}>
                {t('common.cancel', '取消')}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                onClick={() => void doDelete(confirmDelete)}
              >
                {t('common.delete', '删除')}
              </Button>
            </div>
          </div>
        )}

        <div className="flex items-start gap-1.5 text-[10px] text-muted-foreground/60 leading-relaxed">
          <ChevronDown size={10} className="shrink-0 mt-0.5" />
          {t('botPage.channels.footnote',
            '提示：先审后办的消息会在待处理列表等你放行；处理方式之后随时可以改。')}
        </div>
      </CardContent>
    </Card>
  )
}
