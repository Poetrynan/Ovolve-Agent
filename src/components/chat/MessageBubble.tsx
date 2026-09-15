/**
 * MessageBubble — Single message bubble
 * Supports user/assistant/tool roles
 * Avatar, timestamp, actions, markdown rendering, code block syntax highlighting
 */

import React, { useState, useCallback } from 'react';
import { Icon } from '../ui/Icon';
import { Menu, MenuItem } from '../ui/Menu';
import styles from './ChatPage.module.css';

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface MessageData {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  metadata?: {
    model?: string;
    tokens?: number;
    duration?: number;
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    cost?: number;
  };
}

interface MessageBubbleProps {
  message: MessageData;
  onCopy?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRegenerate?: (id: string) => void;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MessageBubble({
  message,
  onCopy,
  onDelete,
  onRegenerate,
}: MessageBubbleProps) {
  const [hovered, setHovered] = useState(false);
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const isTool = message.role === 'tool';

  const menuItems: MenuItem[] = [
    {
      id: 'copy',
      label: 'Copy',
      icon: <Icon name="copy" size={14} />,
      shortcut: '⌘C',
      onClick: () => onCopy?.(message.id),
    },
    ...(isAssistant
      ? [
          {
            id: 'regenerate',
            label: 'Regenerate',
            icon: <Icon name="refresh" size={14} />,
            onClick: () => onRegenerate?.(message.id),
          },
        ]
      : []),
    { id: 'div1', label: '', divider: true },
    {
      id: 'delete',
      label: 'Delete',
      icon: <Icon name="trash" size={14} />,
      danger: true,
      onClick: () => onDelete?.(message.id),
    },
  ];

  return (
    <div
      className={`${styles.messageRow} ${isUser ? styles.messageRowUser : ''} ${
        isTool ? styles.messageRowTool : ''
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Avatar */}
      <div className={`${styles.avatar} ${styles[`avatar${message.role}`]}`}>
        {isUser ? (
          <Icon name="user" size={16} />
        ) : isAssistant ? (
          <Icon name="assistant" size={16} />
        ) : (
          <Icon name="tool" size={16} />
        )}
      </div>

      {/* Bubble */}
      <div className={styles.messageContent}>
        {/* Header */}
        <div className={styles.messageHeader}>
          <span className={styles.messageRole}>
            {isUser ? 'You' : isAssistant ? 'Assistant' : 'Tool'}
          </span>
          <span className={styles.messageTime}>{formatTime(message.timestamp)}</span>
          {message.metadata?.model && (
            <span className={styles.messageModel}>{message.metadata.model}</span>
          )}
          {message.isStreaming && <span className={styles.streamingIndicator}>...</span>}
        </div>

        {/* Body */}
        <div className={`${styles.messageBody} ${isUser ? styles.messageBodyUser : ''}`}>
          <MarkdownContent content={message.content} />
          {message.isStreaming && <span className={styles.cursor}>|</span>}
        </div>

        {/* Footer metadata */}
        {message.metadata?.tokens && (
          <div className={styles.messageFooter}>
            <span>{message.metadata.tokens} tokens</span>
            {message.metadata.duration && (
              <span>{(message.metadata.duration / 1000).toFixed(1)}s</span>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      {hovered && (
        <div className={styles.messageActions}>
          <button
            className={styles.messageActionBtn}
            onClick={() => onCopy?.(message.id)}
            title="Copy"
          >
            <Icon name="copy" size={14} />
          </button>
          <Menu items={menuItems}>
            <button className={styles.messageActionBtn} title="More">
              <Icon name="more" size={14} />
            </button>
          </Menu>
        </div>
      )}
    </div>
  );
}

/**
 * Simple markdown content renderer
 * In production, this would use a proper markdown library
 */
function MarkdownContent({ content }: { content: string }) {
  // Simple code block detection
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const code = part.slice(3, -3);
          const firstNewline = code.indexOf('\n');
          const lang = firstNewline > -1 ? code.slice(0, firstNewline) : '';
          const codeContent = firstNewline > -1 ? code.slice(firstNewline + 1) : code;

          return (
            <CodeBlock key={i} lang={lang} code={codeContent} />
          );
        }

        // Simple inline formatting
        const lines = part.split('\n');
        return lines.map((line, j) => {
          if (line.startsWith('# ')) {
            return (
              <h1 key={`${i}-${j}`} className={styles.mdHeading1}>
                {line.slice(2)}
              </h1>
            );
          }
          if (line.startsWith('## ')) {
            return (
              <h2 key={`${i}-${j}`} className={styles.mdHeading2}>
                {line.slice(3)}
              </h2>
            );
          }
          if (line.startsWith('### ')) {
            return (
              <h3 key={`${i}-${j}`} className={styles.mdHeading3}>
                {line.slice(4)}
              </h3>
            );
          }
          if (line.trim() === '') {
            return <br key={`${i}-${j}`} />;
          }

          // Inline code and bold
          const formatted = formatInline(line);
          return (
            <p key={`${i}-${j}`} className={styles.mdParagraph}>
              {formatted}
            </p>
          );
        });
      })}
    </>
  );
}

function formatInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match inline code and bold
  const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const m = match[1];
    if (m.startsWith('`')) {
      parts.push(
        <code key={key++} className={styles.inlineCode}>
          {m.slice(1, -1)}
        </code>
      );
    } else if (m.startsWith('**')) {
      parts.push(
        <strong key={key++} className={styles.mdBold}>
          {m.slice(2, -2)}
        </strong>
      );
    }
    lastIndex = match.index + m.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className={styles.codeBlock}>
      <div
        className={styles.codeBlockHeader}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>{lang || 'code'}</span>
        <button
          onClick={handleCopy}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            border: 'none',
            background: 'transparent',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: 11,
          }}
          title="Copy code"
        >
          <Icon name={copied ? 'check' : 'copy'} size={12} />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className={styles.codeContent}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default MessageBubble;
