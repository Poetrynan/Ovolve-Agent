import React from 'react'
import { Sparkles, Terminal, FileCode, Search, Target } from 'lucide-react'
import { useAgentStore } from '../../store/agentStore'
import { MessageItem } from './MessageItem'
import { ActivityFeed } from './ActivityFeed'
import { MessageScroller } from './MessageScroller'
import { Composer } from './Composer'
import { SessionTripartiteCapsule } from './SessionTripartiteCapsule'

export const ConversationView: React.FC = () => {
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const isStreaming = useAgentStore((s) => s.isStreaming)
  const isThinking = useAgentStore((s) => s.isThinking)
  const currentThinking = useAgentStore((s) => s.currentThinking)
  const currentThinkingDuration = useAgentStore((s) => s.currentThinkingDuration)
  const streamingContent = useAgentStore((s) => s.streamingContent)
  const activeToolCalls = useAgentStore((s) => s.activeToolCalls)

  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const messages = activeSession?.messages || []
  const isEmpty = messages.length === 0

  return (
    <div className="relative flex flex-col h-full w-full overflow-hidden">
      {/* 1. Header Bar with docked capsule when active */}
      {!isEmpty && (
        <header className="h-11 px-4 flex items-center justify-between border-b border-border/40 shrink-0 z-20 bg-background/50 backdrop-blur-md">
          <SessionTripartiteCapsule variant="header" className="animate-in fade-in duration-200" />
        </header>
      )}

      {/* 2. Body Viewport */}
      <main className="flex-1 relative flex flex-col min-w-0 overflow-hidden">
        {isEmpty ? (
          /* Hero Center Posture with Apple Spring glide */
          <div className="flex-1 flex flex-col items-center justify-center px-4 max-w-2xl mx-auto w-full animate-in fade-in slide-in-from-bottom-6 duration-400 ease-out-strong select-none">
            {/* Centered Dual-Posture Composer Card */}
            <Composer isHero={true} />
          </div>
        ) : (
          /* Active Chat Viewport with Anti-Fighting Auto-Scroller */
          <>
            <MessageScroller forceScrollKey={messages.length} className="flex-1">
              {messages.map((msg) => (
                <MessageItem key={msg.id} message={msg} />
              ))}

              {/* Streaming In-Flight Live Activity */}
              {(isStreaming || isThinking || activeToolCalls.length > 0 || streamingContent) && (
                <div className="py-4 px-4 flex gap-3.5 bg-card/50 dark:bg-card/30 backdrop-blur-xl rounded-xl border border-border/60 dark:border-white/10 animate-in fade-in duration-150">
                  <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-blue-600 via-indigo-600 to-cyan-500 text-white flex items-center justify-center shrink-0 shadow-sm shadow-blue-500/20 animate-pulse">
                    <Sparkles size={14} />
                  </div>

                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground">OvolveAgent</span>
                      <span className="text-[10px] text-primary font-mono animate-pulse">generating...</span>
                    </div>

                    {/* Live Chronological Activity Stream */}
                    <ActivityFeed
                      reasoning={currentThinking}
                      reasoningDuration={currentThinkingDuration}
                      isThinking={isThinking}
                      toolCalls={activeToolCalls}
                    />

                    {/* Live Streaming Markdown Output */}
                    {streamingContent && (
                      <div className="text-xs text-foreground leading-relaxed whitespace-pre-wrap font-sans break-words pt-1">
                        {streamingContent}
                        <span className="inline-block w-1.5 h-3.5 bg-primary ml-1 animate-pulse" />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </MessageScroller>

            {/* Bottom Floating Composer Dock */}
            <div className="sticky bottom-4 px-4 max-w-3xl mx-auto w-full shrink-0 z-30 animate-in fade-in slide-in-from-bottom-3 duration-300">
              <Composer isHero={false} />
            </div>
          </>
        )}
      </main>
    </div>
  )
}

export default ConversationView
