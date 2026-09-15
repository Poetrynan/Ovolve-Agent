/**
 * Stream helpers for async iteration.
 *
 * Utilities for consuming stream events in an async iterable pattern,
 * with support for buffering, filtering, and transformation.
 */

import type { StreamEvent, StreamEventType } from './types.js';

/** Stream chunk with metadata */
export interface StreamChunk {
  /** The raw event */
  event: StreamEvent;
  /** Accumulated content so far */
  accumulated: string;
  /** Whether this is the final chunk */
  done: boolean;
}

/** Options for creating an async stream */
export interface StreamOptions {
  /** Event types to include */
  includeTypes?: StreamEventType[];
  /** Event types to exclude */
  excludeTypes?: StreamEventType[];
  /** Session ID to filter by */
  sessionId?: string;
  /** Buffer size for pending events */
  bufferSize?: number;
}

/**
 * AsyncStream provides async iterable access to stream events.
 *
 * Supports:
 * - Async iteration (for await...of)
 * - Content accumulation
 * - Event filtering
 * - Stream piping and transformation
 */
export class AsyncStream implements AsyncIterable<StreamChunk> {
  private buffer: StreamChunk[] = [];
  private waiting: Array<{
    resolve: (chunk: StreamChunk) => void;
    reject: (error: Error) => void;
  }> = [];
  private done: boolean = false;
  private error: Error | null = null;
  private accumulated: string = '';
  private options: StreamOptions;

  constructor(options?: StreamOptions) {
    this.options = options ?? {};
  }

  /**
   * Push a new event into the stream.
   */
  push(event: StreamEvent): void {
    if (this.done) return;

    // Apply filters
    if (!this.passesFilter(event)) return;

    // Extract content from event
    const delta = this.extractContent(event);
    if (delta) {
      this.accumulated += delta;
    }

    const chunk: StreamChunk = {
      event,
      accumulated: this.accumulated,
      done: event.type === 'done' || event.type === 'message_stop',
    };

    // If someone is waiting, resolve immediately
    if (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter.resolve(chunk);
      return;
    }

    // Otherwise buffer
    this.buffer.push(chunk);

    if (chunk.done) {
      this.done = true;
    }
  }

  /**
   * Signal the stream is complete.
   */
  complete(): void {
    this.done = true;

    // Resolve any waiting consumers
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter.resolve({
        event: {
          type: 'done',
          sessionId: this.options.sessionId ?? '',
          data: {},
          timestamp: Date.now(),
        },
        accumulated: this.accumulated,
        done: true,
      });
    }
  }

  /**
   * Signal an error on the stream.
   */
  fail(error: Error): void {
    this.error = error;
    this.done = true;

    // Reject all waiting consumers
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter.reject(error);
    }
  }

  /**
   * Get the accumulated content so far.
   */
  getAccumulated(): string {
    return this.accumulated;
  }

  /**
   * Check if the stream is done.
   */
  isDone(): boolean {
    return this.done;
  }

  /**
   * Async iterator implementation.
   */
  [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
    return {
      next: (): Promise<IteratorResult<StreamChunk>> => {
        // Return buffered chunk if available
        if (this.buffer.length > 0) {
          const chunk = this.buffer.shift()!;
          return Promise.resolve({ value: chunk, done: false });
        }

        // If done, return done result
        if (this.done) {
          if (this.error) {
            return Promise.reject(this.error);
          }
          return Promise.resolve({ value: undefined as unknown as StreamChunk, done: true });
        }

        // Wait for next chunk
        return new Promise<IteratorResult<StreamChunk>>((resolve, reject) => {
          this.waiting.push({
            resolve: (chunk) => {
              resolve({ value: chunk, done: false });
            },
            reject,
          });
        });
      },
    };
  }

  /**
   * Check if an event passes the configured filters.
   */
  private passesFilter(event: StreamEvent): boolean {
    // Session filter
    if (this.options.sessionId && event.sessionId !== this.options.sessionId) {
      return false;
    }

    // Include filter
    if (this.options.includeTypes && this.options.includeTypes.length > 0) {
      if (!this.options.includeTypes.includes(event.type)) {
        return false;
      }
    }

    // Exclude filter
    if (this.options.excludeTypes && this.options.excludeTypes.length > 0) {
      if (this.options.excludeTypes.includes(event.type)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Extract text content from a stream event.
   */
  private extractContent(event: StreamEvent): string | null {
    if (event.type === 'content_delta') {
      return (event.data as { delta?: string }).delta ?? null;
    }
    if (event.type === 'message_delta') {
      return (event.data as { content?: string }).content ?? null;
    }
    return null;
  }
}

/**
 * Create an AsyncStream from a WebSocket event emitter.
 */
export function createStreamFromEmitter(
  emitter: {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    off: (event: string, listener: (...args: unknown[]) => void) => void;
  },
  sessionId: string,
  options?: Omit<StreamOptions, 'sessionId'>,
): AsyncStream {
  const stream = new AsyncStream({ ...options, sessionId });

  const onStreamEvent = (event: unknown) => {
    const streamEvent = event as StreamEvent;
    if (streamEvent.sessionId === sessionId) {
      stream.push(streamEvent);

      if (streamEvent.type === 'done' || streamEvent.type === 'message_stop') {
        stream.complete();
        emitter.off('stream_event', onStreamEvent);
        emitter.off('server_error', onError);
      }
    }
  };

  const onError = (error: unknown) => {
    stream.fail(error instanceof Error ? error : new Error(String(error)));
    emitter.off('stream_event', onStreamEvent);
    emitter.off('server_error', onError);
  };

  emitter.on('stream_event', onStreamEvent);
  emitter.on('server_error', onError);

  return stream;
}

/**
 * Collect all events from an async stream into an array.
 */
export async function collectStream(stream: AsyncStream): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    if (chunk.done) break;
  }
  return chunks;
}

/**
 * Extract all text content from a stream.
 */
export async function streamToText(stream: AsyncStream): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text = chunk.accumulated;
    if (chunk.done) break;
  }
  return text;
}

/**
 * Transform a stream by applying a function to each chunk.
 */
export async function* transformStream(
  source: AsyncIterable<StreamChunk>,
  transform: (chunk: StreamChunk) => StreamChunk | null,
): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    const transformed = transform(chunk);
    if (transformed !== null) {
      yield transformed;
    }
  }
}

/**
 * Filter a stream by a predicate.
 */
export async function* filterStream(
  source: AsyncIterable<StreamChunk>,
  predicate: (chunk: StreamChunk) => boolean,
): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    if (predicate(chunk)) {
      yield chunk;
    }
  }
}

/**
 * Merge multiple streams into a single stream.
 */
export async function* mergeStreams(
  streams: AsyncIterable<StreamChunk>[],
): AsyncIterable<StreamChunk> {
  const iterators = streams.map((s) => s[Symbol.asyncIterator]());
  const pending = iterators.map((it, i) => it.next().then((result) => ({ result, i })));

  let accumulated = '';
  let allDone = false;

  while (!allDone) {
    const { result, i } = await Promise.race(pending.filter(Boolean));

    if (result.done) {
      pending[i] = new Promise(() => {}); // Never resolves
      allDone = pending.every((p) => p instanceof Promise && ('then' in p));
    } else {
      accumulated = result.value.accumulated || accumulated;
      yield {
        ...result.value,
        accumulated,
      };

      pending[i] = iterators[i].next().then((r) => ({ result: r, i }));
    }
  }
}
