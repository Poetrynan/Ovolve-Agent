import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface McpToolDef {
  serverId: string
  serverName: string
  name: string
  description?: string
  inputSchema: Record<string, any>
}

interface PendingReq {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class McpStdioClient {
  private proc: ChildProcess | null = null
  private config: McpServerConfig
  private buffer = ''
  private reqId = 0
  private pending = new Map<string, PendingReq>()
  private tools: McpToolDef[] = []
  private connected = false

  constructor(config: McpServerConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.connected) return

    this.proc = spawn(this.config.command, this.config.args || [], {
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stdout?.on('data', (d: Buffer) => this.onStdout(d.toString()))
    this.proc.stderr?.on('data', () => {})
    this.proc.on('exit', () => { this.connected = false })

    this.connected = true
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ovolve-agent', version: '1.0.0' } })
    await this.notify('notifications/initialized', {})

    const toolsRes = await this.request('tools/list', {})
    const toolList = toolsRes?.tools || []
    this.tools = toolList.map((t: any) => ({
      serverId: this.config.id,
      serverName: this.config.name,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }))
  }

  getTools(): McpToolDef[] { return [...this.tools] }

  async callTool(name: string, args: Record<string, any>): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args })
    const content = res?.content
    if (Array.isArray(content)) {
      return content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
    }
    return JSON.stringify(res)
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && this.pending.has(String(msg.id))) {
          const p = this.pending.get(String(msg.id))!
          clearTimeout(p.timer)
          this.pending.delete(String(msg.id))
          if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'))
          else p.resolve(msg.result)
        }
      } catch {}
    }
  }

  private request(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = String(++this.reqId)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP timeout: ${method}`))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.send({ jsonrpc: '2.0', id: Number(id), method, params })
    })
  }

  private notify(method: string, params: any): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(msg: any): void {
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n')
  }

  disconnect(): void {
    this.proc?.kill()
    this.connected = false
  }
}

export class McpManager {
  private clients = new Map<string, McpStdioClient>()
  private configs: McpServerConfig[] = []

  addServer(config: McpServerConfig): void {
    this.configs.push(config)
  }

  listServers(): McpServerConfig[] { return [...this.configs] }

  async connectAll(): Promise<void> {
    for (const cfg of this.configs) {
      try {
        const client = new McpStdioClient(cfg)
        await client.connect()
        this.clients.set(cfg.id, client)
      } catch (e) {
        console.warn(`[mcp] failed to connect ${cfg.name}:`, e)
      }
    }
  }

  listTools(): McpToolDef[] {
    const all: McpToolDef[] = []
    for (const c of this.clients.values()) all.push(...c.getTools())
    return all
  }

  async callTool(serverId: string, toolName: string, args: Record<string, any>): Promise<string> {
    const client = this.clients.get(serverId)
    if (!client) throw new Error(`MCP server not connected: ${serverId}`)
    return client.callTool(toolName, args)
  }

  findServerForTool(toolName: string): { serverId: string; toolName: string } | null {
    for (const [id, client] of this.clients) {
      for (const t of client.getTools()) {
        if (`mcp__${t.serverName}__${t.name}` === toolName || t.name === toolName) {
          return { serverId: id, toolName: t.name }
        }
      }
    }
    return null
  }
}

let manager: McpManager | null = null

export function getMcpManager(): McpManager {
  if (!manager) {
    manager = new McpManager()
  }
  return manager
}
