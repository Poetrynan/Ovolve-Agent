// src/lib/utils.ts
// Tailwind 类名合并工具：clsx 组合 + tailwind-merge 去冲突。
// Ovolve 的 ui/button.tsx 内有一份私有实现；这里提供可共享的出口，
// 供聊天媒体卡 / 目标流水线等新组件复用，不改既有组件。
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
