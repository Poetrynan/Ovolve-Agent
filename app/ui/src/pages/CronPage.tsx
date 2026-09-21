import { useEffect, useState } from 'react'
import { useCronStore } from '@store/cronStore'
import {
  Plus,
  Pause,
  Play,
  Trash2,
  Clock,
  Calendar,
  Zap,
  CheckCircle2,
  Sparkles,
  Sun,
  Moon,
  Briefcase,
  Sliders,
  Code2,
  AlertCircle,
  Timer,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@components/ui/button'
import { Input } from '@components/ui/input'
import { Card, CardContent } from '@components/ui/card'
import { Badge } from '@components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@components/ui/dialog'
import { cn } from '@/lib/utils'
import { parseCronExpression } from '@/lib/cronUtils'
import { useTranslation } from 'react-i18next'

const PRESET_ICON = 'text-muted-foreground'
const PRESET_HOVER = 'hover:border-foreground/40 hover:bg-foreground/5'

const PRESETS = [
  {
    labelKey: 'cronPage.presets.daily09',
    expr: '0 9 * * *',
    icon: Sun,
    color: PRESET_ICON,
    border: PRESET_HOVER,
  },
  {
    labelKey: 'cronPage.presets.weekday0930',
    expr: '30 9 * * 1-5',
    icon: Briefcase,
    color: PRESET_ICON,
    border: PRESET_HOVER,
  },
  {
    labelKey: 'cronPage.presets.hourly',
    expr: '0 * * * *',
    icon: Clock,
    color: PRESET_ICON,
    border: PRESET_HOVER,
  },
  {
    labelKey: 'cronPage.presets.mondayMorning',
    expr: '0 9 * * 1',
    icon: Calendar,
    color: PRESET_ICON,
    border: PRESET_HOVER,
  },
  {
    labelKey: 'cronPage.presets.every30min',
    expr: '*/30 * * * *',
    icon: Zap,
    color: PRESET_ICON,
    border: PRESET_HOVER,
  },
  {
    labelKey: 'cronPage.presets.daily22',
    expr: '0 22 * * *',
    icon: Moon,
    color: PRESET_ICON,
    border: PRESET_HOVER,
  },
]

const FREQUENCIES = [
  { id: 'daily', labelKey: 'cronPage.freq.daily', defaultTime: '09:00' },
  { id: 'weekday', labelKey: 'cronPage.freq.weekday', defaultTime: '09:30' },
  { id: 'weekly', labelKey: 'cronPage.freq.monday', defaultTime: '09:00' },
  { id: 'hourly', labelKey: 'cronPage.freq.hourly', defaultTime: '' },
  { id: 'interval30', labelKey: 'cronPage.freq.every30min', defaultTime: '' },
]

export default function CronPage() {
  const { t } = useTranslation()
  const { crons, fetchCrons, createCron, updateCron, deleteCron } = useCronStore()
  const [createOpen, setCreateOpen] = useState(false)
  const [newExpr, setNewExpr] = useState('0 9 * * *')
  const [newTaskName, setNewTaskName] = useState('')
  const [editorMode, setEditorMode] = useState<'visual' | 'expert'>('visual')
  const [selectedFreq, setSelectedFreq] = useState('daily')
  const [visualTime, setVisualTime] = useState('09:00')

  useEffect(() => {
    void fetchCrons()
  }, [fetchCrons])

  const handleFreqChange = (freqId: string) => {
    setSelectedFreq(freqId)
    if (freqId === 'daily') {
      const [h, m] = visualTime.split(':').map((v) => parseInt(v, 10) || 0)
      setNewExpr(`${m} ${h} * * *`)
    } else if (freqId === 'weekday') {
      const [h, m] = visualTime.split(':').map((v) => parseInt(v, 10) || 0)
      setNewExpr(`${m} ${h} * * 1-5`)
    } else if (freqId === 'weekly') {
      const [h, m] = visualTime.split(':').map((v) => parseInt(v, 10) || 0)
      setNewExpr(`${m} ${h} * * 1`)
    } else if (freqId === 'hourly') {
      setNewExpr('0 * * * *')
    } else if (freqId === 'interval30') {
      setNewExpr('*/30 * * * *')
    }
  }

  const handleTimeChange = (timeStr: string) => {
    setVisualTime(timeStr)
    const [h, m] = timeStr.split(':').map((v) => parseInt(v, 10) || 0)
    if (selectedFreq === 'daily') {
      setNewExpr(`${m} ${h} * * *`)
    } else if (selectedFreq === 'weekday') {
      setNewExpr(`${m} ${h} * * 1-5`)
    } else if (selectedFreq === 'weekly') {
      setNewExpr(`${m} ${h} * * 1`)
    }
  }

  const handleSelectPreset = (presetExpr: string) => {
    setNewExpr(presetExpr)
    if (presetExpr === '0 9 * * *') {
      setSelectedFreq('daily')
      setVisualTime('09:00')
    } else if (presetExpr === '30 9 * * 1-5') {
      setSelectedFreq('weekday')
      setVisualTime('09:30')
    } else if (presetExpr === '0 * * * *') {
      setSelectedFreq('hourly')
    } else if (presetExpr === '0 9 * * 1') {
      setSelectedFreq('weekly')
      setVisualTime('09:00')
    } else if (presetExpr === '*/30 * * * *') {
      setSelectedFreq('interval30')
    } else if (presetExpr === '0 22 * * *') {
      setSelectedFreq('daily')
      setVisualTime('22:00')
    }
  }

  const handleCreate = () => {
    if (!newExpr.trim() || !newTaskName.trim()) return
    createCron(newExpr, newTaskName).catch((e) => {
      console.warn('create cron failed:', e)
    })
    setNewExpr('0 9 * * *')
    setNewTaskName('')
    setSelectedFreq('daily')
    setVisualTime('09:00')
    setCreateOpen(false)
  }

  const activeCount = crons.filter((c: any) => c.status === 'active').length
  const currentCronInfo = parseCronExpression(newExpr)

  return (
    <div className="container mx-auto py-8 px-4 max-w-5xl space-y-6 animate-fade-in">
      {/* Standard Header & Integrated Ribbon */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-2 border-b border-border/40">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-foreground/10 text-foreground border border-border/40 shadow-xs">
              <Clock size={22} className="stroke-[2.2]" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-heading font-extrabold tracking-tight text-foreground">
              {t('cronPage.title')}
            </h1>
          </div>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1.5 ml-1">
            {t('cronPage.subtitle')}
          </p>
        </div>

        {/* Right Header: Ribbon Status + Fast Create Button */}
        <div className="flex items-center gap-3 flex-wrap self-start md:self-auto">
          <div className="flex items-center gap-3 px-3.5 py-2 rounded-xl bg-card/70 border border-border/50 shadow-xs text-xs font-semibold select-none backdrop-blur-md">
            <span className="flex items-center gap-1.5 text-foreground">
              <span className="w-2 h-2 rounded-full bg-foreground/40" />
              <span>总任务 {crons.length}</span>
            </span>
            <span className="h-3 w-px bg-border/60" />
            <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <span className={cn('w-2 h-2 rounded-full bg-emerald-500', activeCount > 0 && 'animate-pulse')} />
              <span>活跃调度 {activeCount}</span>
            </span>
            <span className="h-3 w-px bg-border/60" />
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <ShieldCheck className="w-3.5 h-3.5 text-foreground/70" />
              <span>守护就绪</span>
            </span>
          </div>

          <Button
            onClick={() => setCreateOpen(true)}
            className="rounded-xl px-4 h-9.5 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-xs shrink-0 select-none gap-1.5"
          >
            <Plus className="h-4 w-4" />
            <span>新建任务</span>
          </Button>
        </div>
      </div>

      {/* Cron List — Clean & Full Space */}
      <div className="space-y-3.5">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('cronPage.taskListTitle', { count: crons.length })}
          </h3>
        </div>

        {crons.length === 0 ? (
          <div className="text-center py-16 px-4 rounded-2xl border border-dashed border-border/60 bg-card/30 space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-foreground/5 flex items-center justify-center mx-auto text-foreground">
              <Calendar className="w-6 h-6" />
            </div>
            <h4 className="text-sm font-bold text-foreground">{t('cronPage.emptyTitle')}</h4>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              {t('cronPage.emptyHint')}
            </p>
            <Button
              onClick={() => setCreateOpen(true)}
              size="sm"
              className="rounded-xl px-4 text-xs font-semibold bg-foreground text-background hover:bg-foreground/90 shadow-xs gap-1.5 mt-2"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>新建定时任务</span>
            </Button>
          </div>
        ) : (
          crons.map((cron: any) => {
            const isActive = cron.status === 'active'
            const parsed = parseCronExpression(cron.expression)

            return (
              <Card
                key={cron.id}
                className={cn(
                  'rounded-2xl border transition-all duration-200 bg-card/70 backdrop-blur-md overflow-hidden shadow-xs hover:shadow-md',
                  isActive
                    ? 'border-emerald-500/30 bg-emerald-500/5'
                    : 'border-border/50 opacity-80',
                )}
              >
                <CardContent className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                  {/* Task Info */}
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <Badge
                        className={cn(
                          'text-[10px] font-bold px-2 py-0.5 rounded-lg border shadow-2xs gap-1',
                          isActive
                            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                            : 'bg-muted text-muted-foreground border-border/40',
                        )}
                      >
                        {isActive ? (
                          <>
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                            {t('cronPage.statusRunning')}
                          </>
                        ) : (
                          t('cronPage.statusPaused')
                        )}
                      </Badge>
                      <h4 className="text-sm font-bold text-foreground truncate">{cron.task}</h4>
                    </div>

                    <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap pt-0.5">
                      <span className="flex items-center gap-1 font-medium text-foreground/80">
                        <Sparkles className="w-3.5 h-3.5 text-foreground/70" />
                        {parsed.label}
                      </span>
                      <span>·</span>
                      <span className="font-mono text-[11px] bg-muted/60 px-2 py-0.5 rounded-md border border-border/40 font-semibold text-foreground/70">
                        {cron.expression}
                      </span>
                      {parsed.nextRunStr && (
                        <>
                          <span>·</span>
                          <span className="flex items-center gap-1 text-[11px] text-muted-foreground/70 font-mono">
                            <Timer className="w-3 h-3" />
                            {parsed.nextRunStr}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 self-end md:self-center shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => updateCron(cron.id, isActive ? 'paused' : 'active')}
                      className={cn(
                        'rounded-xl text-xs h-8 px-3 transition-colors',
                        isActive
                          ? 'border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-500/10'
                          : 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10',
                      )}
                    >
                      {isActive ? (
                        <>
                          <Pause className="w-3.5 h-3.5 mr-1" /> {t('cronPage.pause')}
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5 mr-1" /> {t('cronPage.resume')}
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => deleteCron(cron.id)}
                      className="rounded-xl text-xs h-8 px-2.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )
          })
        )}
      </div>

      {/* Creation Modal Dialog — Zero Screen Real Estate Wasted! */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-xl rounded-2xl border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl p-6 space-y-4">
          <DialogHeader className="space-y-1 pr-8">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5 text-foreground" />
              <DialogTitle className="text-base font-bold text-foreground">
                {t('cronPage.createSection')}
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs text-muted-foreground">
              设定周期性执行的自动化指令，由后台定时引擎精准调度。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {/* Task Name & Mode Switcher */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-muted-foreground">{t('cronPage.taskLabel')}</label>
                <div className="inline-flex p-0.5 rounded-xl bg-muted/60 border border-border/40 text-xs">
                  <button
                    type="button"
                    onClick={() => setEditorMode('visual')}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg font-medium transition-all select-none',
                      editorMode === 'visual'
                        ? 'bg-card text-foreground shadow-xs font-bold'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Sliders className="w-3 h-3" />
                    <span>{t('cronPage.simpleWizard')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditorMode('expert')}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg font-medium transition-all select-none',
                      editorMode === 'expert'
                        ? 'bg-card text-foreground shadow-xs font-bold'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Code2 className="w-3 h-3" />
                    <span>{t('cronPage.cronExpert')}</span>
                  </button>
                </div>
              </div>
              <Input
                autoFocus
                value={newTaskName}
                onChange={(e) => setNewTaskName(e.target.value)}
                placeholder={t('cronPage.taskPlaceholder')}
                className="rounded-xl bg-background/80 border-border/50 text-xs sm:text-sm h-10"
              />
            </div>

            {/* Quick Semantic Presets */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground">
                {t('cronPage.quickPresets')} <span className="text-[10px] text-muted-foreground/60">（点击即可套用）</span>
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {PRESETS.map((p) => {
                  const Icon = p.icon
                  const isSelected = newExpr === p.expr
                  return (
                    <button
                      key={p.expr}
                      type="button"
                      onClick={() => handleSelectPreset(p.expr)}
                      className={cn(
                        'flex items-center gap-2 p-2 rounded-xl text-left border text-xs transition-all select-none',
                        isSelected
                          ? 'bg-foreground/10 border-foreground/30 text-foreground font-semibold shadow-2xs'
                          : 'bg-muted/40 text-muted-foreground border-border/40 hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <Icon className={cn('w-3.5 h-3.5 shrink-0', isSelected ? 'text-foreground' : p.color)} />
                      <div className="truncate">
                        <span className="block truncate font-medium">{t(p.labelKey)}</span>
                        {editorMode === 'expert' && (
                          <span className="block text-[10px] font-mono text-muted-foreground/70">{p.expr}</span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Visual or Expert Mode Content */}
            {editorMode === 'visual' ? (
              <div className="space-y-3 pt-1 border-t border-border/30">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">{t('cronPage.freqLabel')}</label>
                  <div className="flex flex-wrap gap-1.5">
                    {FREQUENCIES.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => handleFreqChange(f.id)}
                        className={cn(
                          'px-3 py-1.5 rounded-lg text-xs font-medium border select-none transition-all',
                          selectedFreq === f.id
                            ? 'bg-foreground text-background border-foreground font-semibold shadow-xs'
                            : 'bg-muted/40 text-muted-foreground border-border/40 hover:bg-muted',
                        )}
                      >
                        {t(f.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>

                {['daily', 'weekday', 'weekly'].includes(selectedFreq) && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-muted-foreground">{t('cronPage.execTimeLabel')}</label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        value={visualTime}
                        onChange={(e) => handleTimeChange(e.target.value)}
                        className="w-36 rounded-xl bg-background/80 border-border/50 text-xs font-mono h-9"
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2 pt-1 border-t border-border/30">
                <label className="text-xs font-semibold text-muted-foreground">{t('cronPage.cronExprLabel')}</label>
                <div className="flex items-center gap-2">
                  <Input
                    value={newExpr}
                    onChange={(e) => setNewExpr(e.target.value)}
                    placeholder="0 9 * * *"
                    className="font-mono text-xs rounded-xl bg-background/80 border-border/50 h-9 flex-1"
                  />
                  <Badge variant="outline" className="font-mono text-[11px] h-9 px-3 rounded-xl border-border/50">
                    {currentCronInfo.isValid ? t('cronPage.validExpr') : t('cronPage.invalidExpr')}
                  </Badge>
                </div>
              </div>
            )}

            {/* Dynamic Semantic Preview */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-muted/40 border border-border/40 text-xs">
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                {currentCronInfo.label}
              </span>
              {editorMode === 'expert' && (
                <span className="font-mono text-[11px] text-muted-foreground font-semibold bg-muted px-2 py-0.5 rounded border border-border/40">
                  {newExpr}
                </span>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2 border-t border-border/30">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreateOpen(false)}
              className="rounded-xl h-9 px-4 text-xs"
            >
              取消
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newTaskName.trim() || !newExpr.trim() || !currentCronInfo.isValid}
              className="rounded-xl h-9 px-5 font-semibold text-xs bg-foreground text-background hover:bg-foreground/90 shadow-xs select-none"
            >
              <Plus className="h-4 w-4 mr-1.5" /> {t('cronPage.createTask')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
