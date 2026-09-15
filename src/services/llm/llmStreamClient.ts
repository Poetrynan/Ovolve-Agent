export interface StreamToolCallChunk {
  index: number
  id?: string
  name?: string
  argumentsChunk: string
}

export interface AssembledToolCall {
  id: string
  name: string
  arguments: Record<string, any>
  rawArguments: string
}

export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  totalTokens: number
}

export interface StreamEventHandlers {
  onReasoningChunk?: (chunk: string) => void
  onTextChunk?: (chunk: string) => void
  onToolCallDelta?: (toolCall: StreamToolCallChunk) => void
  onComplete?: (result: {
    content: string
    reasoning: string
    toolCalls: AssembledToolCall[]
    usage?: TokenUsage
  }) => void
  onError?: (err: Error) => void
}

export interface StreamRequestParams {
  apiKey: string
  baseUrl: string
  model: string
  messages: Array<{
    role: string
    content: string | any[]
    tool_calls?: any[]
    tool_call_id?: string
  }>
  tools?: any[]
  temperature?: number
  maxTokens?: number
  abortSignal?: AbortSignal
}

export class MultiProviderLLMClient {
  /**
   * Parse Server-Sent Events (SSE) stream buffer into individual event payloads
   */
  public static parseSSELines(chunk: string): Array<{ event?: string; data: string }> {
    const lines = chunk.split(/\r?\n/)
    const events: Array<{ event?: string; data: string }> = []
    let currentEvent: string | undefined
    let currentData: string[] = []

    for (const line of lines) {
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        currentData.push(line.slice(5).trim())
      } else if (line === '') {
        if (currentData.length > 0) {
          events.push({
            event: currentEvent,
            data: currentData.join('\n'),
          })
          currentEvent = undefined
          currentData = []
        }
      }
    }

    if (currentData.length > 0) {
      events.push({
        event: currentEvent,
        data: currentData.join('\n'),
      })
    }

    return events
  }

  /**
   * Stream completions from OpenAI-compatible SSE endpoints
   */
  public async streamCompletion(
    params: StreamRequestParams,
    handlers: StreamEventHandlers
  ): Promise<{
    content: string
    reasoning: string
    toolCalls: AssembledToolCall[]
    usage?: TokenUsage
  }> {
    const { apiKey, baseUrl, model, messages, tools, temperature = 0.6, maxTokens = 8192, abortSignal } = params

    const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
    const body: Record<string, any> = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    }

    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    let accumulatedContent = ''
    let accumulatedReasoning = ''
    let insideThinkTag = false
    const toolCallBuffers: Map<number, { id: string; name: string; rawArgs: string }> = new Map()
    let tokenUsage: TokenUsage | undefined

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: apiKey ? `Bearer ${apiKey}` : '',
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText)
        throw new Error(`LLM API Error (${response.status}): ${errorText}`)
      }

      if (!response.body) {
        throw new Error('Response body is null')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let pendingBuffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        pendingBuffer += decoder.decode(value, { stream: true })
        const events = MultiProviderLLMClient.parseSSELines(pendingBuffer)

        // Keep last incomplete segment in buffer if needed
        const lastDoubleNewline = pendingBuffer.lastIndexOf('\n\n')
        if (lastDoubleNewline !== -1) {
          pendingBuffer = pendingBuffer.slice(lastDoubleNewline + 2)
        }

        for (const evt of events) {
          if (evt.data === '[DONE]') continue

          try {
            const parsed = JSON.parse(evt.data)
            
            // 1. Capture token usage if present
            if (parsed.usage) {
              tokenUsage = {
                promptTokens: parsed.usage.prompt_tokens || 0,
                completionTokens: parsed.usage.completion_tokens || 0,
                cacheHitTokens: parsed.usage.prompt_cache_hit_tokens || 0,
                totalTokens: parsed.usage.total_tokens || 0,
              }
            }

            const choice = parsed.choices?.[0]
            if (!choice) continue

            const delta = choice.delta || {}

            // 2. Capture DeepSeek-R1 style reasoning_content
            if (delta.reasoning_content) {
              accumulatedReasoning += delta.reasoning_content
              handlers.onReasoningChunk?.(delta.reasoning_content)
            }

            // 3. Capture text content with <think> tag parsing
            if (delta.content) {
              let text: string = delta.content

              // Parse inline <think> tags if model emits them as text
              if (text.includes('<think>')) {
                insideThinkTag = true
                const parts = text.split('<think>')
                if (parts[0]) {
                  accumulatedContent += parts[0]
                  handlers.onTextChunk?.(parts[0])
                }
                text = parts[1] || ''
              }

              if (insideThinkTag) {
                if (text.includes('</think>')) {
                  insideThinkTag = false
                  const parts = text.split('</think>')
                  accumulatedReasoning += parts[0]
                  handlers.onReasoningChunk?.(parts[0])
                  if (parts[1]) {
                    accumulatedContent += parts[1]
                    handlers.onTextChunk?.(parts[1])
                  }
                } else {
                  accumulatedReasoning += text
                  handlers.onReasoningChunk?.(text)
                }
              } else {
                accumulatedContent += text
                handlers.onTextChunk?.(text)
              }
            }

            // 4. Capture Tool Call deltas
            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCallBuffers.has(idx)) {
                  toolCallBuffers.set(idx, {
                    id: tc.id || `call_${idx}_${Date.now()}`,
                    name: tc.function?.name || '',
                    rawArgs: '',
                  })
                }

                const buf = toolCallBuffers.get(idx)!
                if (tc.id) buf.id = tc.id
                if (tc.function?.name) buf.name = tc.function.name
                if (tc.function?.arguments) {
                  buf.rawArgs += tc.function.arguments
                  handlers.onToolCallDelta?.({
                    index: idx,
                    id: buf.id,
                    name: buf.name,
                    argumentsChunk: tc.function.arguments,
                  })
                }
              }
            }
          } catch {}
        }
      }

      // Assemble final tool calls
      const assembledToolCalls: AssembledToolCall[] = []
      for (const [, buf] of toolCallBuffers.entries()) {
        let parsedArgs: Record<string, any> = {}
        try {
          parsedArgs = JSON.parse(buf.rawArgs || '{}')
        } catch {
          parsedArgs = { _raw: buf.rawArgs }
        }
        assembledToolCalls.push({
          id: buf.id,
          name: buf.name,
          arguments: parsedArgs,
          rawArguments: buf.rawArgs,
        })
      }

      const result = {
        content: accumulatedContent,
        reasoning: accumulatedReasoning,
        toolCalls: assembledToolCalls,
        usage: tokenUsage,
      }

      handlers.onComplete?.(result)
      return result
    } catch (err: any) {
      handlers.onError?.(err)
      throw err
    }
  }
}
