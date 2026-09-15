// src/components/settings/McpSettings.tsx
// MCP server management — the standard MCP client settings page.
//
// Config is persisted into config.json under `mcpServers`, the exact key those
// apps use, so a config can be pasted in either direction. The JSON paste mode
// exists because that IS how people share MCP setups — every README ships a
// `{"mcpServers": {...}}` snippet, and retyping it into four form fields is
// friction with no upside.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plug, Plus, RefreshCw, Trash2, ChevronRight, AlertTriangle,
  Terminal, Wrench, ClipboardPaste, X, Globe, KeyRound, EyeOff,
} from 'lucide-react'
import { API_BASE, apiFetch } from '@lib/api'
import { cn } from '@/lib/utils'

interface McpTool { name: string; raw: string; desc: string }
/** 登录凭据摘要——服务端只回"是否已配置/保护形态"，secret 原文永不出后端。 */
interface McpAuthSummary {
  enabled: boolean
  type?: string
  tokenUrl?: string
  clientId?: string
  secretProtected?: boolean
  scopes?: string[]
}
interface McpServer {
  name: string
  command: string
  args: string[]
  /** stdio spawns a subprocess; http/sse/websocket dial `url`. */
  transport: 'stdio' | 'http' | 'sse' | 'websocket'
  url: string
  status: 'connected' | 'starting' | 'failed' | 'lost' | 'disabled' | 'idle'
  error: string
  disabled: boolean
  toolCount: number
  tools: McpTool[]
  uptimeSeconds: number
  /** 不对 AI 开放的工具数量（旧后端无此字段 → undefined） */
  hiddenToolCount?: number
  auth?: McpAuthSummary
}
interface McpState {
  available: boolean
  importError: string
  servers: McpServer[]
}

const TRANSPORTS = ['stdio', 'http', 'sse', 'websocket'] as const
type Transport = (typeof TRANSPORTS)[number]


const STATUS_STYLE: Record<string, string> = {
  connected: 'bg-success/15 text-success',
  starting: 'bg-warning/15 text-warning',
  failed: 'bg-destructive/15 text-destructive',
  // `lost` = we were connected and the server went away under us. Styled as a
  // hard error, not a neutral idle, because its tools are gone and any call
  // against them will fail.
  lost: 'bg-destructive/15 text-destructive',
  disabled: 'bg-muted text-muted-foreground',
  idle: 'bg-muted text-muted-foreground',
}

export function McpSettings() {
  const { t } = useTranslation()
  const [state, setState] = useState<McpState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await apiFetch(`${API_BASE}/api/mcp/servers`)
      setState(await r.json())
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const act = async (label: string, fn: () => Promise<Response>) => {
    setBusy(label)
    setError(null)
    try {
      const r = await fn()
      const d = await r.json().catch(() => ({}))
      if (!r.ok) setError(d.error || `HTTP ${r.status}`)
      if (d.servers) setState((s) => (s ? { ...s, servers: d.servers } : s))
      else await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(null)
    }
  }

  const toggle = (name: string, enabled: boolean) => act(name, () =>
    apiFetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(name)}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }))
  const restart = (name: string) => act(name, () =>
    apiFetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(name)}/restart`, { method: 'POST' }))
  const remove = (name: string) => act(name, () =>
    apiFetch(`${API_BASE}/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' }))
  const upsert = (payload: any) => act('__add__', () =>
    apiFetch(`${API_BASE}/api/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }))

  const servers = state?.servers ?? []

  return (
    <div className="rounded-xl border border-border/40 bg-card/60 p-4 space-y-3">
      <div className="flex items-center justify-between">
        {/* No title/subtitle here on purpose: the settings section this card
            lives in already renders `mcp.title` + `mcp.subtitle` as its header,
            so repeating them printed the same two sentences twice on screen.
            The count is the one thing the header can't know. */}
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Plug size={14} />
          <span className="text-[11px] font-mono">
            {t('mcp.serverCount', { n: servers.length })}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={load}
            disabled={!!busy}
            aria-label={t('common.refresh')}
            title={t('common.refresh')}
            className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={13} className={cn(busy && 'animate-spin')} />
          </button>
          <button
            onClick={() => setAdding((v) => !v)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-accent text-foreground hover:bg-foreground/10 transition-colors"
          >
            {adding ? <X size={12} /> : <Plus size={12} />}
            {adding ? t('common.cancel') : t('mcp.add')}
          </button>
        </div>
      </div>

      {/* SDK missing is the one failure the user can't fix from this panel —
          surface the pip command instead of a bare "unavailable". */}
      {state && !state.available && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning space-y-1">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={12} />
            {t('mcp.sdkMissing')}
          </div>
          <code className="block font-mono text-[10px] opacity-80">pip install "mcp&gt;=1.20,&lt;2"</code>
          {state.importError && <div className="opacity-70 break-all">{state.importError}</div>}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          {error}
        </div>
      )}

      {adding && <AddServerForm onSubmit={upsert} busy={busy === '__add__'} onClose={() => setAdding(false)} />}

      {loading ? (
        <div className="py-8 text-center text-muted-foreground text-xs">{t('common.loading')}…</div>
      ) : servers.length === 0 ? (
        <div className="py-8 text-center space-y-1">
          <p className="text-xs text-muted-foreground">{t('mcp.empty')}</p>
          <p className="text-[10px] text-muted-foreground/70">{t('mcp.emptyHint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <ServerRow
              key={s.name}
              server={s}
              busy={busy === s.name}
              disabled={!!busy}
              onToggle={(en) => toggle(s.name, en)}
              onRestart={() => restart(s.name)}
              onDelete={() => remove(s.name)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ─── One server row ───────────────────────────────────────────────── */

function ServerRow({
  server, busy, disabled, onToggle, onRestart, onDelete,
}: {
  server: McpServer
  busy: boolean
  disabled: boolean
  onToggle: (enabled: boolean) => void
  onRestart: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  // A backend that predates the transport field sends neither `transport` nor
  // `url`. Defaulting the MISSING case to stdio matters: `transport !== 'stdio'`
  // on `undefined` would label every local server "remote" and then render an
  // undefined URL where its command line should be.
  const transport = server.transport || (server.url ? 'http' : 'stdio')
  const isRemote = transport !== 'stdio'
  // Local: show the spawned command line. Remote: show the endpoint URL.
  const detailLine = isRemote
    ? (server.url || '')
    : [server.command, ...(server.args || [])].join(' ')

  return (
    <div className="rounded-lg border border-border/40 bg-background/40">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          aria-label={expanded ? t('common.close') : t('common.open')}
        >
          <ChevronRight size={14} className={cn('transition-transform', expanded && 'rotate-90')} />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium truncate">{server.name}</span>
            <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase bg-muted text-muted-foreground">
              {transport}
            </span>
            <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-mono uppercase', STATUS_STYLE[server.status] || STATUS_STYLE.idle)}>
              {t(`mcp.status.${server.status}`)}
            </span>
            {server.status === 'connected' && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <Wrench size={9} /> {t('mcp.toolCount', { n: server.toolCount })}
              </span>
            )}
            {/* 已配置登录凭据（摘要徽标——secret 永不出后端） */}
            {server.auth?.enabled && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <KeyRound size={9} /> {t('mcp.authConfigured', '已配置登录')}
              </span>
            )}
            {(server.hiddenToolCount ?? 0) > 0 && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                <EyeOff size={9} /> {t('mcp.hiddenToolCount', '隐藏 {{n}} 个工具', { n: server.hiddenToolCount })}
              </span>
            )}
          </div>
          <div className="text-[10px] text-muted-foreground font-mono truncate flex items-center gap-1 mt-0.5">
            {isRemote ? <Globe size={9} className="shrink-0" /> : <Terminal size={9} className="shrink-0" />}
            {detailLine}
          </div>
          {(server.status === 'failed' || server.status === 'lost') && server.error && (
            <div className="text-[10px] text-destructive mt-0.5 break-all">{server.error}</div>
          )}
        </div>

        <div className="shrink-0 flex items-center gap-1">
          <button
            onClick={onRestart}
            disabled={disabled || server.disabled}
            aria-label={t('mcp.restart')}
            title={t('mcp.restart')}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30"
          >
            <RefreshCw size={12} className={cn(busy && 'animate-spin')} />
          </button>
          {/* Enable/disable toggle — a plain checkbox styled as a pill switch */}
          <button
            onClick={() => onToggle(server.disabled)}
            disabled={disabled}
            role="switch"
            aria-checked={!server.disabled}
            aria-label={t('mcp.enabled')}
            className={cn(
              'relative w-8 h-4 rounded-full transition-colors disabled:opacity-40',
              // 「开」态用墨黑：和 switch.tsx 一致。黑 vs 浅灰的明度差足够大，
              // 不需要靠彩色来区分开关状态。
              server.disabled ? 'bg-muted' : 'bg-foreground',
            )}
          >
            <span className={cn(
              'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform',
              server.disabled ? 'left-0.5' : 'left-0.5 translate-x-4',
            )} />
          </button>
          <button
            onClick={onDelete}
            disabled={disabled}
            aria-label={t('mcp.delete')}
            title={t('mcp.delete')}
            className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-30"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border/30 px-3 py-2">
          {(server.tools || []).length === 0 ? (
            <p className="text-[10px] text-muted-foreground py-1">{t('mcp.noTools')}</p>
          ) : (
            <ul className="space-y-1">
              {(server.tools || []).map((tool) => (
                <li key={tool.name} className="flex items-start gap-2 text-[11px]">
                  <code className="font-mono text-foreground shrink-0">{tool.raw}</code>
                  <span className="text-muted-foreground truncate">{tool.desc}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/* ─── Add-server form ──────────────────────────────────────────────── */

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/projects"]
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer sk-xxx" }
    }
  }
}`

function AddServerForm({
  onSubmit, busy, onClose,
}: {
  onSubmit: (payload: any) => void
  busy: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'form' | 'json'>('json')
  const [transport, setTransport] = useState<Transport>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [url, setUrl] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [jsonText, setJsonText] = useState('')
  const [localError, setLocalError] = useState('')
  // 不对 AI 开放的工具（工具级开关）；登录凭据（远端服务器需要登录时）
  const [disabledToolsText, setDisabledToolsText] = useState('')
  const [authTokenUrl, setAuthTokenUrl] = useState('')
  const [authClientId, setAuthClientId] = useState('')
  const [authClientSecret, setAuthClientSecret] = useState('')
  const [authScopes, setAuthScopes] = useState('')

  /** 逗号/换行/空白分隔 → 工具名数组 */
  const parseToolList = (text: string): string[] =>
    text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)

  const isRemote = transport !== 'stdio'

  /** KEY=VALUE per line — the format every MCP README uses for env, and the
   *  least surprising one to reuse for headers. */
  const parsePairs = (text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return out
  }

  const submitForm = () => {
    setLocalError('')
    if (!name.trim() || !(isRemote ? url.trim() : command.trim())) {
      setLocalError(isRemote ? t('mcp.errNameUrl') : t('mcp.errNameCommand'))
      return
    }
    const disabledTools = parseToolList(disabledToolsText)
    // 登录凭据：三项必填齐全才携带；密钥由后端落盘前加密（明文不出本机传输链）
    const auth = (authTokenUrl.trim() && authClientId.trim() && authClientSecret.trim())
      ? {
          type: 'oauth2',
          token_url: authTokenUrl.trim(),
          client_id: authClientId.trim(),
          client_secret: authClientSecret.trim(),
          ...(authScopes.trim() ? { scopes: authScopes.split(/[\s,]+/).filter(Boolean) } : {}),
        }
      : undefined
    if (isRemote) {
      onSubmit({
        name: name.trim(),
        type: transport,
        url: url.trim(),
        headers: parsePairs(headersText),
        ...(disabledTools.length ? { disabledTools } : {}),
        ...(auth ? { auth } : {}),
      })
      onClose()
      return
    }
    onSubmit({
      name: name.trim(),
      type: 'stdio',
      command: command.trim(),
      // Split on whitespace but respect quoted segments, so a path with
      // spaces survives being typed as one argument.
      args: (argsText.match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, '')),
      env: parsePairs(envText),
      ...(disabledTools.length ? { disabledTools } : {}),
    })
    onClose()
  }


  const submitJson = () => {
    setLocalError('')
    let parsed: any
    try {
      parsed = JSON.parse(jsonText)
    } catch (e) {
      setLocalError(t('mcp.errBadJson'))
      return
    }
    // Accept both a full `{mcpServers:{...}}` document and a bare map.
    const payload = parsed.mcpServers ? parsed : { mcpServers: parsed }
    if (!payload.mcpServers || typeof payload.mcpServers !== 'object') {
      setLocalError(t('mcp.errBadJson'))
      return
    }
    onSubmit(payload)
    onClose()
  }

  return (
    <div className="rounded-lg border border-primary/30 bg-muted p-3 space-y-2.5">
      <div className="flex items-center gap-0.5 bg-muted/40 rounded-lg p-0.5 w-fit">
        {(['json', 'form'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              'px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors',
              mode === m ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {m === 'json' ? t('mcp.modeJson') : t('mcp.modeForm')}
          </button>
        ))}
      </div>

      {mode === 'json' ? (
        <>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1">
            <ClipboardPaste size={10} />
            {t('mcp.jsonHint')}
          </p>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder={JSON_PLACEHOLDER}
            spellCheck={false}
            rows={9}
            className="w-full px-2.5 py-2 rounded-md bg-background/70 border border-border/50 font-mono text-[11px] leading-relaxed placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring/40 resize-y"
          />
        </>
      ) : (
        <div className="space-y-2">
          {/* Transport first: it decides which of the remaining fields even
              apply, so asking for a command before knowing whether the server
              is local would be asking the wrong question. */}
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground">{t('mcp.fieldTransport')}</label>
            <div className="flex items-center gap-0.5 bg-muted/40 rounded-lg p-0.5 w-fit">
              {TRANSPORTS.map((tp) => (
                <button
                  key={tp}
                  onClick={() => setTransport(tp)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-[11px] font-mono transition-colors',
                    transport === tp
                      ? 'bg-background shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {tp}
                </button>
              ))}
            </div>
          </div>

          <Field label={t('mcp.fieldName')} value={name} onChange={setName}
                 placeholder={isRemote ? 'context7' : 'filesystem'} />

          {isRemote ? (
            <>
              <Field label={t('mcp.fieldUrl')} value={url} onChange={setUrl} mono
                     placeholder={transport === 'websocket' ? 'wss://example.com/mcp' : 'https://example.com/mcp'} />
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground">{t('mcp.fieldHeaders')}</label>
                <textarea
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder={'Authorization=Bearer sk-xxx'}
                  spellCheck={false}
                  rows={2}
                  disabled={transport === 'websocket'}
                  className="w-full px-2.5 py-1.5 rounded-md bg-background/70 border border-border/50 font-mono text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring/40 resize-y disabled:opacity-40"
                />
                {transport === 'websocket' && (
                  <p className="text-[10px] text-muted-foreground/70">{t('mcp.wsNoHeaders')}</p>
                )}
              </div>
              {/* 登录凭据：服务器要求登录时才需要填。三项齐全才生效。 */}
              {(transport === 'http' || transport === 'sse') && (
                <div className="space-y-1.5 rounded-md border border-border/40 bg-background/40 p-2.5">
                  <label className="text-[10px] font-medium text-foreground/80">
                    {t('mcp.authTitle', '登录凭据（可选）')}
                  </label>
                  <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                    {t('mcp.authHint', '服务器需要登录才能用时在这里填。密钥会加密保存在本机，不再明文显示。')}
                  </p>
                  <Field label={t('mcp.authTokenUrl', '授权地址')} value={authTokenUrl} onChange={setAuthTokenUrl} mono
                         placeholder="https://login.example.com/oauth/token" />
                  <Field label={t('mcp.authClientId', '客户端 ID')} value={authClientId} onChange={setAuthClientId} mono />
                  <Field label={t('mcp.authClientSecret', '客户端密钥')} value={authClientSecret} onChange={setAuthClientSecret} mono />
                  <Field label={t('mcp.authScopes', '权限范围（可选，逗号分隔）')} value={authScopes} onChange={setAuthScopes} mono />
                </div>
              )}
            </>
          ) : (
            <>
              <Field label={t('mcp.fieldCommand')} value={command} onChange={setCommand} placeholder="npx" mono />
              <Field label={t('mcp.fieldArgs')} value={argsText} onChange={setArgsText}
                     placeholder='-y @modelcontextprotocol/server-filesystem D:/projects' mono />
              <div className="space-y-1">
                <label className="text-[10px] text-muted-foreground">{t('mcp.fieldEnv')}</label>
                <textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder={'GITHUB_TOKEN=ghp_xxx'}
                  spellCheck={false}
                  rows={2}
                  className="w-full px-2.5 py-1.5 rounded-md bg-background/70 border border-border/50 font-mono text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring/40 resize-y"
                />
              </div>
            </>
          )}

          {/* 工具级开关：这个服务器里不给 AI 用的工具（逗号/换行分隔） */}
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground">
              {t('mcp.fieldHiddenTools', '不对 AI 开放的工具（可选，逗号分隔）')}
            </label>
            <textarea
              value={disabledToolsText}
              onChange={(e) => setDisabledToolsText(e.target.value)}
              placeholder={t('mcp.phHiddenTools', 'write_file, execute_script')}
              spellCheck={false}
              rows={2}
              className="w-full px-2.5 py-1.5 rounded-md bg-background/70 border border-border/50 font-mono text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring/40 resize-y"
            />
            <p className="text-[10px] text-muted-foreground/70">
              {t('mcp.hiddenToolsHint', '这些工具不会出现在 AI 的工具箱里，其余照常使用。')}
            </p>
          </div>
        </div>
      )}

      {localError && <p className="text-[11px] text-destructive">{localError}</p>}

      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onClose}
          className="px-2.5 py-1 rounded text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={mode === 'json' ? submitJson : submitForm}
          disabled={busy}
          className="flex items-center gap-1 px-3 py-1 rounded text-[11px] font-medium bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {busy && <RefreshCw size={11} className="animate-spin" />}
          {t('mcp.addAndConnect')}
        </button>
      </div>
    </div>
  )
}

function Field({
  label, value, onChange, placeholder, mono,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] text-muted-foreground">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={cn(
          'w-full px-2.5 py-1.5 rounded-md bg-background/70 border border-border/50 text-[11px]',
          'placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring/40',
          mono && 'font-mono',
        )}
      />
    </div>
  )
}
