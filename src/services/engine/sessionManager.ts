import fs from 'node:fs'
import path from 'node:path'
import type { Session, Message } from '../../types/agent'
import { PersistentTerminalManager } from '../tools/persistentTerminal'

export class SessionManager {
  private static instance: SessionManager
  private sessionsDir: string
  private activeSessions = new Map<string, Session>()

  constructor(sessionsDir = '.ovolve/sessions') {
    this.sessionsDir = sessionsDir
    this.ensureDir()
  }

  public static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager()
    }
    return SessionManager.instance
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true })
    }
  }

  public createSession(title = 'New Exploration', workspaceRoot?: string): Session {
    const id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const session: Session = {
      id,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      workspaceRoot,
    }
    this.activeSessions.set(id, session)
    this.saveCheckpoint(session)
    return session
  }

  public getSession(id: string): Session | null {
    if (this.activeSessions.has(id)) {
      return this.activeSessions.get(id)!
    }
    return this.resumeSession(id)
  }

  public saveCheckpoint(session: Session): void {
    try {
      this.ensureDir()
      const filePath = path.join(this.sessionsDir, `${session.id}.json`)
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8')
      this.activeSessions.set(session.id, session)
    } catch {}
  }

  public resumeSession(id: string): Session | null {
    try {
      const filePath = path.join(this.sessionsDir, `${id}.json`)
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8')
        const session: Session = JSON.parse(raw)
        this.activeSessions.set(id, session)
        return session
      }
    } catch {}
    return null
  }

  public listSavedSessions(): Session[] {
    try {
      this.ensureDir()
      const files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith('.json'))
      const list: Session[] = []
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this.sessionsDir, file), 'utf8')
          list.push(JSON.parse(raw))
        } catch {}
      }
      return list.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  public deleteSession(id: string): boolean {
    this.activeSessions.delete(id)
    PersistentTerminalManager.getInstance().closeSession(id)
    try {
      const filePath = path.join(this.sessionsDir, `${id}.json`)
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        return true
      }
    } catch {}
    return false
  }
}
