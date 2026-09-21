/**
 * LicenseAttributionBlock — the "where did this come from" panel.
 *
 * Skills, plugins and MCP connectors all arrive from somewhere, and all three
 * surfaces need to say where. Keeping one component means the three answers
 * look the same and cannot drift apart.
 *
 * It renders nothing when there is nothing to say. A panel of empty rows is
 * worse than no panel: it teaches people to skip the section, and then they
 * skip it when it finally has something in it.
 */
import { useState } from 'react'
import { Archive, Check, Copy, ExternalLink, Scale } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export interface LicenseAttributionProps {
  license?: string | null
  /** Page the licence text lives on, when we know it. */
  licenseSource?: string | null
  author?: string | null
  /** The `Copyright (c) ...` line found in the artifact, if any. */
  copyright?: string | null
  /** Upstream repository or homepage, shown as the link text. */
  upstream?: string | null
  /** Where that link should point, when it is not simply `https://` + upstream. */
  upstreamHref?: string | null
  /** Revision the artifact was fetched from, when it is pinned. */
  commitSha?: string | null
  /** Upstream no longer maintains this. */
  archived?: boolean
  /** Licence came from a bundled file rather than declared metadata. */
  licenseFromFile?: boolean
  className?: string
}

/** Tone per licence family, so the badge is readable at a glance. */
const TONES: Array<{ match: RegExp; className: string }> = [
  { match: /^mit\b/i, className: 'bg-emerald-500/10 border-emerald-500/25 text-emerald-600 dark:text-emerald-400' },
  { match: /^apache/i, className: 'bg-sky-500/10 border-sky-500/25 text-sky-600 dark:text-sky-400' },
  { match: /^(bsd|isc)\b/i, className: 'bg-cyan-500/10 border-cyan-500/25 text-cyan-600 dark:text-cyan-400' },
  { match: /^(gpl|agpl|mpl)/i, className: 'bg-violet-500/10 border-violet-500/25 text-violet-600 dark:text-violet-400' },
]

// Anything we do not recognise gets the caution tone rather than a neutral one:
// an unidentified licence is a thing to look at, not a thing to skim past.
const UNKNOWN_TONE = 'bg-amber-500/10 border-amber-500/25 text-amber-600 dark:text-amber-400'

/** "Apache-2.0 (new contributions) / MIT (existing)" → "Apache-2.0". */
function shortLicense(license: string): string {
  return license.split(' (')[0].trim()
}

function toneFor(license: string): string {
  for (const t of TONES) {
    if (t.match.test(license)) return t.className
  }
  return UNKNOWN_TONE
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function LicenseAttributionBlock({
  license,
  licenseSource,
  author,
  copyright,
  upstream,
  upstreamHref,
  commitSha,
  archived,
  licenseFromFile,
  className,
}: LicenseAttributionProps) {
  const [copied, setCopied] = useState(false)

  const licence = (license || '').trim()
  const holder = (copyright || '').trim()
  const who = (author || '').trim()
  const source = (upstream || '').trim()

  if (!licence && !holder && !who && !source && !commitSha && !archived) {
    return null
  }

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be refused; the link below still works, so this
      // is not worth interrupting the user over.
      toast.error('复制失败，请手动选择地址')
    }
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      <h5 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
        来源与许可
      </h5>
      <div className="bg-muted/30 p-3 rounded-xl border border-border/40 space-y-2 text-xs">
        {licence ? (
          <Row label="许可证">
            <a
              href={licenseSource || undefined}
              target="_blank"
              rel="noreferrer"
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border font-mono text-[11px]',
                toneFor(licence),
                licenseSource && 'hover:underline'
              )}
            >
              <Scale className="w-3 h-3" />
              {shortLicense(licence)}
              {licenseSource ? <ExternalLink className="w-2.5 h-2.5 opacity-60" /> : null}
            </a>
          </Row>
        ) : null}

        {holder ? <Row label="版权">{holder}</Row> : null}
        {who ? <Row label="作者">{who}</Row> : null}

        {source ? (
          <Row label="上游">
            <div className="flex items-center gap-1.5 min-w-0">
              <a
                href={upstreamHref || (source.startsWith('http') ? source : `https://${source}`)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-foreground hover:underline break-all inline-flex items-center gap-1 min-w-0"
              >
                <span className="truncate">{source}</span>
                <ExternalLink className="w-2.5 h-2.5 shrink-0 opacity-60" />
              </a>
              <button
                type="button"
                onClick={copySource}
                title="复制上游地址"
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              >
                {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
          </Row>
        ) : null}

        {commitSha ? (
          <Row label="钉住版本">
            <span className="font-mono text-[11px] break-all" title="上游再改动也不会自动生效">
              {commitSha}
            </span>
          </Row>
        ) : null}

        {licenseFromFile ? (
          <p className="text-[10.5px] text-muted-foreground leading-relaxed pt-1 border-t border-border/30">
            许可证读自随附的许可文件，并非作者在元数据里的声明。
          </p>
        ) : null}

        {archived ? (
          <div className="flex items-start gap-2 pt-1 border-t border-border/30">
            <Archive className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
            <span className="text-amber-600 dark:text-amber-400 leading-relaxed">
              上游仓库已归档：代码仍然可用，但已经没有人在维护它，出问题不会有人修。
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
