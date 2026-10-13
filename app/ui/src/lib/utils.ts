import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN')
}

export function truncate(text: string, maxLen: number = 100): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '...'
}
