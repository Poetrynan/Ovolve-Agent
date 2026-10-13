/**
 * providers/base.ts — IMProvider abstract base class.
 *
 * Ported from `app/backend/providers/base.py` (39 lines).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/providers/base.py -> app/engine/providers/base.ts
 *   §2  behaviour: abstract methods carry no body in the source (docstring
 *       ellipsis); ``is_configured`` is the only concrete method and returns
 *       True unconditionally.
 *
 * PORT STATUS: confidence=high todos=[0]
 */

/** Abstract base class for IM platform providers.
 *  DIVERGENCE(port): py's ABC rejects instantiation at runtime when an
 *  abstract method is missing; TS ``abstract`` is compile-time only.
 *  Equivalence: all concrete providers live in this same repo and are type-
 *  checked at build time, so no runtime caller can observe the difference. */
export abstract class IMProvider {
    /** Start listening for incoming messages. */
    abstract start_listening(controller: unknown): Promise<void>;

    /** Stop listening for incoming messages. */
    abstract stop_listening(): Promise<void>;

    /** Send a text message to a user. */
    abstract send_message(user_id: string, content: string): Promise<boolean>;

    /** Send a streaming message (typewriter effect). */
    abstract send_streaming_card(
        user_id: string,
        content_stream: AsyncGenerator<string, void>,
    ): Promise<boolean>;

    /** Return the platform identifier string. */
    abstract get_platform_id(): string;

    /** Check if this provider has valid credentials. */
    is_configured(): boolean {
        return true;
    }
}

// PORT STATUS: confidence=high todos=[0]
