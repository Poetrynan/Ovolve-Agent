export type ActionRiskTier = 'READ_ONLY' | 'MUTATION' | 'DESTRUCTIVE'

export interface PendingActionApproval {
  id: string
  toolName: string
  args: Record<string, any>
  riskTier: ActionRiskTier
  riskReason: string
  timestamp: number
  resolve: (approved: boolean) => void
}

export class PermissionGate {
  private static instance: PermissionGate
  private pendingApprovals: Map<string, PendingActionApproval> = new Map()
  private onApprovalRequiredListener?: (approval: PendingActionApproval) => void
  private alwaysAllowedPatterns: Set<string> = new Set()

  public static getInstance(): PermissionGate {
    if (!PermissionGate.instance) {
      PermissionGate.instance = new PermissionGate()
    }
    return PermissionGate.instance
  }

  public setOnApprovalRequired(listener: (approval: PendingActionApproval) => void): void {
    this.onApprovalRequiredListener = listener
  }

  /**
   * Classify risk tier of tool invocation
   */
  public classifyAction(toolName: string, args: Record<string, any>): { tier: ActionRiskTier; reason: string } {
    const readOnlyTools = new Set(['read_file', 'list_dir', 'search_code', 'git_status', 'git_diff', 'git_log', 'system_info', 'tool_search'])
    if (readOnlyTools.has(toolName)) {
      return { tier: 'READ_ONLY', reason: 'Safe read-only inspection' }
    }

    if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'replace_file_content') {
      return { tier: 'MUTATION', reason: `File modification on ${args.targetFile || args.path || 'workspace'}` }
    }

    if (toolName === 'run_command' || toolName === 'execute_shell') {
      const cmd = String(args.command || args.CommandLine || '').toLowerCase()
      
      const dangerousKeywords = [
        'rm -rf',
        'rmdir /s',
        'del /f /s /q',
        'git push -f',
        'git push --force',
        'git reset --hard',
        'git clean -fdx',
        'drop database',
        'drop table',
        'mkfs',
        'format c:',
      ]

      for (const kw of dangerousKeywords) {
        if (cmd.includes(kw)) {
          return { tier: 'DESTRUCTIVE', reason: `Potentially destructive shell command detected containing "${kw}"` }
        }
      }

      return { tier: 'MUTATION', reason: 'Terminal shell execution' }
    }

    return { tier: 'MUTATION', reason: `Execution of tool ${toolName}` }
  }

  /**
   * Check permission and suspend for user approval if action is DESTRUCTIVE
   */
  public async checkOrRequestApproval(
    toolName: string,
    args: Record<string, any>
  ): Promise<{ approved: boolean; riskTier: ActionRiskTier; reason: string }> {
    const { tier, reason } = this.classifyAction(toolName, args)

    if (tier === 'READ_ONLY' || tier === 'MUTATION') {
      return { approved: true, riskTier: tier, reason }
    }

    // Check if pattern is in whitelist
    const patternKey = `${toolName}:${JSON.stringify(args)}`
    if (this.alwaysAllowedPatterns.has(patternKey)) {
      return { approved: true, riskTier: tier, reason: 'Whitelisted by user' }
    }

    // Suspend and await user approval
    const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    return new Promise<{ approved: boolean; riskTier: ActionRiskTier; reason: string }>((resolve) => {
      const pending: PendingActionApproval = {
        id,
        toolName,
        args,
        riskTier: tier,
        riskReason: reason,
        timestamp: Date.now(),
        resolve: (approved: boolean) => {
          this.pendingApprovals.delete(id)
          resolve({ approved, riskTier: tier, reason })
        },
      }

      this.pendingApprovals.set(id, pending)
      this.onApprovalRequiredListener?.(pending)
    })
  }

  public resolveApproval(id: string, approved: boolean, alwaysAllow = false): boolean {
    const pending = this.pendingApprovals.get(id)
    if (!pending) return false

    if (approved && alwaysAllow) {
      this.alwaysAllowedPatterns.add(`${pending.toolName}:${JSON.stringify(pending.args)}`)
    }

    pending.resolve(approved)
    return true
  }

  public getPendingApprovals(): PendingActionApproval[] {
    return Array.from(this.pendingApprovals.values())
  }
}
