import { useEffect, useState } from 'react'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import ChatPage from '@pages/ChatPage'
import GoalsPage from '@pages/GoalsPage'
import SettingsPage from '@pages/SettingsPage'
import CronPage from '@pages/CronPage'
import BotPage from '@pages/BotPage'
import CapabilitiesPage from '@pages/CapabilitiesPage'
import EvolutionPage from '@pages/EvolutionPage'
import ApprovalsPage from '@pages/ApprovalsPage'
import UsagePage from '@pages/UsagePage'
import Sidebar from '@components/sidebar/Sidebar'
import WorkspaceShell from '@components/shell/WorkspaceShell'
import { TooltipProvider } from '@components/ui/tooltip'
import { Toaster } from '@components/ui/sonner'
import { useThemeStore } from '@store/themeStore'
import { useAgentStore } from '@store/agentStore'
import { useModelStore } from '@store/modelStore'
import { startApprovalsPolling } from '@store/approvalsStore'
// Side-effect import: creating the store on app boot pushes the persisted
// closeToTray value to the Electron main process, so the window's close
// handler honors it before the user has visited Settings this session.
import '@store/trayPrefsStore'


function App() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const { resolvedTheme, setTheme } = useThemeStore()

  // Connect to backend WebSocket once at root level
  useEffect(() => {
    void useModelStore.getState().loadProviders()
    useAgentStore.getState().connect()
    // 「演化裁决」的全局轮询：技能候选与演化提案不会主动通知前端，30s 一拉
    startApprovalsPolling()
  }, [])

  // Apply theme class to document element
  useEffect(() => {
    const root = window.document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(resolvedTheme)
  }, [resolvedTheme])

  // Initialize theme from saved preference or default to dark
  useEffect(() => {
    const saved = localStorage.getItem('ovolve-theme')
    if (!saved) {
      setTheme('dark')
    }
  }, [setTheme])

  return (
    <TooltipProvider delayDuration={300}>
      <Toaster position="top-right" richColors />
      <HashRouter>
        <WorkspaceShell
          sidebar={<Sidebar />}
          sidebarOpen={isSidebarOpen}
        >
          <Routes>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/chat" element={
              <ChatPage
                sidebarOpen={isSidebarOpen}
                onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
              />
            } />
            <Route path="/goals" element={<GoalsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/:section" element={<SettingsPage />} />
            {/* First-class pages, NOT redirects into Settings.
                These used to `Navigate` to /settings/xxx, which meant clicking
                「定时任务」 in the sidebar threw the user into the settings
                surface — full settings chrome, settings nav highlighted, and no
                obvious way back. But 定时任务 / 技能 / 机器人 / 用量 are things
                you return to repeatedly to *look at*, not knobs you set once;
                burying them under Settings put recurring work behind a
                configuration door. They are already standalone page components,
                so they render directly here and remain reachable from inside
                Settings as well for anyone who looks there first. */}
            <Route path="/cron" element={<CronPage />} />
            <Route path="/bot" element={<BotPage />} />
            {/* 「能力」 — plugins / skills / MCP / subagents under one roof.
                `/skills` is kept as an alias because the sidebar, slash
                commands and any bookmark pointed there before the merge. */}
            <Route path="/capabilities" element={<CapabilitiesPage />} />
            <Route path="/capabilities/:tab" element={<CapabilitiesPage />} />
            <Route path="/skills" element={<Navigate to="/capabilities/skills" replace />} />
            {/* 「演化」 — the consent queue for self-improvement proposals.
                Accepting one appends a rule to AGENTS.md / MEMORY.md, so this is
                a review surface the user must be able to reach directly, not a
                setting. It is NOT under /settings for that reason. */}
            <Route path="/evolution" element={<EvolutionPage />} />
            <Route path="/approvals" element={<Navigate to="/evolution" replace />} />

            <Route path="/usage" element={<UsagePage />} />
            <Route path="*" element={<Navigate to="/chat" replace />} />
          </Routes>
        </WorkspaceShell>
      </HashRouter>
    </TooltipProvider>
  )
}

export default App
