const WEEKDAY_NAMES: Record<string, string> = {
  '0': '周日',
  '1': '周一',
  '2': '周二',
  '3': '周三',
  '4': '周四',
  '5': '周五',
  '6': '周六',
  '7': '周日',
}

export interface CronInfo {
  isValid: boolean
  label: string
  badgeText: string
  nextRunStr?: string
  relativeStr?: string
}

function pad(n: number | string): string {
  return String(n).padStart(2, '0')
}

/**
 * 将 5 段式 Cron 表达式解析为自然流畅的中文语义和下次执行时间
 */
export function parseCronExpression(expression: string): CronInfo {
  const trimmed = expression.trim()
  const parts = trimmed.split(/\s+/)

  if (parts.length !== 5) {
    return {
      isValid: false,
      label: '表达式格式需为 5 位 (分 时 日 月 周)',
      badgeText: '无效 Cron',
    }
  }

  const [min, hour, dom, mon, dow] = parts

  // 1. 每 N 分钟
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const step = parseInt(min.replace('*/', ''), 10) || 1
    const nextDate = getNextIntervalDate(step)
    const { nextRunStr, relativeStr } = formatNextRun(nextDate)
    return {
      isValid: true,
      label: `每隔 ${step} 分钟自动执行一次`,
      badgeText: `每 ${step} 分钟`,
      nextRunStr,
      relativeStr,
    }
  }

  // 2. 每小时整点 / 每小时固定分
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    const minuteNum = parseInt(min, 10)
    if (!isNaN(minuteNum) && minuteNum >= 0 && minuteNum <= 59) {
      const isZero = minuteNum === 0
      const nextDate = getNextHourlyDate(minuteNum)
      const { nextRunStr, relativeStr } = formatNextRun(nextDate)
      return {
        isValid: true,
        label: isZero ? '每小时整点自动执行' : `每小时的第 ${minuteNum} 分钟执行`,
        badgeText: isZero ? '每小时整点' : `每小时 :${pad(minuteNum)}`,
        nextRunStr,
        relativeStr,
      }
    }
  }

  // 3. 每天固定时间
  const minNum = parseInt(min, 10)
  const hourNum = parseInt(hour, 10)

  if (!isNaN(minNum) && !isNaN(hourNum) && minNum >= 0 && minNum <= 59 && hourNum >= 0 && hourNum <= 23) {
    const timeStr = `${pad(hourNum)}:${pad(minNum)}`

    // 每天
    if (dom === '*' && mon === '*' && dow === '*') {
      const nextDate = getNextDailyDate(hourNum, minNum)
      const { nextRunStr, relativeStr } = formatNextRun(nextDate)
      return {
        isValid: true,
        label: `每天 ${timeStr} 准时执行`,
        badgeText: `每天 ${timeStr}`,
        nextRunStr,
        relativeStr,
      }
    }

    // 工作日 (周一至周五)
    if (dom === '*' && mon === '*' && (dow === '1-5' || dow === '1,2,3,4,5')) {
      const nextDate = getNextWeekdayDate(hourNum, minNum, [1, 2, 3, 4, 5])
      const { nextRunStr, relativeStr } = formatNextRun(nextDate)
      return {
        isValid: true,
        label: `每个工作日 (周一至周五) ${timeStr} 执行`,
        badgeText: `工作日 ${timeStr}`,
        nextRunStr,
        relativeStr,
      }
    }

    // 周末 (周六与周日)
    if (dom === '*' && mon === '*' && (dow === '0,6' || dow === '6,0')) {
      const nextDate = getNextWeekdayDate(hourNum, minNum, [0, 6])
      const { nextRunStr, relativeStr } = formatNextRun(nextDate)
      return {
        isValid: true,
        label: `每个周末 (周六和周日) ${timeStr} 执行`,
        badgeText: `周末 ${timeStr}`,
        nextRunStr,
        relativeStr,
      }
    }

    // 指定单周几 (如每周一 09:00)
    if (dom === '*' && mon === '*' && WEEKDAY_NAMES[dow]) {
      const targetDow = parseInt(dow === '7' ? '0' : dow, 10)
      const nextDate = getNextWeekdayDate(hourNum, minNum, [targetDow])
      const { nextRunStr, relativeStr } = formatNextRun(nextDate)
      const weekName = WEEKDAY_NAMES[dow]
      return {
        isValid: true,
        label: `每${weekName} ${timeStr} 执行`,
        badgeText: `每${weekName} ${timeStr}`,
        nextRunStr,
        relativeStr,
      }
    }

    // 每月几号
    const domNum = parseInt(dom, 10)
    if (!isNaN(domNum) && domNum >= 1 && domNum <= 31 && mon === '*' && dow === '*') {
      const nextDate = getNextMonthlyDate(domNum, hourNum, minNum)
      const { nextRunStr, relativeStr } = formatNextRun(nextDate)
      return {
        isValid: true,
        label: `每月 ${domNum} 日 ${timeStr} 执行`,
        badgeText: `每月${domNum}日 ${timeStr}`,
        nextRunStr,
        relativeStr,
      }
    }
  }

  // 通用兜底合法检查
  return {
    isValid: true,
    label: `自定义规则 (${trimmed})`,
    badgeText: trimmed,
  }
}

function getNextIntervalDate(stepMinutes: number): Date {
  const now = new Date()
  const currentMinutes = now.getMinutes()
  const remainder = currentMinutes % stepMinutes
  const minutesToAdd = stepMinutes - remainder === 0 ? stepMinutes : stepMinutes - remainder

  const next = new Date(now.getTime())
  next.setMinutes(currentMinutes + minutesToAdd)
  next.setSeconds(0)
  next.setMilliseconds(0)

  // 如果刚好等于当前秒且没有超前，顺延一个步长
  if (next.getTime() <= now.getTime()) {
    next.setMinutes(next.getMinutes() + stepMinutes)
  }
  return next
}

function getNextHourlyDate(minute: number): Date {
  const now = new Date()
  const next = new Date(now.getTime())
  next.setMinutes(minute)
  next.setSeconds(0)
  next.setMilliseconds(0)

  if (next.getTime() <= now.getTime()) {
    next.setHours(next.getHours() + 1)
  }
  return next
}

function getNextDailyDate(hour: number, minute: number): Date {
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  return next
}

function getNextWeekdayDate(hour: number, minute: number, targetDays: number[]): Date {
  const now = new Date()
  for (let offset = 0; offset <= 14; offset++) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute, 0, 0)
    if (candidate.getTime() > now.getTime() && targetDays.includes(candidate.getDay())) {
      return candidate
    }
  }
  return getNextDailyDate(hour, minute)
}

function getNextMonthlyDate(dom: number, hour: number, minute: number): Date {
  const now = new Date()
  let year = now.getFullYear()
  let month = now.getMonth()

  let candidate = new Date(year, month, dom, hour, minute, 0, 0)
  if (candidate.getTime() <= now.getTime()) {
    month += 1
    candidate = new Date(year, month, dom, hour, minute, 0, 0)
  }
  return candidate
}

function formatNextRun(target: Date): { nextRunStr: string; relativeStr: string } {
  const now = new Date()
  const diffMs = target.getTime() - now.getTime()

  const hh = pad(target.getHours())
  const mm = pad(target.getMinutes())
  const timeOnly = `${hh}:${mm}`

  const isToday =
    target.getDate() === now.getDate() &&
    target.getMonth() === now.getMonth() &&
    target.getFullYear() === now.getFullYear()

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const isTomorrow =
    target.getDate() === tomorrow.getDate() &&
    target.getMonth() === tomorrow.getMonth() &&
    target.getFullYear() === tomorrow.getFullYear()

  let nextRunStr = ''
  if (isToday) {
    nextRunStr = `今天 ${timeOnly}`
  } else if (isTomorrow) {
    nextRunStr = `明天 ${timeOnly}`
  } else {
    const dayOfWeek = WEEKDAY_NAMES[String(target.getDay())] || ''
    nextRunStr = `${target.getMonth() + 1}月${target.getDate()}日 (${dayOfWeek}) ${timeOnly}`
  }

  // 相对时间
  const diffMinutes = Math.round(diffMs / (1000 * 60))
  let relativeStr = ''
  if (diffMinutes <= 1) {
    relativeStr = '即将触发'
  } else if (diffMinutes < 60) {
    relativeStr = `${diffMinutes} 分钟后`
  } else {
    const diffHours = Math.floor(diffMinutes / 60)
    const remainingMins = diffMinutes % 60
    if (diffHours < 24) {
      relativeStr = remainingMins > 0 ? `${diffHours}小时${remainingMins}分后` : `${diffHours} 小时后`
    } else {
      const diffDays = Math.floor(diffHours / 24)
      relativeStr = `${diffDays} 天后`
    }
  }

  return { nextRunStr, relativeStr }
}
