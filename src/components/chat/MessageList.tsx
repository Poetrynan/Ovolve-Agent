/**
 * MessageList — Message list with virtual scrolling
 * Distinguishes history vs live messages
 * Animation for new messages
 */

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { MessageBubble, MessageData } from './MessageBubble';
import styles from './ChatPage.module.css';

interface MessageListProps {
  messages: MessageData[];
  onCopy?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRegenerate?: (id: string) => void;
}

const ESTIMATED_ITEM_HEIGHT = 80;
const OVERSCAN = 5;

export function MessageList({
  messages,
  onCopy,
  onDelete,
  onRegenerate,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const prevMessagesLength = useRef(messages.length);
  const shouldAutoScroll = useRef(true);

  // Measure container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (messages.length > prevMessagesLength.current && shouldAutoScroll.current) {
      const container = containerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
    prevMessagesLength.current = messages.length;
  }, [messages.length]);

  // Detect user scroll
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    setScrollTop(container.scrollTop);

    // If user scrolled near bottom, re-enable auto-scroll
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldAutoScroll.current = distanceFromBottom < 100;
  }, []);

  // Simple virtualization
  const totalHeight = messages.length * ESTIMATED_ITEM_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ESTIMATED_ITEM_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    messages.length,
    Math.ceil((scrollTop + containerHeight) / ESTIMATED_ITEM_HEIGHT) + OVERSCAN
  );

  const visibleMessages = messages.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      className={styles.messageList}
      onScroll={handleScroll}
    >
      <div className={styles.messageListInner} style={{ height: totalHeight }}>
        <div
          style={{
            transform: `translateY(${startIndex * ESTIMATED_ITEM_HEIGHT}px)`,
          }}
        >
          {visibleMessages.map((message, index) => (
            <div
              key={message.id}
              className={`${styles.messageWrapper} ${
                index === visibleMessages.length - 1 ? styles.messageWrapperLatest : ''
              }`}
            >
              <MessageBubble
                message={message}
                onCopy={onCopy}
                onDelete={onDelete}
                onRegenerate={onRegenerate}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default MessageList;
