export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

export interface JSONRPCRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, any>
}

export interface JSONRPCResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: any
  error?: {
    code: number
    message: string
    data?: any
  }
}

export class MCPClient {
  private serverName: string
  private tools: Map<string, MCPToolDefinition> = new Map()

  constructor(serverName: string) {
    this.serverName = serverName
  }

  public getServerName(): string {
    return this.serverName
  }

  public registerTool(tool: MCPToolDefinition): void {
    this.tools.set(tool.name, tool)
  }

  public listTools(): MCPToolDefinition[] {
    return Array.from(this.tools.values())
  }

  public formatAsLLMTools(): Array<{
    type: 'function'
    function: {
      name: string
      description?: string
      parameters: Record<string, any>
    }
  }> {
    return this.listTools().map((t) => ({
      type: 'function',
      function: {
        name: `${this.serverName}__${t.name}`,
        description: t.description || `Tool from ${this.serverName}`,
        parameters: t.inputSchema,
      },
    }))
  }

  public async callTool(toolName: string, args: Record<string, any>): Promise<{ content: string; isError?: boolean }> {
    const rawName = toolName.includes('__') ? toolName.split('__')[1] : toolName
    const tool = this.tools.get(rawName)
    if (!tool) {
      return {
        content: `Error: Tool "${rawName}" not found on MCP server "${this.serverName}"`,
        isError: true,
      }
    }

    return {
      content: `[MCP Server ${this.serverName}] Executed ${rawName} with arguments: ${JSON.stringify(args)}`,
      isError: false,
    }
  }
}

export class MCPClientPool {
  private static instance: MCPClientPool
  private clients: Map<string, MCPClient> = new Map()

  public static getInstance(): MCPClientPool {
    if (!MCPClientPool.instance) {
      MCPClientPool.instance = new MCPClientPool()
    }
    return MCPClientPool.instance
  }

  public registerClient(client: MCPClient): void {
    this.clients.set(client.getServerName(), client)
  }

  public getAllTools(): Array<{
    type: 'function'
    function: {
      name: string
      description?: string
      parameters: Record<string, any>
    }
  }> {
    const allTools: any[] = []
    for (const client of this.clients.values()) {
      allTools.push(...client.formatAsLLMTools())
    }
    return allTools
  }

  public async dispatchToolCall(fullName: string, args: Record<string, any>): Promise<{ content: string; isError?: boolean }> {
    if (!fullName.includes('__')) {
      return { content: `Error: Invalid MCP tool name format "${fullName}"`, isError: true }
    }

    const [serverName, toolName] = fullName.split('__')
    const client = this.clients.get(serverName)
    if (!client) {
      return { content: `Error: MCP Server "${serverName}" is not registered`, isError: true }
    }

    return client.callTool(toolName, args)
  }
}
