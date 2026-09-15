# Experimental Prototype Directory (`/src`)

> **IMPORTANT ARCHITECTURAL NOTICE / 架构说明**:
> 
> 本目录 (`/src`) 为实验性极简重构骨架（Experimental Prototype）。
> 
> **正式的生产级前端主树位于 `app/ui/src`**（与生产 Electron 打包配置完全同构）。
> 包括所有核心交互页面（`ChatPage`、`SettingsPage`、`UsagePage`、`CronPage`、`BotPage`、`SkillsPage` 等）、状态管理、UI 组件库及 Electron IPC 桥接均在 `app/ui/src` 中维护与运行。
> 
> - **生产构建入口**: `vite.config.ts` 根配置严格将 `root` 指向 `app/ui`，输出至 `dist/`。
> - **请勿将生产构建或路由指向此目录**。此目录仅供轻量隔离实验或独立原型验证使用（如 `vite.next.config.ts`）。
