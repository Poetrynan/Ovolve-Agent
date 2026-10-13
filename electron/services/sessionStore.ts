import fs from 'node:fs'
import path from 'node:path'

export interface PersistedSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: any[]
  workspaceRoot?: string
  gitBranch?: string
}

export class SessionStore {
  private filePath: string

  constructor(configRoot: string) {
    this.filePath = path.join(configRoot, 'sessions.json')
  }

  load(): { sessions: PersistedSession[]; activeSessionId: string | null } {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        const data = JSON.parse(raw)
        return {
          sessions: data.sessions || [],
          activeSessionId: data.activeSessionId || null,
        }
      }
    } catch {}
    return { sessions: [], activeSessionId: null }
  }

  save(sessions: PersistedSession[], activeSessionId: string | null): void {
    const dir = path.dirname(this.filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify({ sessions, activeSessionId }, null, 2), 'utf-8')
  }
}
