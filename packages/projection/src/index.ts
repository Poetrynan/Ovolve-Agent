/**
 * @oa/projection — State Projection Engine for OvolveAgent
 *
 * Projects events into state representations.
 * Used by session-core and other packages to build current state from events.
 */

import type { EventType, AgentEvent } from '@oa/event-store';

export interface ProjectionState {
  sessionId: string;
  seq: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface Projector<S = unknown> {
  readonly name: string;
  readonly eventTypes: EventType[];
  initState(): S;
  apply(state: S, event: AgentEvent): S;
}

export interface ProjectionEngineConfig {
  projectors: Projector[];
  eventStore: import('@oa/event-store').IEventStore;
}

export class ProjectionEngine {
  private projectors: Map<string, Projector> = new Map();
  private eventStore: import('@oa/event-store').IEventStore;
  private stateCache: Map<string, ProjectionState> = new Map();

  constructor(config: ProjectionEngineConfig) {
    this.eventStore = config.eventStore;
    for (const projector of config.projectors) {
      this.projectors.set(projector.name, projector);
    }
  }

  async project<S>(projectorName: string, sessionId: string): Promise<S> {
    const projector = this.projectors.get(projectorName);
    if (!projector) throw new Error(`Projector not found: ${projectorName}`);

    const events = await this.eventStore.readStream({
      sessionId,
      eventTypes: projector.eventTypes,
    });

    let state = projector.initState();
    for (const event of events) {
      state = projector.apply(state, event);
    }

    return state as S;
  }

  async projectIncremental<S>(
    projectorName: string,
    sessionId: string,
    fromSeq: number
  ): Promise<S> {
    const projector = this.projectors.get(projectorName);
    if (!projector) throw new Error(`Projector not found: ${projectorName}`);

    const events = await this.eventStore.readStream({
      sessionId,
      fromSeq,
      eventTypes: projector.eventTypes,
    });

    const cached = this.stateCache.get(`${projectorName}:${sessionId}`);
    let state = cached ? (cached.data as S) : projector.initState();

    for (const event of events) {
      state = projector.apply(state, event);
    }

    return state as S;
  }

  cacheState(projectorName: string, sessionId: string, state: unknown, seq: number): void {
    this.stateCache.set(`${projectorName}:${sessionId}`, {
      sessionId,
      seq,
      timestamp: Date.now() * 1000,
      data: state as Record<string, unknown>,
    });
  }

  invalidateCache(projectorName: string, sessionId: string): void {
    this.stateCache.delete(`${projectorName}:${sessionId}`);
  }

  invalidateAllCache(): void {
    this.stateCache.clear();
  }
}

export function createProjectionEngine(config: ProjectionEngineConfig): ProjectionEngine {
  return new ProjectionEngine(config);
}
