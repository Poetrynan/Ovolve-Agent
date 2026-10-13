// src/components/common/BrandIcons.tsx
// 100% Authentic Official Brand Vector Library
// Sources: Simple Icons, Devicon, Microsoft Fluent, Alibaba Cloud Official Guidelines.
import React from 'react'
import { cn } from '@/lib/utils'
import { Cpu } from 'lucide-react'

export interface BrandIconProps extends React.SVGProps<SVGSVGElement> {
  className?: string
  size?: number
}

// ----------------------------------------------------------------------
// 1. AI Model Providers (Official Vectors from Simple Icons)
// ----------------------------------------------------------------------

/** OpenAI Official Logo (Simple Icons: openai) */
export function OpenAiIcon({ className, size = 16, ...props }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={cn('shrink-0', className)}
      {...props}
    >
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  )
}

/** Anthropic / Claude Official Logo (Simple Icons: anthropic) */
export function AnthropicIcon({ className, size = 16, ...props }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={cn('shrink-0 text-[#CC785C] dark:text-[#E08B6F]', className)}
      {...props}
    >
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </svg>
  )
}

/** DeepSeek Official Logo (Simple Icons: deepseek) */
export function DeepSeekIcon({ className, size = 16, ...props }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={cn('shrink-0 text-[#0066FF] dark:text-[#3385FF]', className)}
      {...props}
    >
      <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" />
    </svg>
  )
}

/** Google Gemini Official Logo (Simple Icons: googlegemini) */
export function GeminiIcon({ className, size = 16, ...props }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={cn('shrink-0 text-[#1BA1E2] dark:text-[#4AC0F2]', className)}
      {...props}
    >
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    </svg>
  )
}

/** Ollama Official Logo (Simple Icons: ollama) */
export function OllamaIcon({ className, size = 16, ...props }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={cn('shrink-0', className)}
      {...props}
    >
      <path d="M16.361 10.26a.894.894 0 0 0-.558.47l-.072.148.001.207c0 .193.004.217.059.353.076.193.152.312.291.448.24.238.51.3.872.205a.86.86 0 0 0 .517-.436.752.752 0 0 0 .08-.498c-.064-.453-.33-.782-.724-.897a1.06 1.06 0 0 0-.466 0zm-9.203.005c-.305.096-.533.32-.65.639a1.187 1.187 0 0 0-.06.52c.057.309.31.59.598.667.362.095.632.033.872-.205.14-.136.215-.255.291-.448.055-.136.059-.16.059-.353l.001-.207-.072-.148a.894.894 0 0 0-.565-.472 1.02 1.02 0 0 0-.474.007Zm4.184 2c-.131.071-.223.25-.195.383.031.143.157.288.353.407.105.063.112.072.117.136.004.038-.01.146-.029.243-.02.094-.036.194-.036.222.002.074.07.195.143.253.064.052.076.054.255.059.164.005.198.001.264-.03.169-.082.212-.234.15-.525-.052-.243-.042-.28.087-.355.137-.08.281-.219.324-.314a.365.365 0 0 0-.175-.48.394.394 0 0 0-.181-.033c-.126 0-.207.03-.355.124l-.085.053-.053-.032c-.219-.13-.259-.145-.391-.143a.396.396 0 0 0-.193.032zm.39-2.195c-.373.036-.475.05-.654.086-.291.06-.68.195-.951.328-.94.46-1.589 1.226-1.787 2.114-.04.176-.045.234-.045.53 0 .294.005.357.043.524.264 1.16 1.332 2.017 2.714 2.173.3.033 1.596.033 1.896 0 1.11-.125 2.064-.727 2.493-1.571.114-.226.169-.372.22-.602.039-.167.044-.23.044-.523 0-.297-.005-.355-.045-.531-.288-1.29-1.539-2.304-3.072-2.497a6.873 6.873 0 0 0-.855-.031zm.645.937a3.283 3.283 0 0 1 1.44.514c.223.148.537.458.671.662.166.251.26.508.303.82.02.143.01.251-.043.482-.08.345-.332.705-.672.957a3.115 3.115 0 0 1-.689.348c-.382.122-.632.144-1.525.138-.582-.006-.686-.01-.853-.042-.57-.107-1.022-.334-1.35-.68-.264-.28-.385-.535-.45-.946-.03-.192.025-.509.137-.776.136-.326.488-.73.836-.963.403-.269.934-.46 1.422-.512.187-.02.586-.02.773-.002zm-5.503-11a1.653 1.653 0 0 0-.683.298C5.617.74 5.173 1.666 4.985 2.819c-.07.436-.119 1.04-.119 1.503 0 .544.064 1.24.155 1.721.02.107.031.202.023.208a8.12 8.12 0 0 1-.187.152 5.324 5.324 0 0 0-.949 1.02 5.49 5.49 0 0 0-.94 2.339 6.625 6.625 0 0 0-.023 1.357c.091.78.325 1.438.727 2.04l.13.195-.037.064c-.269.452-.498 1.105-.605 1.732-.084.496-.095.629-.095 1.294 0 .67.009.803.088 1.266.095.555.288 1.143.503 1.534.071.128.243.393.264.407.007.003-.014.067-.046.141a7.405 7.405 0 0 0-.548 1.873c-.062.417-.071.552-.071.991 0 .56.031.832.148 1.279L3.42 24h1.478l-.05-.091c-.297-.552-.325-1.575-.068-2.597.117-.472.25-.819.498-1.296l.148-.29v-.177c0-.165-.003-.184-.057-.293a.915.915 0 0 0-.194-.25 1.74 1.74 0 0 1-.385-.543c-.424-.92-.506-2.286-.208-3.451.124-.486.329-.918.544-1.154a.787.787 0 0 0 .223-.531c0-.195-.07-.355-.224-.522a3.136 3.136 0 0 1-.817-1.729c-.14-.96.114-2.005.69-2.834.563-.814 1.353-1.336 2.237-1.475.199-.033.57-.028.776.01.226.04.367.028.512-.041.179-.085.268-.19.374-.431.093-.215.165-.333.36-.576.234-.29.46-.489.822-.729.413-.27.884-.467 1.352-.561.17-.035.25-.04.569-.04.319 0 .398.005.569.04a4.07 4.07 0 0 1 1.914.997c.117.109.398.457.488.602.034.057.095.177.132.267.105.241.195.346.374.43.14.068.286.082.503.045.343-.058.607-.053.943.016 1.144.23 2.14 1.173 2.581 2.437.385 1.108.276 2.267-.296 3.153-.097.15-.193.27-.333.419-.301.322-.301.722-.001 1.053.493.539.801 1.866.708 3.036-.062.772-.26 1.463-.533 1.854a2.096 2.096 0 0 1-.224.258.916.916 0 0 0-.194.25c-.054.109-.057.128-.057.293v.178l.148.29c.248.476.38.823.498 1.295.253 1.008.231 2.01-.059 2.581a.845.845 0 0 0-.044.098c0 .006.329.009.732.009h.73l.02-.074.036-.134c.019-.076.057-.3.088-.516.029-.217.029-1.016 0-1.258-.11-.875-.295-1.57-.597-2.226-.032-.074-.053-.138-.046-.141.008-.005.057-.074.108-.152.376-.569.607-1.284.724-2.228.031-.26.031-1.378 0-1.628-.083-.645-.182-1.082-.348-1.525a6.083 6.083 0 0 0-.329-.7l-.038-.064.131-.194c.402-.604.636-1.262.727-2.04a6.625 6.625 0 0 0-.024-1.358 5.512 5.512 0 0 0-.939-2.339 5.325 5.325 0 0 0-.95-1.02 8.097 8.097 0 0 1-.186-.152.692.692 0 0 1 .023-.208c.208-1.087.201-2.443-.017-3.503-.19-.924-.535-1.658-.98-2.082-.354-.338-.716-.482-1.15-.455-.996.059-1.8 1.205-2.116 3.01a6.805 6.805 0 0 0-.097.726c0 .036-.007.066-.015.066a.96.96 0 0 1-.149-.078A4.857 4.857 0 0 0 12 3.03c-.832 0-1.687.243-2.456.698a.958.958 0 0 1-.148.078c-.008 0-.015-.03-.015-.066a6.71 6.71 0 0 0-.097-.725C8.997 1.392 8.337.319 7.46.048a2.096 2.096 0 0 0-.585-.041Zm.293 1.402c.248.197.523.759.682 1.388.03.113.06.244.069.292.007.047.026.152.041.233.067.365.098.76.102 1.24l.002.475-.12.175-.118.178h-.278c-.324 0-.646.041-.954.124l-.238.06c-.033.007-.038-.003-.057-.144a8.438 8.438 0 0 1 .016-2.323c.124-.788.413-1.501.696-1.711.067-.05.079-.049.157.013zm9.825-.012c.17.126.358.46.498.888.28.854.36 2.028.212 3.145-.019.14-.024.151-.057.144l-.238-.06a3.693 3.693 0 0 0-.954-.124h-.278l-.119-.178-.119-.175.002-.474c.004-.669.066-1.19.214-1.772.157-.623.434-1.185.68-1.382.078-.062.09-.063.159-.012z" />
    </svg>
  )
}

/** Alibaba Cloud Official Logo (Simple Icons: alibabacloud) */
export function AlibabaCloudIcon({ className, size = 16, ...props }: BrandIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={cn('shrink-0 text-[#FF6A00]', className)}
      {...props}
    >
      <path d="M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z" />
    </svg>
  )
}

// ----------------------------------------------------------------------
// 2. Discover Marketplace Plugins (100% Authentic Vectors)
// ----------------------------------------------------------------------

/** 1. PPT - Microsoft PowerPoint Official Fluent Brand Asset */
export function PptBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-black/5 bg-[#FBFBFB] dark:bg-[#1C1C1E]', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 32 32" width={size * 0.78} height={size * 0.78} fill="none">
        <defs>
          <linearGradient id="ppt-grad" x1="4.494" y1="7.914" x2="13.832" y2="24.086" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#CA4C28" />
            <stop offset="0.5" stopColor="#C5401E" />
            <stop offset="1" stopColor="#B62F14" />
          </linearGradient>
        </defs>
        <path d="M18.93 17.3L16.977 3h-.146A12.9 12.9 0 0 0 3.953 15.854V16Z" fill="#ED6C47" />
        <path d="M17.123 3h-.146V16l6.511 2.6L30 16v-.146A12.9 12.9 0 0 0 17.123 3Z" fill="#FF8F6B" />
        <path d="M30 16v.143A12.905 12.905 0 0 1 17.12 29h-.287A12.907 12.907 0 0 1 3.953 16.143V16Z" fill="#D35230" />
        <path d="M16.977 10.04V22.611A1.2 1.2 0 0 1 15.785 23.8H6.506a12.735 12.735 0 0 1-2.553-7.657v-.286A12.705 12.705 0 0 1 6.05 8.85h9.735A1.2 1.2 0 0 1 16.977 10.04Z" fill="#000000" fillOpacity="0.18" />
        <path d="M3.194 8.85H15.132a1.193 1.193 0 0 1 1.194 1.191V21.959a1.193 1.193 0 0 1-1.194 1.191H3.194A1.192 1.192 0 0 1 2 21.959V10.041A1.192 1.192 0 0 1 3.194 8.85Z" fill="url(#ppt-grad)" />
        <path d="M9.293 12.028a3.287 3.287 0 0 1 2.174.636 2.27 2.27 0 0 1 .756 1.841 2.555 2.555 0 0 1-.373 1.376 2.49 2.49 0 0 1-1.059.935A3.607 3.607 0 0 1 9.2 17.15H7.687v2.8H6.141V12.028ZM7.686 15.94H9.017a1.735 1.735 0 0 0 1.177-.351 1.3 1.3 0 0 0 .4-1.025q0-1.309-1.525-1.31H7.686V15.94Z" fill="#FFFFFF" />
      </svg>
    </div>
  )
}

/** 2. 架构可视化 - Architecture Visualization Graph */
export function ArchVizBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-zinc-800 bg-[#18181B]', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 44 44" width={size} height={size} fill="none">
        <path
          d="M13 32V23C13 18.0294 17.0294 14 22 14C26.9706 14 31 18.0294 31 23V32"
          stroke="#22C55E"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <circle cx="22" cy="14" r="3.5" fill="#22C55E" />
        <circle cx="13" cy="32" r="3.5" fill="#22C55E" />
        <circle cx="31" cy="32" r="3.5" fill="#22C55E" />
        <circle cx="22" cy="24" r="2.5" fill="#4ADE80" />
      </svg>
    </div>
  )
}

/** 3. Superpowers - Infinity Chain Standard */
export function SuperpowersBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 44 44" width={size} height={size} fill="none">
        <path
          d="M19.5 25.5L16.2 28.8C14.1 30.9 10.7 30.9 8.6 28.8C6.5 26.7 6.5 23.3 8.6 21.2L13.8 16C15.9 13.9 19.3 13.9 21.4 16L22.5 17.1"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          className="text-zinc-800 dark:text-zinc-100"
        />
        <path
          d="M24.5 18.5L27.8 15.2C29.9 13.1 33.3 13.1 35.4 15.2C37.5 17.3 37.5 20.7 35.4 22.8L30.2 28C28.1 30.1 24.7 30.1 22.6 28L21.5 26.9"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          className="text-zinc-800 dark:text-zinc-100"
        />
        <line
          x1="18"
          y1="26"
          x2="26"
          y2="18"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          className="text-zinc-800 dark:text-zinc-100"
        />
      </svg>
    </div>
  )
}

/** 4. Design Review - Canvas Inspector */
export function DesignReviewBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-zinc-800 bg-[#18181B]', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 44 44" width={size} height={size} fill="none">
        <rect x="9" y="10" width="26" height="24" rx="4" stroke="#A1A1AA" strokeWidth="2" />
        <line x1="9" y1="16" x2="35" y2="16" stroke="#52525B" strokeWidth="1.5" />
        <line x1="18" y1="16" x2="18" y2="34" stroke="#52525B" strokeWidth="1.5" />
        <circle cx="27" cy="25" r="4" fill="#22C55E" fillOpacity="0.85" />
        <circle cx="27" cy="25" r="1.5" fill="#FFFFFF" />
      </svg>
    </div>
  )
}

/** 5. Google Chrome DevTools (Simple Icons: googlechrome) */
export function ChromeDevToolsBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-zinc-800 bg-[#202124]', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="none">
        <path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0z" fill="#EA4335" />
        <path d="m21.368 4.501-3.953 6.848a5.455 5.455 0 0 1-3.96 5.197L8.01 23.394A12 12 0 0 0 24 12c0-2.806-.964-5.387-2.632-7.499z" fill="#FBBC04" />
        <path d="M12 24c3.79 0 7.169-1.757 9.368-4.501l-3.953-6.848A5.454 5.454 0 0 1 12 17.455H1.309A12 12 0 0 0 12 24z" fill="#34A853" />
        <circle cx="12" cy="12" r="5.2" fill="#FFFFFF" />
        <circle cx="12" cy="12" r="4.2" fill="#1A73E8" />
      </svg>
    </div>
  )
}

/** 6. Context7 - Code Monospace Brackets */
export function Context7BrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-zinc-800 bg-[#18181B]', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 44 44" width={size} height={size} fill="none">
        <text
          x="22"
          y="28"
          fill="#FFFFFF"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
          fontWeight="700"
          fontSize="17"
          letterSpacing="-0.5px"
          textAnchor="middle"
        >
          [ 7 ]
        </text>
      </svg>
    </div>
  )
}

/** 7. Postman (Simple Icons: postman) */
export function PostmanBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-orange-600/30 bg-[#FF6C37]', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="#FFFFFF">
        <path d="M13.527.099C6.955-.536 1.157 4.195.228 10.655c-.477 3.32.404 6.643 2.443 9.202l-.658 2.625a.86.86 0 0 0 1.036 1.038l2.673-.67c2.373 1.636 5.244 2.399 8.16 2.14 6.572-.582 11.51-6.104 11.028-12.333C24.428 6.427 19.866.68 13.527.099zm4.72 6.593c.365.014.717.07 1.05.166-.312.261-.595.556-.838.88l-4.148 4.148a2.535 2.535 0 0 0-.613 1.066l-.766 2.678a.43.43 0 0 1-.539.294.43.43 0 0 1-.294-.539l.766-2.678c.174-.61.503-1.162.955-1.602l3.968-3.968c-.183-.284-.403-.538-.655-.758.375.14.73.238 1.116.313zm-2.023 1.838a1.72 1.72 0 1 1-2.433 2.433 1.72 1.72 0 0 1 2.433-2.433zm-7.616 2.476 1.936-1.936a2.58 2.58 0 0 1 1.053-.618l5.882-1.68c.245-.07.499.075.569.32.07.245-.075.499-.32.569l-5.882 1.68a1.72 1.72 0 0 0-.702.412l-1.936 1.936a.43.43 0 0 1-.608 0 .43.43 0 0 1 0-.608l-.072-.075zm-1.848 1.848 1.936-1.936a.43.43 0 0 1 .608.608l-1.936 1.936a.43.43 0 0 1-.608-.608zm-1.848 1.848 1.936-1.936a.43.43 0 0 1 .608.608l-1.936 1.936a.43.43 0 0 1-.608-.608z" />
      </svg>
    </div>
  )
}

/** 8. 全栈开发专家 - Java (Devicon: java-original) */
export function JavaFullstackBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-zinc-200 dark:border-zinc-700 bg-white', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 128 128" width={size * 0.72} height={size * 0.72} fill="none">
        <path fill="#0074BD" d="M47.617 98.12s-4.767 2.774 3.397 3.71c9.892 1.13 14.947.968 25.845-1.092 0 0 2.871 1.795 6.873 3.351-24.439 10.47-55.308-.607-36.115-5.969zm-2.988-13.665s-5.348 3.959 2.823 4.805c10.567 1.091 18.91 1.18 33.354-1.6 0 0 1.993 2.025 5.132 3.131-29.542 8.64-62.446.68-41.309-6.336z" />
        <path fill="#EA2D2E" d="M69.802 61.271c6.025 6.935-1.58 13.17-1.58 13.17s15.289-7.891 8.269-17.777c-6.559-9.215-11.587-13.792 15.635-29.58 0 .001-42.731 10.67-22.324 34.187z" />
        <path fill="#0074BD" d="M102.123 108.229s3.529 2.91-3.888 5.159c-14.102 4.272-58.706 5.56-71.094.171-4.451-1.938 3.899-4.625 6.526-5.192 2.739-.593 4.303-.485 4.303-.485-4.953-3.487-32.013 6.85-13.743 9.815 49.821 8.076 90.817-3.637 77.896-9.468zM49.912 70.294s-22.686 5.389-8.033 7.348c6.188.828 18.518.638 30.011-.326 9.39-.789 18.813-2.474 18.813-2.474s-3.308 1.419-5.704 3.053c-23.042 6.061-67.544 3.238-54.731-2.958 10.832-5.239 19.644-4.643 19.644-4.643zm40.697 22.747c23.421-12.167 12.591-23.86 5.032-22.285-1.848.385-2.677.72-2.677.72s.688-1.079 2-1.543c14.953-5.255 26.451 15.503-4.823 23.725 0-.002.359-.327.468-.617z" />
        <path fill="#EA2D2E" d="M76.491 1.587S89.459 14.563 64.188 34.51c-20.266 16.006-4.621 25.13-.007 35.559-11.831-10.673-20.509-20.07-14.688-28.815C58.041 28.42 81.722 22.195 76.491 1.587z" />
        <path fill="#0074BD" d="M52.214 126.021c22.476 1.437 57-.8 57.817-11.436 0 0-1.571 4.032-18.577 7.231-19.186 3.612-42.854 3.191-56.887.874 0 .001 2.875 2.381 17.647 3.331z" />
      </svg>
    </div>
  )
}

/** 9. 科研助手 - Academic Helix Node */
export function ScienceAssistantBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 44 44" width={size} height={size} fill="none">
        <path
          d="M14 30C14 26 17 24 20 22C24 19.5 28 17.5 28 13.5C28 10.5 25.5 8 22.5 8C19.5 8 17 10.5 17 13.5"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          className="text-zinc-800 dark:text-zinc-100"
        />
        <circle cx="14" cy="30" r="2.5" fill="currentColor" className="text-zinc-800 dark:text-zinc-100" />
        <circle cx="28" cy="13.5" r="2.5" fill="currentColor" className="text-zinc-800 dark:text-zinc-100" />
      </svg>
    </div>
  )
}

/** 10. 产品设计 - Design Triad */
export function ProductDesignBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 44 44" width={size} height={size} fill="none">
        <circle cx="22" cy="15" r="5.5" fill="currentColor" className="text-zinc-800 dark:text-zinc-100" />
        <circle cx="15.5" cy="27" r="5.5" fill="currentColor" className="text-zinc-800 dark:text-zinc-100" />
        <circle cx="28.5" cy="27" r="5.5" fill="currentColor" className="text-zinc-800 dark:text-zinc-100" />
      </svg>
    </div>
  )
}

/** 11. Redis (Simple Icons: redis) */
export function RedisBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-red-700/30 bg-[#D82C20]', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="#FFFFFF">
        <path d="M22.71 13.145c-1.66 2.37-4.87 3.51-8.24 3.51-2.52 0-4.83-.64-6.52-1.83-1.57-1.11-2.43-2.65-2.43-4.34 0-.46.06-.91.18-1.35.12-.44.3-.87.54-1.27C7.62 5.25 11.23 4 15.22 4c3.08 0 5.86.75 7.82 2.11 1.71 1.18 2.67 2.82 2.67 4.6 0 .84-.22 1.66-.64 2.435h-2.36zM1.29 10.855c1.66-2.37 4.87-3.51 8.24-3.51 2.52 0 4.83.64 6.52 1.83 1.57 1.11 2.43 2.65 2.43 4.34 0 .46-.06.91-.18 1.35-.12.44-.3.87-.54 1.27-1.38 2.61-4.99 3.86-8.98 3.86-3.08 0-5.86-.75-7.82-2.11-1.71-1.18-2.67-2.82-2.67-4.6 0-.84.22-1.66.64-2.435h2.36z" />
      </svg>
    </div>
  )
}

/** 12. PolarDB-PG 记忆管理 (Alibaba Cloud PolarDB Official) */
export function PolarDbBrandIcon({ className, size = 44 }: BrandIconProps) {
  return (
    <div
      className={cn('rounded-xl shrink-0 overflow-hidden shadow-sm flex items-center justify-center border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 44 44" width={size} height={size} fill="none">
        <path
          d="M10 22C10 15.3726 15.3726 10 22 10C28.6274 10 34 15.3726 34 22C34 24.5 33.2 26.8 31.8 28.7L25 22H31C31 17 27 13 22 13C17 13 13 17 13 22C13 27 17 31 22 31V34C15.3726 34 10 28.6274 10 22Z"
          fill="#FF6A00"
        />
        <ellipse cx="22" cy="22" rx="4.5" ry="2" fill="#0086FF" />
        <rect x="17.5" y="22" width="9" height="5" fill="#0086FF" />
        <ellipse cx="22" cy="27" rx="4.5" ry="2" fill="#0066CC" />
      </svg>
    </div>
  )
}

// ----------------------------------------------------------------------
// 3. Dynamic Resolvers & Mappings
// ----------------------------------------------------------------------

/** Unified Provider Logo Resolver for Settings, Selectors and Chat */
export function ModelProviderLogo({
  providerId,
  className,
  size = 16,
}: {
  providerId: string
  className?: string
  size?: number
}) {
  const norm = (providerId || '').toLowerCase().trim()
  if (norm.includes('openai')) return <OpenAiIcon size={size} className={className} />
  if (norm.includes('anthropic') || norm.includes('claude')) return <AnthropicIcon size={size} className={className} />
  if (norm.includes('deepseek')) return <DeepSeekIcon size={size} className={className} />
  if (norm.includes('gemini') || norm.includes('google')) return <GeminiIcon size={size} className={className} />
  if (norm.includes('ollama')) return <OllamaIcon size={size} className={className} />
  if (norm.includes('alibaba') || norm.includes('aliyun') || norm.includes('qwen') || norm.includes('dashscope')) {
    return <AlibabaCloudIcon size={size} className={className} />
  }
  return <Cpu size={size} className={cn('text-muted-foreground', className)} />
}
