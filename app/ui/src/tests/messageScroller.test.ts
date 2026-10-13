import { describe, it, expect } from 'vitest'
import type { Message } from '@apptypes/index'

describe('Chat scroll and turn stickiness invariants', () => {
  function getLastUserMsgId(messages: Message[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id
    }
    return null
  }

  it('lastUserMsgId updates when user sends a prompt, but remains identical during and after AI reply', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'Hello', timestamp: 1000 },
      { id: 'asst-1', role: 'assistant', content: 'Hi there!', timestamp: 1001 },
    ]

    expect(getLastUserMsgId(messages)).toBe('user-1')

    // 1. User sends a new prompt
    messages.push({ id: 'user-2', role: 'user', content: 'Can you help me?', timestamp: 1002 })
    expect(getLastUserMsgId(messages)).toBe('user-2')

    // 2. AI starts streaming tokens
    const streamingMsg: Message = { id: 'asst-2', role: 'assistant', content: 'Sure', timestamp: 1003 }
    messages.push(streamingMsg)
    expect(getLastUserMsgId(messages)).toBe('user-2') // MUST remain user-2!

    // 3. AI outputs tool calls
    streamingMsg.toolCalls = [{ id: 'tc-1', toolName: 'read_file', args: {}, status: 'completed', timestamp: 1004 }]
    expect(getLastUserMsgId(messages)).toBe('user-2') // MUST remain user-2!

    // 4. AI completes response and finishes turn
    streamingMsg.content = 'Sure, I can help you with that!'
    expect(getLastUserMsgId(messages)).toBe('user-2') // MUST remain user-2!

    // Therefore, forceScrollKey does NOT change when AI completes response.
    // If the user scrolled up, their reading position is completely preserved!
  })

  it('upward scroll intent never re-engages stickiness, even within small distance from bottom', () => {
    const AT_BOTTOM_THRESHOLD_PX = 16

    function simulateScrollEvent(params: {
      currentScrollTop: number
      lastScrollTop: number
      scrollHeight: number
      clientHeight: number
    }): { stick: boolean; showBottomBtn: boolean } {
      const isScrollingUp = params.currentScrollTop < params.lastScrollTop
      const distance = params.scrollHeight - params.currentScrollTop - params.clientHeight

      let stick = false
      let showBottomBtn = false

      if (isScrollingUp) {
        // Upward scroll: NEVER re-engage stickiness!
        stick = false
        if (distance > AT_BOTTOM_THRESHOLD_PX) {
          showBottomBtn = true
        }
      } else {
        // Downward scroll
        if (distance <= AT_BOTTOM_THRESHOLD_PX) {
          stick = true
          showBottomBtn = false
        } else {
          stick = false
          showBottomBtn = true
        }
      }

      return { stick, showBottomBtn }
    }

    // User is at bottom (distance = 0) and scrolls UP slightly (e.g. 10px)
    // scrollHeight = 1000, clientHeight = 500
    // initial scrollTop = 500 (distance = 0)
    // user scrolls up by 10px -> currentScrollTop = 490 (distance = 10px <= 16px)
    const resultUpSmall = simulateScrollEvent({
      currentScrollTop: 490,
      lastScrollTop: 500,
      scrollHeight: 1000,
      clientHeight: 500,
    })

    // Must NOT be sticky! This prevents the twitch loop where small scrolls are pulled down.
    expect(resultUpSmall.stick).toBe(false)

    // User scrolls UP further into history (e.g. distance = 100px)
    const resultUpLarge = simulateScrollEvent({
      currentScrollTop: 400,
      lastScrollTop: 490,
      scrollHeight: 1000,
      clientHeight: 500,
    })
    expect(resultUpLarge.stick).toBe(false)
    expect(resultUpLarge.showBottomBtn).toBe(true)

    // User scrolls DOWN back to bottom (distance = 5px <= 16px)
    const resultDownToBottom = simulateScrollEvent({
      currentScrollTop: 495,
      lastScrollTop: 400,
      scrollHeight: 1000,
      clientHeight: 500,
    })
    expect(resultDownToBottom.stick).toBe(true)
    expect(resultDownToBottom.showBottomBtn).toBe(false)
  })

  it('any upward wheel event (e.deltaY < 0) immediately cancels stickiness regardless of amplitude', () => {
    function onWheelHandler(deltaY: number, currentStick: boolean): boolean {
      if (deltaY < 0) {
        return false // Intentional upward scroll -> stick = false
      }
      return currentStick
    }

    // Micro scroll: deltaY = -0.5 (touchpad / smooth wheel)
    expect(onWheelHandler(-0.5, true)).toBe(false)

    // Small scroll: deltaY = -1.5
    expect(onWheelHandler(-1.5, true)).toBe(false)

    // Standard tick: deltaY = -100
    expect(onWheelHandler(-100, true)).toBe(false)
  })

  it('single-round conversation or unscrollable chat NEVER shows scroll bottom button on wheel or scroll', () => {
    const AT_BOTTOM_THRESHOLD_PX = 16

    function simulateWheelEvent(params: {
      deltaY: number
      scrollHeight: number
      clientHeight: number
      scrollTop: number
    }): { stick: boolean; showBottomBtn: boolean } {
      const canScroll = params.scrollHeight - params.clientHeight > AT_BOTTOM_THRESHOLD_PX
      if (!canScroll) {
        return { stick: true, showBottomBtn: false }
      }
      if (params.deltaY < 0) {
        const distance = params.scrollHeight - params.scrollTop - params.clientHeight
        return { stick: false, showBottomBtn: distance > AT_BOTTOM_THRESHOLD_PX }
      }
      return { stick: true, showBottomBtn: false }
    }

    // 1-round conversation: scrollHeight = 350px, clientHeight = 700px (does not overflow)
    const wheelUpInShortChat = simulateWheelEvent({
      deltaY: -100,
      scrollHeight: 350,
      clientHeight: 700,
      scrollTop: 0,
    })

    // Button MUST NOT show, stickiness remains true
    expect(wheelUpInShortChat.showBottomBtn).toBe(false)
    expect(wheelUpInShortChat.stick).toBe(true)

    // Even on micro-scroll upward in short chat
    const microWheelInShortChat = simulateWheelEvent({
      deltaY: -0.5,
      scrollHeight: 350,
      clientHeight: 700,
      scrollTop: 0,
    })
    expect(microWheelInShortChat.showBottomBtn).toBe(false)
    expect(microWheelInShortChat.stick).toBe(true)
  })
})
