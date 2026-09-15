/**

 * Delta Checkpoint

 * Manages incremental differential snapshots of conversation nodes, tools, and request stages.

 */



export interface EventLocation {

  kind: 'turn' | 'step';

  turn: number;

  step?: number;

}



export interface DeltaNode {

  key: string;

  anchorSeq: number;

  seq: number;

  type: 'message' | 'tool_call' | 'tool_result' | 'thought' | 'checkpoint' | 'request-header';

  payload: Record<string, unknown>;

  timestamp: number;

}



export interface DeltaSnapshot {

  serverId: string;

  revision: number;

  eventNodes: DeltaNode[];

  eventLocations: Map<number, EventLocation>;

  totalTokens: number;

  cachedTokens: number;

  timestamp: number;

}



export const EMPTY_DELTA_SNAPSHOT: DeltaSnapshot = {

  serverId: 'ovolve-core',

  revision: 0,

  eventNodes: [],

  eventLocations: new Map(),

  totalTokens: 0,

  cachedTokens: 0,

  timestamp: Date.now(),

};



function stepKey(turn: number, step: number): string {

  return `${turn}\u0000${step}`;

}



/**

 * High-performance incremental delta snapshot builder

 */

export class DeltaSnapshotBuilder {

  private readonly nodes = new Map<string, DeltaNode>();

  private readonly positions = new Map<string, number>();

  private contributions: DeltaNode[] = [];

  private revision = 0;

  private serverId = 'ovolve-core';



  constructor(serverId = 'ovolve-core') {

    this.serverId = serverId;

  }



  get currentRevision(): number {

    return this.revision;

  }



  /**

   * Replace all nodes with a full snapshot

   */

  replace(nodes: DeltaNode[]): DeltaSnapshot {

    this.nodes.clear();

    for (const node of nodes) {

      this.nodes.set(node.key, node);

    }

    this.rebuildContributions();

    this.revision++;

    return this.buildSnapshot();

  }



  /**

   * Apply incremental upserts with structural delta detection

   */

  apply(upserts: DeltaNode[]): DeltaSnapshot {

    let structural = false;

    for (const node of upserts) {

      const previous = this.nodes.get(node.key);

      this.nodes.set(node.key, node);



      if (previous === undefined || previous.anchorSeq !== node.anchorSeq) {

        structural = true;

        continue;

      }



      const position = this.positions.get(node.key);

      if (position === undefined) {

        structural = true;

      } else {

        this.contributions[position] = node;

      }

    }



    if (structural) {

      this.rebuildContributions();

    }



    this.revision++;

    return this.buildSnapshot();

  }



  /**

   * Build complete immutable snapshot from ordered contributions

   */

  private buildSnapshot(): DeltaSnapshot {

    const finalized: DeltaNode[] = [];

    const eventLocations = new Map<number, EventLocation>();

    let totalTokens = 0;

    let cachedTokens = 0;



    for (const contribution of this.contributions) {

      finalized.push(contribution);

      const loc: EventLocation = {

        kind: 'turn',

        turn: Number(contribution.payload.turn ?? 0),

        step: contribution.payload.step !== undefined ? Number(contribution.payload.step) : undefined,

      };

      eventLocations.set(contribution.seq, loc);



      if (typeof contribution.payload.tokens === 'number') {

        totalTokens += contribution.payload.tokens;

      }

      if (typeof contribution.payload.cachedTokens === 'number') {

        cachedTokens += contribution.payload.cachedTokens;

      }

    }



    finalized.sort((a, b) => a.seq - b.seq);



    return {

      serverId: this.serverId,

      revision: this.revision,

      eventNodes: finalized,

      eventLocations,

      totalTokens,

      cachedTokens,

      timestamp: Date.now(),

    };

  }



  private rebuildContributions(): void {

    this.contributions = [...this.nodes.values()].sort(

      (a, b) => a.anchorSeq - b.anchorSeq || a.key.localeCompare(b.key)

    );

    this.positions.clear();

    for (const [index, contribution] of this.contributions.entries()) {

      this.positions.set(contribution.key, index);

    }

  }

}

