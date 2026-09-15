// 用于构建 /src（当前前端）的并行配置，与既有 npm run build 互不影响。
//
// 背景：仓库如今有两棵源码树。vite.config.ts 的 root 指向 app/ui（旧 UI），
// 而 tsc / vitest.config.ts / 根 index.html 都认定 /src 是当前前端——也就是说
// 目前"检查新代码、发布旧代码"。
//
// 这个配置让 /src 可以先行构建、试用，不必先把默认构建切过去（切过去会改变
// 线上产物，需要有意识地做一次决定）。确认新前端功能齐备后，把本配置的
// root/outDir 合并进 vite.config.ts 即完成切换。
//
// 用法：npm run build:next
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const repoRoot = __dirname

export default defineConfig({
  plugins: [react()],
  // 入口是仓库根的 index.html，它加载 /src/main.tsx。
  root: repoRoot,
  build: {
    outDir: path.resolve(repoRoot, 'dist-next'),
    emptyOutDir: true,
  },
})
