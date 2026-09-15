import React, { useEffect } from 'react'
import { AppLayout } from './components/layout/AppLayout'
// 实时桥（单例）：后端 /ws → store 的唯一入站通路。断线指数退避静默重连，
// 后端不在时保持演示驱动（零 UI 副作用、控制台不刷屏）；卸载即停。
import { startLiveBridge } from './lib/liveBridge'

export const App: React.FC = () => {
  // 根级挂载一次；StrictMode 双挂载下 start/stop 幂等自愈。
  useEffect(() => startLiveBridge(), [])
  return <AppLayout />
}

export default App
