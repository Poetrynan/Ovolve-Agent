// src/components/ui/OfficialFileIcon.tsx
// Standard, official developer file icons (VSCode / Material / GitHub standard).
// Replaces toy emojis with pixel-perfect brand SVG icons.
import React from 'react'
import { cn } from '@lib/utils'

export interface OfficialFileIconProps extends React.SVGProps<SVGSVGElement> {
  filename?: string
  className?: string
  size?: number
}

export function OfficialFileIcon({ filename = '', className, size = 14, ...props }: OfficialFileIconProps) {
  const lower = filename.toLowerCase()
  const ext = lower.split('.').pop() || ''
  const isSpecial = lower === 'dockerfile' || lower.startsWith('.git') || lower.startsWith('.env')

  // 1. Python (.py, .pyw, .ipynb) - Official Python dual-tone snake
  if (ext === 'py' || ext === 'pyw' || ext === 'ipynb') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none', className)}
        {...props}
      >
        <path
          fill="#387eb8"
          d="M63.5 12.3c-28.7 0-27 12.5-27 12.5l.03 12.9h27.4v3.9H25.3S7.7 39.7 7.7 68.3c0 28.6 15.4 27.6 15.4 27.6h9.2v-12.9c0-14.8 12.8-14.4 12.8-14.4h27.2c12.2 0 12.2-11.7 12.2-11.7V24.5c0-12.2-19-12.2-19-12.2zm-14.7 7.7c2.5 0 4.5 2 4.5 4.5s-2 4.5-4.5 4.5-4.5-2-4.5-4.5 2-4.5 4.5-4.5z"
        />
        <path
          fill="#ffe052"
          d="M64.5 115.7c28.7 0 27-12.5 27-12.5l-.03-12.9H64.1v-3.9h38.6s17.6 1.9 17.6-26.7c0-28.6-15.4-27.6-15.4-27.6h-9.2v12.9c0 14.8-12.8 14.4-12.8 14.4H45.7c-12.2 0-12.2 11.7-12.2 11.7v32.4c0 12.2 19 12.2 19 12.2zm14.7-7.7c-2.5 0-4.5-2-4.5-4.5s2-4.5 4.5-4.5 4.5 2 4.5 4.5-2 4.5-4.5 4.5z"
        />
      </svg>
    )
  }

  // 2. PowerShell (.ps1, .psm1, .psd1) - Official PowerShell Terminal Prompt
  if (ext === 'ps1' || ext === 'psm1' || ext === 'psd1') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none', className)}
        {...props}
      >
        <rect width="116" height="100" x="6" y="14" rx="14" fill="#012456" stroke="#2a6099" strokeWidth="6" />
        <path d="M28 44 L52 64 L28 84" fill="none" stroke="#5391fe" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="62" y1="84" x2="96" y2="84" stroke="#ffffff" strokeWidth="12" strokeLinecap="round" />
      </svg>
    )
  }

  // 3. React / TSX (.tsx, .jsx) - Official React Cyan Atom
  if (ext === 'tsx' || ext === 'jsx') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none', className)}
        {...props}
      >
        <circle cx="64" cy="64" r="11" fill="#00d8ff" />
        <ellipse cx="64" cy="64" rx="54" ry="20" fill="none" stroke="#00d8ff" strokeWidth="7" />
        <ellipse cx="64" cy="64" rx="54" ry="20" fill="none" stroke="#00d8ff" strokeWidth="7" transform="rotate(60 64 64)" />
        <ellipse cx="64" cy="64" rx="54" ry="20" fill="none" stroke="#00d8ff" strokeWidth="7" transform="rotate(120 64 64)" />
      </svg>
    )
  }

  // 4. TypeScript (.ts, .mts, .cts) - Official TS Blue Square
  if (ext === 'ts' || ext === 'mts' || ext === 'cts') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none', className)}
        {...props}
      >
        <rect width="116" height="116" x="6" y="6" rx="16" fill="#3178c6" />
        <path
          fill="#ffffff"
          d="M62 42 H26 V54 H38 V98 H50 V54 H62 V42 Z M72 74 C72 66 78 62 88 62 C96 62 102 65 104 68 L98 77 C95 75 92 73 88 73 C84 73 82 75 82 78 C82 82 86 84 92 86 C101 90 106 94 106 102 C106 112 97 116 86 116 C76 116 68 111 65 106 L73 97 C76 100 81 103 86 103 C91 103 94 101 94 97 C94 93 90 91 84 89 C76 85 72 81 72 74 Z"
        />
      </svg>
    )
  }

  // 5. JavaScript (.js, .mjs, .cjs) - Official JS Yellow Square
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none', className)}
        {...props}
      >
        <rect width="116" height="116" x="6" y="6" rx="16" fill="#f7df1e" />
        <path
          fill="#000000"
          d="M34 84 C34 94 40 98 48 98 C54 98 58 95 60 92 L60 44 H48 V82 C48 85 46 87 43 87 C40 87 38 85 38 82 L34 84 Z M74 74 C74 66 80 62 90 62 C98 62 104 65 106 68 L100 77 C97 75 94 73 90 73 C86 73 84 75 84 78 C84 82 88 84 94 86 C103 90 108 94 108 102 C108 112 99 116 88 116 C78 116 70 111 67 106 L75 97 C78 100 83 103 88 103 C93 103 96 101 96 97 C96 93 92 91 86 89 C78 85 74 81 74 74 Z"
        />
      </svg>
    )
  }

  // 6. JSON (.json, .jsonc)
  if (ext === 'json' || ext === 'jsonc') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none text-amber-500', className)}
        {...props}
      >
        <rect width="116" height="116" x="6" y="6" rx="16" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="6" />
        <text x="64" y="80" fill="currentColor" fontSize="62" fontWeight="bold" fontFamily="monospace" textAnchor="middle">
          {'{ }'}
        </text>
      </svg>
    )
  }

  // 7. Markdown (.md, .markdown, .mdx) - Official M↓
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none text-sky-500 dark:text-sky-400', className)}
        {...props}
      >
        <rect width="116" height="96" x="6" y="16" rx="12" fill="none" stroke="currentColor" strokeWidth="10" />
        <path d="M22 84 V44 L38 64 L54 44 V84" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M84 44 V74 M70 60 L84 76 L98 60" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  // 8. Rust (.rs) - Official Rust Gear
  if (ext === 'rs') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none text-orange-600 dark:text-orange-400', className)}
        {...props}
      >
        <circle cx="64" cy="64" r="50" fill="none" stroke="currentColor" strokeWidth="10" strokeDasharray="14 6" />
        <circle cx="64" cy="64" r="32" fill="none" stroke="currentColor" strokeWidth="6" />
        <text x="64" y="78" fill="currentColor" fontSize="46" fontWeight="900" fontFamily="sans-serif" textAnchor="middle">
          R
        </text>
      </svg>
    )
  }

  // 9. Go (.go) - Official Go Cyan Logo
  if (ext === 'go') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none text-cyan-500', className)}
        {...props}
      >
        <rect width="116" height="116" x="6" y="6" rx="16" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="6" />
        <text x="64" y="78" fill="currentColor" fontSize="48" fontWeight="bold" fontFamily="sans-serif" textAnchor="middle">
          GO
        </text>
      </svg>
    )
  }

  // 10. CSS / SCSS / LESS
  if (ext === 'css' || ext === 'scss' || ext === 'less') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none', className)}
        {...props}
      >
        <path d="M18 12 L28 114 L64 124 L100 114 L110 12 Z" fill="#1572b6" />
        <path d="M64 22 L64 113 L91 105 L99 22 Z" fill="#33a9dc" />
        <path d="M38 40 H90 L88 60 H40 L42 80 H86 L83 98 L64 103 L45 98 L44 86" fill="none" stroke="#ffffff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  // 11. HTML
  if (ext === 'html' || ext === 'htm') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none', className)}
        {...props}
      >
        <path d="M18 12 L28 114 L64 124 L100 114 L110 12 Z" fill="#e44d26" />
        <path d="M64 22 L64 113 L91 105 L99 22 Z" fill="#f16529" />
        <path d="M38 40 H90 M40 60 H88 M40 80 H86 L83 98 L64 103 L45 98 L44 86" fill="none" stroke="#ffffff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }

  // 12. Shell / Bash / Zsh (.sh, .bash, .zsh)
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none text-emerald-500', className)}
        {...props}
      >
        <rect width="116" height="96" x="6" y="16" rx="14" fill="currentColor" fillOpacity="0.12" stroke="currentColor" strokeWidth="8" />
        <path d="M28 44 L50 64 L28 84" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="60" y1="84" x2="94" y2="84" stroke="currentColor" strokeWidth="10" strokeLinecap="round" />
      </svg>
    )
  }

  // 13. Git (.gitignore, .gitmodules)
  if (isSpecial && lower.includes('git')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none text-orange-500', className)}
        {...props}
      >
        <path
          fill="currentColor"
          d="M122 55 L73 6 C70 3 65 3 62 6 L6 62 C3 65 3 70 6 73 L55 122 C58 125 63 125 66 122 L122 66 C125 63 125 58 122 55 Z M48 76 C42 76 38 72 38 66 C38 60 42 56 48 56 C54 56 58 60 58 66 C58 72 54 76 48 76 Z M80 44 C74 44 70 40 70 34 C70 28 74 24 80 24 C86 24 90 28 90 34 C90 40 86 44 80 44 Z"
        />
      </svg>
    )
  }

  // 14. Docker (Dockerfile)
  if (isSpecial && lower.includes('docker')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 128 128"
        className={cn('inline-block shrink-0 select-none text-sky-500', className)}
        {...props}
      >
        <rect width="18" height="14" x="42" y="38" fill="currentColor" rx="2" />
        <rect width="18" height="14" x="64" y="38" fill="currentColor" rx="2" />
        <rect width="18" height="14" x="86" y="38" fill="currentColor" rx="2" />
        <rect width="18" height="14" x="42" y="56" fill="currentColor" rx="2" />
        <rect width="18" height="14" x="64" y="56" fill="currentColor" rx="2" />
        <rect width="18" height="14" x="86" y="56" fill="currentColor" rx="2" />
        <path d="M10 76 C16 98 44 104 74 104 C112 104 122 84 122 84 C116 86 104 84 98 76 C98 76 92 76 86 76 H10 Z" fill="currentColor" />
      </svg>
    )
  }

  // 15. Default Document
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      className={cn('inline-block shrink-0 select-none text-muted-foreground/70', className)}
      {...props}
    >
      <path d="M28 14 H78 L104 40 V114 H28 Z" fill="none" stroke="currentColor" strokeWidth="8" strokeLinejoin="round" />
      <path d="M78 14 V40 H104" fill="none" stroke="currentColor" strokeWidth="8" strokeLinejoin="round" />
      <line x1="42" y1="62" x2="86" y2="62" stroke="currentColor" strokeWidth="8" strokeLinecap="round" />
      <line x1="42" y1="82" x2="86" y2="82" stroke="currentColor" strokeWidth="8" strokeLinecap="round" />
    </svg>
  )
}
export default OfficialFileIcon
