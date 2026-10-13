/**
 * ApprovalsPage — 演化裁决工作面。
 *
 * 自进化环的两类待决事项（Skills 页的 staged 候选、Evolution 面板的 pending
 * 提案）在此就地批准/拒绝；支持紧凑高密度排版与批量一键裁决。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Inbox, ShieldCheck, XCircle,
  RefreshCw, Loader2, Sparkles, RotateCcw, BookOpen, CheckCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { readGate } from '@/lib/gateReport'
import { Button } from '@components/ui/button'
import { Card, CardContent } from '@components/ui/card'
import { Badge } from '@components/ui/badge'
import { HabitProposalCard } from '@components/evolution/HabitProposalCard'
import { API_BASE, apiFetch, fetchJson } from '@lib/api'
import {
  useApprovalsStore, type ApprovalSkillCandidate,
  type ApprovalEvolutionProposal,
} from '@store/approvalsStore'
import { useSkillStore } from '@store/skillStore'

export default function ApprovalsPage() {
  const { t } = useTranslation()
  const { data, loaded, error, fetchApprovals } = useApprovalsStore()
  const [busy, setBusy] = useState('')
  const [proposalNote, setProposalNote] = useState('')

  useEffect(() => { void fetchApprovals() }, [fetchApprovals])

  const actCandidate = async (id: string, action: 'approve' | 'reject' | 'rollback') => {
    setBusy(id + action)
    try {
      await apiFetch(`${API_BASE}/api/skills/candidates/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (action === 'approve' || action === 'rollback') {
        await useSkillStore.getState().fetchSkills()
      }
    } finally {
      setBusy('')
      await fetchApprovals()
    }
  }

  const actProposal = async (id: string, action: 'accept' | 'reject', draftOverride?: string) => {
    setBusy(id + action)
    setProposalNote('')
    try {
      const res = await fetchJson<{ applied?: boolean; targetFile?: string; error?: string }>(
        `${API_BASE}/api/evolution/proposals/${id}/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(draftOverride ? { draft: draftOverride } : {}),
        })
      if (action === 'accept' && res?.applied === false) {
        setProposalNote(t('approvalsPage.proposalWriteFailed', {
          file: res?.targetFile || '?',
          error: res?.error || '',
        }))
      }
    } catch (e) {
      setProposalNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
      await fetchApprovals()
    }
  }


  const handleApproveAllProposals = async () => {
    setBusy('bulk-approve')
    try {
      for (const p of data.evolutionProposals) {
        await fetchJson(`${API_BASE}/api/evolution/proposals/${p.id}/accept`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      }
    } finally {
      setBusy('')
      await fetchApprovals()
    }
  }

  const handleRejectAllProposals = async () => {
    setBusy('bulk-reject')
    try {
      for (const p of data.evolutionProposals) {
        await fetchJson(`${API_BASE}/api/evolution/proposals/${p.id}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      }
    } finally {
      setBusy('')
      await fetchApprovals()
    }
  }

  const { skillCandidates, evolutionProposals, counts } = data
  const empty = loaded && !error && counts.total === 0

  return (
    <div className="container mx-auto py-6 px-4 max-w-5xl space-y-5 animate-fade-in select-none">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/50">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-primary/10 text-primary border border-primary/20 shadow-2xs">
              <Inbox size={20} className="stroke-[2.2]" />
            </div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
              {t('approvalsPage.title')}
            </h1>
            {counts.total > 0 && (
              <Badge variant="outline" className="rounded-md font-mono text-[11px] bg-warning/15 text-warning border-warning/30 font-semibold px-2 py-0.5">
                {counts.total}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 ml-0.5">
            {t('approvalsPage.subtitle')}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={busy !== ''}
          onClick={() => void fetchApprovals()}
          className="rounded-lg h-8 px-3 text-xs gap-1.5 shrink-0 bg-card border-border/80 shadow-2xs">
          {busy !== '' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t('approvalsPage.refresh')}
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-lg p-2.5">{t('approvalsPage.loadFailed', { error })}</p>
      )}

      {empty && (
        <Card className="rounded-2xl border-border/70 bg-card shadow-2xs">
          <CardContent className="p-8 flex flex-col items-center gap-2 text-center">
            <Inbox className="w-8 h-8 text-muted-foreground/40" />
            <p className="text-sm font-semibold text-foreground">{t('approvalsPage.emptyTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('approvalsPage.emptyHint')}</p>
          </CardContent>
        </Card>
      )}

      {/* 技能候选审批区 */}
      {skillCandidates.length > 0 && (
        <section className="space-y-2.5">
          <div className="flex items-center gap-2 px-1">
            <Sparkles className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">{t('approvalsPage.candidatesTitle')}</h3>
            <span className="text-xs text-muted-foreground">({skillCandidates.length})</span>
          </div>
          <div className="grid grid-cols-1 gap-2">
            {skillCandidates.map((c: ApprovalSkillCandidate) => (
              <div key={c.id} className="p-3.5 rounded-xl border border-border/80 bg-card shadow-2xs hover:shadow-xs hover:border-primary/30 transition-all space-y-2">
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <Badge variant="outline" className="rounded-md text-[10px] font-mono bg-warning/15 text-warning border-warning/30 px-1.5 py-0.5">
                    {c.status ?? 'staged'}
                  </Badge>
                  <span className="text-[13px] font-semibold text-foreground">{c.name}</span>
                  {c.version ? (
                    <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">v{c.version.slice(0, 8)}</span>
                  ) : null}
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button size="sm" variant="ghost" disabled={busy !== ''}
                      onClick={() => void actCandidate(c.id, 'reject')}
                      className="rounded-lg h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1">
                      <XCircle className="w-3.5 h-3.5" /> {t('approvalsPage.reject')}
                    </Button>
                    <Button size="sm" disabled={busy !== ''}
                      onClick={() => void actCandidate(c.id, 'approve')}
                      className="rounded-lg h-7 px-3 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 gap-1 shadow-2xs">
                      <ShieldCheck className="w-3.5 h-3.5" /> {t('approvalsPage.approve')}
                    </Button>
                    {c.status === 'active' && (
                      <Button size="sm" variant="outline" disabled={busy !== ''}
                        onClick={() => void actCandidate(c.id, 'rollback')}
                        className="rounded-lg h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive gap-1">
                        <RotateCcw className="w-3.5 h-3.5" /> {t('approvalsPage.rollback')}
                      </Button>
                    )}
                  </div>
                </div>
                {c.description ? (
                  <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">{c.description}</p>
                ) : null}
                {c.gate_report && Object.keys(c.gate_report).length > 0 && (
                  <div className="rounded-lg border border-border/50 bg-muted/40 p-2 space-y-1">
                    {Object.entries(c.gate_report).map(([gate, raw]) => {
                      const g = readGate(raw)
                      return (
                        <div key={gate} className="flex items-start gap-2 text-[11px]">
                          <span className={cn(
                            'font-mono font-semibold',
                            g.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
                            g.tone === 'fail' && 'text-destructive',
                            g.tone === 'info' && 'text-muted-foreground')}>
                            {g.mark} {gate}
                          </span>
                          <span className="text-muted-foreground">{g.detail}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 习惯与经验建议区 */}
      {evolutionProposals.length > 0 && (
        <section className="space-y-2.5">
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" />
              <h3 className="text-xs font-bold uppercase tracking-wider text-foreground">
                {t('approvalsPage.proposalsTitle', 'AI 习惯与经验建议')}
              </h3>
              <Badge variant="outline" className="text-[10px] font-mono bg-muted text-muted-foreground border-border/50">
                {evolutionProposals.length}
              </Badge>
            </div>
            {evolutionProposals.length > 1 && (
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== ''}
                  onClick={handleRejectAllProposals}
                  className="h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg"
                >
                  全部忽略
                </Button>
                <Button
                  size="sm"
                  disabled={busy !== ''}
                  onClick={handleApproveAllProposals}
                  className="h-7 px-3 text-xs font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 shadow-2xs gap-1"
                >
                  <CheckCheck size={13} />
                  全部采纳并记住 ({evolutionProposals.length})
                </Button>
              </div>
            )}
          </div>
          {proposalNote && (
            <p className="px-2 py-1 text-xs text-destructive bg-destructive/10 rounded-lg">{proposalNote}</p>
          )}
          <div className="grid grid-cols-1 gap-2.5">
            {evolutionProposals.map((p: ApprovalEvolutionProposal) => (
              <HabitProposalCard
                key={p.id}
                proposal={p}
                busy={busy !== ''}
                onAccept={(draft) => void actProposal(p.id, 'accept', draft)}
                onReject={() => void actProposal(p.id, 'reject')}
              />
            ))}
          </div>
        </section>
      )}

    </div>
  )
}
