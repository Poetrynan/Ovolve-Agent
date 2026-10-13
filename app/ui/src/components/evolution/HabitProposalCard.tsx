/**
 * HabitProposalCard — AI 习惯与经验建议卡片。
 *
 * 统一用于「演化中心 (EvolutionPage)」与「审批中心 (ApprovalsPage)」，
 * 将底层的错误日志转化为以用户价值为核心的三段式习惯确认单。
 * 严格无 Emoji 设计。
 */
import React, { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ShieldCheck, ShieldAlert, Globe, Wifi, FolderTree,
  UserCheck, Sparkles, ChevronDown, ChevronUp, Pencil,
  RotateCcw, Check, Ban, FileText, Repeat, Info, MessageSquare
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@components/ui/badge'
import { Button } from '@components/ui/button'

export interface HabitProposalData {
  id: string
  kind?: string
  toolName?: string
  targetFile?: string
  draft?: string
  rationale?: string
  hits?: number
  status?: string
  createdAt?: number
  supersedes?: string
  effect?: string
  effectBaseline?: number
  userTitle?: string
  userAdvice?: string
  userReason?: string
  category?: string
}

interface HabitProposalCardProps {
  proposal: HabitProposalData
  busy?: boolean
  cooldownDays?: number
  onAccept: (draft?: string) => void
  onReject: () => void
}

export function HabitProposalCard({
  proposal,
  busy = false,
  cooldownDays,
  onAccept,
  onReject,
}: HabitProposalCardProps) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language || 'zh'
  const isEn = lang.startsWith('en')
  const [editing, setEditing] = useState(false)
  const [showTechDetails, setShowTechDetails] = useState(false)

  // 智能人本化元信息提炼（强健的容错与多语言转译，完全杜绝机器乱码）
  const rawDraft = proposal.draft || ''
  const meta = inferFriendlyMeta(proposal, lang)
  const catConfig = getCategoryConfig(meta.category, lang)

  // 基础数据清洗：编辑与展示基于已经人本化/多语言适配的 advice 文本，彻底告别机器原始日志
  const baseCleanText = meta.advice || rawDraft.replace(/^[-*]\s*/, '').replace(/^\[(?:fact|preference|context|procedure)\]\s*/i, '').trim()
  const [draft, setDraft] = useState(baseCleanText)
  const lastDraftRef = useRef(baseCleanText)

  useEffect(() => {
    const nextClean = meta.advice || (proposal.draft || '').replace(/^[-*]\s*/, '').replace(/^\[(?:fact|preference|context|procedure)\]\s*/i, '').trim()
    if (nextClean !== lastDraftRef.current) {
      lastDraftRef.current = nextClean
      if (!editing) setDraft(nextClean)
    }
  }, [proposal.draft, meta.advice, editing])

  const dirty = draft.trim() !== baseCleanText.trim()

  // 作用范围文案
  const targetScope = proposal.targetFile === 'AGENTS.md'
    ? (isEn ? 'Global Rules (AGENTS.md)' : '全局执行规范')
    : proposal.targetFile === 'MEMORY.md'
      ? (isEn ? 'Knowledge Base (MEMORY.md)' : '项目知识库')
      : (proposal.targetFile || (isEn ? 'Project Rules' : '项目规则'))

  return (
    <div className="p-4 rounded-xl border border-border/80 bg-card/85 backdrop-blur-xs shadow-2xs hover:shadow-xs hover:border-primary/40 transition-all space-y-3">
      {/* 顶部元信息栏 */}
      <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
        <div className="flex items-center gap-2 flex-wrap">
          {/* 分类徽章 */}
          <Badge className={cn('gap-1 text-[11px] font-semibold rounded-md px-2 py-0.5 shadow-2xs border', catConfig.badgeClass)}>
            {catConfig.icon}
            <span>{catConfig.label}</span>
          </Badge>

          {/* 触发频次 */}
          {typeof proposal.hits === 'number' && proposal.hits > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground font-mono text-[11px] bg-muted/60 px-2 py-0.5 rounded border border-border/40">
              <Repeat className="w-3 h-3 text-primary/70" />
              <span>近期遇到 {proposal.hits} 次</span>
            </span>
          )}

          {/* 作用范围 */}
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground/90 bg-muted/40 px-2 py-0.5 rounded border border-border/30">
            <FileText className="w-3 h-3 text-primary/70" />
            <span>作用于：{targetScope}</span>
          </span>
        </div>

        {/* 顶部快捷操作 */}
        <div className="flex items-center gap-1.5 ml-auto">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors font-medium cursor-pointer"
          >
            <Pencil className="w-3 h-3" />
            <span>{editing ? '完成预览' : '微调建议'}</span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onReject}
            disabled={busy}
            title={cooldownDays == null ? undefined : `拒绝后 ${cooldownDays} 天内不再就此建议提醒`}
            className="rounded-lg h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1"
          >
            <Ban className="w-3.5 h-3.5" />
            <span>暂不采纳</span>
          </Button>
          <Button
            size="sm"
            onClick={() => {
              const textToWrite = draft.trim()
              const bullet = textToWrite.startsWith('-') ? textToWrite : `- ${textToWrite}`
              onAccept(bullet)
            }}
            disabled={busy || !draft.trim()}
            className="rounded-lg h-7 px-3 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-2xs gap-1.5 select-none"
          >
            <Check className="w-3.5 h-3.5" />
            <span>{dirty ? '采纳修改版' : '采纳并记住'}</span>
          </Button>
        </div>
      </div>

      {/* 冲突替换旧规则提示 */}
      {proposal.supersedes && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 space-y-1">
          <p className="text-[11px] font-semibold text-destructive flex items-center gap-1">
            <RotateCcw className="w-3 h-3" />
            <span>采纳后将替换掉以下过期的旧规则：</span>
          </p>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground line-through pl-4">
            {proposal.supersedes}
          </pre>
        </div>
      )}

      {/* 主干内容区 */}
      <div className="space-y-2">
        {editing ? (
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground flex items-center gap-1">
              <span>自定义修改规则内容（确认后将作为中文执行准则存入 {targetScope}）：</span>
            </label>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              spellCheck={false}
              className="w-full resize-y rounded-lg bg-background border border-border/70 px-3 py-2 font-sans text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/40 leading-relaxed shadow-inner"
            />
            {dirty && (
              <button
                type="button"
                onClick={() => setDraft(baseCleanText)}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <RotateCcw className="w-2.5 h-2.5" />
                <span>还原初始建议</span>
              </button>
            )}
          </div>
        ) : (
          <div className="rounded-lg bg-muted/40 border border-border/50 p-3 space-y-1.5">
            <div className="flex items-start gap-2">
              <Sparkles className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
              <div className="space-y-0.5 flex-1">
                <h4 className="text-xs font-bold text-foreground tracking-tight">{meta.title}</h4>
                <p className="text-xs text-foreground/90 font-medium leading-relaxed">
                  「{draft.trim() || meta.advice}」
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 为什么提这个建议 (业务理由) */}
        {!editing && meta.reason && (
          <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground px-1 leading-relaxed">
            <MessageSquare className="w-3 h-3 text-primary/70 shrink-0 mt-0.5" />
            <span className="flex-1">{meta.reason}</span>
          </div>
        )}
      </div>

      {/* 渐进式技术详情折叠区 */}
      <div className="border-t border-border/40 pt-1.5">
        <button
          type="button"
          onClick={() => setShowTechDetails((v) => !v)}
          className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground/80 hover:text-foreground transition-colors py-0.5 cursor-pointer"
        >
          {showTechDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          <span>{showTechDetails ? '收起技术细节' : '查看底层依据与写入细节'}</span>
        </button>

        {showTechDetails && (
          <div className="mt-2 p-2.5 rounded-lg bg-muted/30 border border-border/40 space-y-1.5 text-[11px] text-muted-foreground font-mono">
            {proposal.toolName && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground/60 w-24 shrink-0">涉及工具:</span>
                <span className="text-foreground">{proposal.toolName}</span>
              </div>
            )}
            {proposal.targetFile && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground/60 w-24 shrink-0">目标文件:</span>
                <span className="text-foreground">{proposal.targetFile}</span>
              </div>
            )}
            {rawDraft && (
              <div className="flex items-start gap-2 pt-1 border-t border-border/20">
                <span className="text-muted-foreground/60 w-24 shrink-0">底层原始信息:</span>
                <code className="text-foreground/80 text-[10px] whitespace-pre-wrap break-all flex-1">{rawDraft}</code>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function inferFriendlyMeta(proposal: HabitProposalData, lang: string = 'zh') {
  const detail = ((proposal.rationale || '') + ' ' + (proposal.draft || '') + ' ' + (proposal.kind || '')).toLowerCase()
  const rawDraft = (proposal.draft || '').replace(/^[-*]\s*/, '').replace(/^\[fact\]\s*/i, '').replace(/<n>/g, '').trim()
  const isEn = lang.startsWith('en')

  let category = proposal.category || 'general'
  let title = proposal.userTitle || ''
  let advice = proposal.userAdvice || ''
  let reason = proposal.userReason || ''

  if (!title || !advice) {
    if (detail.includes('confirmation') || detail.includes('high risk') || detail.includes('permission') || proposal.kind === 'tool_denied' || proposal.toolName === 'shell_executor') {
      category = 'safety'
      title = title || (isEn ? 'Sensitive Command Confirmation' : '敏感操作安全防线')
      advice = advice || (isEn ? 'Explain intent and wait for confirmation before running high-risk commands' : '执行高风险或敏感系统命令前，先向您说明操作意图并等待确认')
      reason = reason || (isEn ? `Blocked by security policy during \`${proposal.toolName || 'shell'}\` execution.` : `近期在调用 \`${proposal.toolName || '系统命令'}\` 时触发了安全权限拦截，记住后将主动请示`)
    } else if (detail.includes('forbidden') || detail.includes('403')) {
      category = 'browser'
      title = title || (isEn ? 'Web Access & Authentication (403)' : '网页访问权限受限处理 (403)')
      advice = advice || (isEn ? 'When web fetch encounters 403 Forbidden, prompt for login or switch to browser mode' : '抓取网页遇到权限拒绝 (403) 时，优先提示登录或改用浏览器模式')
      reason = reason || (isEn ? 'Target website enforces anti-bot or authentication protection.' : '目标网站存在访问防护或需要登录，采纳后将自动切换为浏览器协助，避免盲目重试')
    } else if (detail.includes('not found') || detail.includes('404')) {
      category = 'network'
      title = title || (isEn ? 'Broken Link & Alternative Search (404)' : '网络死链与失效资源处理 (404)')
      advice = advice || (isEn ? 'When target page returns 404 Not Found, automatically search for alternative working links' : '遇到目标页面不存在 (404) 时，自动通过搜索引擎寻找备用有效链接')
      reason = reason || (isEn ? 'Target URL is broken or moved; system will automatically search alternatives.' : '目标网页链接已失效，采纳后遇到 404 将自动发起备选搜索补救')
    } else if (detail.includes('web_fetch') || detail.includes('fetch failed')) {
      category = 'browser'
      title = title || (isEn ? 'Web Fetch Parameter Optimization' : '网页抓取调用优化')
      advice = advice || (isEn ? 'Narrow query scope or filter parameters before fetching web pages' : '网页抓取前先精简参数范围与路径，避免无效重复请求')
      reason = reason || (isEn ? 'Frequent web request errors; optimize request parameters.' : '近期网页抓取遇到异常，采纳后将自动优化请求参数')
    } else if (proposal.kind === 'extracted_context' || proposal.kind === 'learned_fact' || detail.includes('saved to') || detail.includes('directory')) {
      category = 'project_context'
      // 路径脱敏与相对化
      const sanitized = rawDraft
        .replace(/[A-Za-z]:\\[^\s']+[\\/]([A-Za-z0-9_\-]+)[\\/]?/g, isEn ? '`$1/` directory' : '项目 $1/ 目录')
        .replace(/\/[^\s']+\/([A-Za-z0-9_\-]+)\/?/g, isEn ? '`$1/` directory' : '项目 $1/ 目录')
      const lowerS = sanitized.toLowerCase()

      if (lowerS.includes('screenshots are saved to') || lowerS.includes('screenshot')) {
        const m = /saved to (?:the\s+)?(.+?)(?:\s+directory)?\.?$/i.exec(sanitized)
        const targetDest = m ? m[1].trim() : (isEn ? '`output/` directory' : '项目 output/ 目录')
        title = title || (isEn ? 'Screenshot Output Path Convention' : '截图输出路径约定')
        advice = advice || (isEn ? `Screenshots generated during tasks are saved to ${targetDest}` : `任务执行中产生的屏幕截图统一保存至 ${targetDest}`)
        reason = reason || (isEn ? 'Ensures all task screenshots are archived in the output folder for easy reference.' : '确保所有任务截图与产物集中存放在指定文件夹，方便随时查阅与归档')
      } else if (lowerS.includes('output directory') && (lowerS.includes('created') || lowerS.includes('exist'))) {
        title = title || (isEn ? 'Output Directory Auto-Initialization' : '产物输出目录自动初始化')
        advice = advice || (isEn ? 'Automatically create output directory if it does not exist' : '当截图或产物输出目录不存在时，系统将自动创建对应文件夹')
        reason = reason || (isEn ? 'Prevents missing directory errors during file writes.' : '防止因输出文件夹缺失导致保存异常，保障自动化执行流程平稳闭环')
      } else if (lowerS.includes('saved to')) {
        const m = /saved to (?:the\s+)?(.+?)(?:\s+directory)?\.?$/i.exec(sanitized)
        const dest = m ? m[1].trim() : (isEn ? 'target directory' : '指定目录')
        title = title || (isEn ? 'File Output Location Convention' : '文件生成与归档约定')
        advice = advice || (isEn ? `Generated files are saved to ${dest}` : `相关生成文件统一保存至 ${dest}`)
        reason = reason || (isEn ? 'Standardizes file output location.' : '规范生成物存储位置，避免文件散落在工作区各处')
      } else {
        title = title || (isEn ? 'Project Context & Convention' : '项目文件与目录约定')
        advice = advice || sanitized
        reason = reason || (isEn ? 'Identified from codebase and configuration files.' : '从项目代码与配置文件中识别出的固定约定，后续任务中持续生效')
      }
    } else if (proposal.kind === 'user_correction') {
      category = 'preference'
      title = title || (isEn ? 'User Preference' : '用户个性化偏好')
      advice = advice || rawDraft
      reason = reason || (isEn ? 'Learned from user explicit correction.' : '根据您在对话中的明确纠偏所总结的偏好规则')
    } else {
      category = 'general'
      title = title || (isEn ? 'Task Execution Optimization' : '任务执行优化建议')
      if (rawDraft.includes('下次调用前')) {
        const parts = rawDraft.split('下次调用前')
        advice = advice || `下次调用前${parts[1] || parts[0]}`
      } else {
        advice = advice || rawDraft || (isEn ? 'Optimize parameters and execution flow' : '优化执行参数与流程')
      }
      reason = reason || (isEn ? 'Refined from recent task execution experience.' : '根据近期任务执行经验与复盘提炼')
    }
  }

  // 清洗 reason 中的底层复发信号机器日志
  if (reason.startsWith('复发信号:') || reason.includes('kind=') || reason.includes('hits=')) {
    if (category === 'safety') {
      reason = isEn ? `Triggered safety policy during \`${proposal.toolName || 'command'}\` execution.` : `近期在调用 \`${proposal.toolName || '系统命令'}\` 时多次触发安全策略拦截，记住后将主动请示避免直接受阻`
    } else if (category === 'browser') {
      reason = isEn ? 'Web requests frequently encounter barriers; switch to browser mode.' : '网页抓取多次遇到反爬拦截或鉴权阻碍，建议切换更稳健的浏览器访问方式'
    } else if (category === 'network') {
      reason = isEn ? 'Network resources broken or unavailable; search alternatives on failure.' : '多次遇到网络资源失效或断开，建议在失败时自动搜索备用来源'
    } else {
      reason = isEn ? `Encountered exceptions recently (${proposal.hits || 1} hits); optimize tool parameters.` : `近期同类操作遇到异常（${proposal.hits || 1} 次），采纳后将优化调用参数或选用备用工具`
    }
  }

  // 清洗 advice 中的机器日志残留（如“反复失败于...”）
  if (advice.startsWith('反复失败于') || advice.includes('`shell_executor`:') || advice.includes('`web_fetch`:')) {
    if (advice.includes('下次调用前')) {
      advice = '下次调用前' + advice.split('下次调用前')[1].replace(/[。.]\s*$/, '').trim()
    } else if (category === 'safety') {
      advice = isEn ? 'Narrow scope or confirm before executing high-risk commands' : '执行高风险或敏感系统命令前，先缩小参数范围或向您主动请示确认'
    } else if (category === 'browser') {
      advice = isEn ? 'Prompt login or switch to browser mode when web fetch is restricted' : '抓取网页遇到受限时，优先提示登录或改用浏览器模式'
    }
  }

  const strip = (s: string) => s.replace(/[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu, '').trim()

  return {
    category,
    title: strip(title),
    advice: strip(advice),
    reason: strip(reason),
  }
}

function getCategoryConfig(category: string, lang: string = 'zh') {
  const isEn = lang.startsWith('en')
  switch (category) {
    case 'safety':
      return {
        label: isEn ? 'Safety Habit' : '安全习惯',
        icon: <ShieldAlert className="w-3 h-3 text-amber-500" />,
        badgeClass: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
      }
    case 'browser':
      return {
        label: isEn ? 'Web Navigation' : '网页浏览',
        icon: <Globe className="w-3 h-3 text-sky-500" />,
        badgeClass: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
      }
    case 'network':
      return {
        label: isEn ? 'Network Connectivity' : '网络连接',
        icon: <Wifi className="w-3 h-3 text-blue-500" />,
        badgeClass: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
      }
    case 'project_context':
      return {
        label: isEn ? 'Project Fact' : '项目常识',
        icon: <FolderTree className="w-3 h-3 text-purple-500" />,
        badgeClass: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
      }
    case 'preference':
      return {
        label: isEn ? 'Developer Preference' : '操作偏好',
        icon: <UserCheck className="w-3 h-3 text-rose-500" />,
        badgeClass: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
      }
    default:
      return {
        label: isEn ? 'Best Practice' : '避坑经验',
        icon: <Sparkles className="w-3 h-3 text-primary" />,
        badgeClass: 'bg-primary/10 text-primary border-primary/20',
      }
  }
}
