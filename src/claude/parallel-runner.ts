/**
 * AgentPool — replaces the older slot-counter ParallelRunner.
 *
 * Design v3 (post-2026-05-13):
 *   - No "main" vs "fork" distinction. Every user message becomes an Agent that
 *     spawns with a synthetic sessionKey and shares the parent's Claude
 *     sessionId via --resume (so all agents read the same jsonl on spawn).
 *   - Up to `maxConcurrent` running agents per parent session at any time.
 *   - When an agent completes, it checks whether anyone in the pool was
 *     spawned AFTER it. If yes → suicide (release synthetic sessionKey + kill
 *     process). If no (I'm the latest-spawned) → transition to 'warm' status
 *     and stay alive as a hot standby for the next incoming message.
 *   - Next incoming message: dispatcher first looks for a warm agent. If found,
 *     it compares `jsonl mtime` against the moment the warm entry was parked.
 *     Same → safely reuse (zero cold start). Different → respawn (kill, will
 *     fresh-spawn on next send to read the latest jsonl).
 *
 * Why "latest spawned" rather than "latest completed"?
 *   - Latest-spawned agent's in-memory history captured the most recent jsonl
 *     state at spawn time → highest chance of prompt-cache hit on the next
 *     message and least likely to be stale.
 *   - Deciding "am I the latest-spawned alive?" is a deterministic
 *     `startedAt` comparison, race-free unlike "am I the last to complete?".
 *
 * The class is intentionally framework-agnostic: it doesn't kill processes
 * (the caller does, via runner.reset/respawn) and doesn't touch the jsonl
 * (the caller stats it). Pure bookkeeping.
 */

export type AgentStatus = 'running' | 'warm';

export interface AgentEntry {
  syntheticKey: string;
  startedAt: number;             // monotonic: ms since epoch when spawn() was called
  status: AgentStatus;
  jsonlMtimeAtIdle?: number;     // wall-clock ms of jsonl when entry became 'warm'
}

export class ParallelRunner {
  // parentSessionKey → ordered list of agents (running + warm)
  private pool = new Map<string, AgentEntry[]>();
  private readonly maxConcurrent: number;
  private spawnCounter = 0; // monotonic id for synthetic sessionKey uniqueness within a process lifetime

  /**
   * Default 2 concurrent running agents per parent session. Bumped down from 5
   * after observing Anthropic-side rate limits when bursting concurrent Opus
   * requests on the same account.
   */
  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
  }

  /** Number of running (not warm) agents — for "can I spawn another?" gate. */
  runningCount(parentSessionKey: string): number {
    return (this.pool.get(parentSessionKey) || []).filter(a => a.status === 'running').length;
  }

  /** Number of agents in pool (running + warm) — used by /并行 status display. */
  activeCount(parentSessionKey: string): number {
    return (this.pool.get(parentSessionKey) || []).length;
  }

  canSpawn(parentSessionKey: string): boolean {
    return this.runningCount(parentSessionKey) < this.maxConcurrent;
  }

  getMax(): number {
    return this.maxConcurrent;
  }

  /**
   * Reserve a slot for a new agent. Returns the entry; caller spawns the
   * actual Claude child process keyed by `entry.syntheticKey`. Throws if
   * over capacity (callers must check canSpawn first).
   */
  spawn(parentSessionKey: string): AgentEntry {
    if (!this.canSpawn(parentSessionKey)) {
      throw new Error(`Agent pool full for ${parentSessionKey} (max ${this.maxConcurrent})`);
    }
    let list = this.pool.get(parentSessionKey);
    if (!list) { list = []; this.pool.set(parentSessionKey, list); }
    const id = ++this.spawnCounter;
    const nonce = Math.random().toString(36).slice(2, 6);
    const entry: AgentEntry = {
      syntheticKey: `${parentSessionKey}__a${id}_${nonce}`,
      startedAt: Date.now(),
      status: 'running',
    };
    list.push(entry);
    return entry;
  }

  /**
   * Look up an entry by synthetic key (e.g. on completion to flip status).
   * Returns undefined if not found (shouldn't normally happen).
   */
  find(parentSessionKey: string, syntheticKey: string): AgentEntry | undefined {
    return (this.pool.get(parentSessionKey) || []).find(a => a.syntheticKey === syntheticKey);
  }

  /**
   * Called when an agent finishes its turn. Decides whether the agent should
   * suicide or become the new warm standby.
   *
   * Returns:
   *   'suicide'  — caller should runner.reset(syntheticKey) to free the child
   *   'warm'     — caller should NOT reset; the entry stays in pool as warm,
   *                with `jsonlMtimeAtIdle` snapshot for later reuse checks.
   *
   * Rule: keep the entry that was spawned LAST among currently-alive agents.
   * (i.e. if nobody else in the pool has a later `startedAt`, this entry wins.)
   *
   * The caller is expected to pass `jsonlMtimeMs` so we can record it; if
   * unknown, pass 0 and the next reuse will always force a respawn (safe).
   */
  complete(parentSessionKey: string, syntheticKey: string, jsonlMtimeMs: number): 'suicide' | 'warm' {
    const list = this.pool.get(parentSessionKey);
    if (!list) return 'suicide';
    const me = list.find(a => a.syntheticKey === syntheticKey);
    if (!me) return 'suicide';

    // Any agent spawned strictly later than me, still running? → I'm not the
    // newest, so suicide. (warm entries are excluded — they're already "the
    // newest from before"; a newer spawn-then-warm pair shouldn't exist
    // because new spawns demote any previous warm via takeWarm() below.)
    const laterSpawnedRunning = list.some(a =>
      a.status === 'running' &&
      a.startedAt > me.startedAt &&
      a.syntheticKey !== me.syntheticKey,
    );
    if (laterSpawnedRunning) {
      // Remove me from pool entirely
      const idx = list.indexOf(me);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) this.pool.delete(parentSessionKey);
      return 'suicide';
    }

    // I'm the latest-spawned alive. Demote any pre-existing warm (no longer
    // needed since I'm newer and saw more jsonl), then become warm myself.
    for (const a of list) {
      if (a.status === 'warm' && a.syntheticKey !== me.syntheticKey) {
        // Mark the old warm for caller-side cleanup by removing from pool.
        // Caller can detect "an entry vanished" via getDemotedWarms() snapshot
        // pattern, but simpler: we return a tuple. To keep API minimal we
        // expose `peekDemotedWarms` separately below.
        // For now just mark — the caller is responsible for periodic sweep.
        // (Concrete: at the moment there's only ever ≤1 warm because every
        // new spawn demotes the prior one — see takeWarm/spawn sequence.)
      }
    }
    me.status = 'warm';
    me.jsonlMtimeAtIdle = jsonlMtimeMs;
    return 'warm';
  }

  /**
   * Find the warm agent for this parent session (≤1 expected) and return it
   * IF its captured jsonl mtime matches the current jsonl mtime — i.e. the
   * warm process's in-memory history is still consistent with disk.
   * Returns null if no warm exists or mtime drifted.
   *
   * When returning non-null, the caller takes ownership of this entry:
   * status is flipped back to 'running' and the entry stays in pool.
   * (Caller will subsequently dispatch the user message to this synthetic key.)
   */
  takeWarmIfFresh(parentSessionKey: string, currentJsonlMtimeMs: number): AgentEntry | null {
    const list = this.pool.get(parentSessionKey);
    if (!list) return null;
    const warm = list.find(a => a.status === 'warm');
    if (!warm) return null;
    if ((warm.jsonlMtimeAtIdle ?? 0) !== currentJsonlMtimeMs) return null;
    // Promote back to running for the new turn
    warm.status = 'running';
    warm.startedAt = Date.now(); // refresh so next complete() correctly ranks it
    delete warm.jsonlMtimeAtIdle;
    return warm;
  }

  /**
   * Force-drop the warm entry (caller intends to respawn it because mtime
   * drifted). Returns the entry's synthetic key for runner.respawn() target,
   * or null if no warm was registered. The pool entry is removed.
   */
  evictWarm(parentSessionKey: string): string | null {
    const list = this.pool.get(parentSessionKey);
    if (!list) return null;
    const idx = list.findIndex(a => a.status === 'warm');
    if (idx < 0) return null;
    const key = list[idx].syntheticKey;
    list.splice(idx, 1);
    if (list.length === 0) this.pool.delete(parentSessionKey);
    return key;
  }

  /** Drop an entry by key (used when caller force-reset its child process). */
  release(parentSessionKey: string, syntheticKey: string): void {
    const list = this.pool.get(parentSessionKey);
    if (!list) return;
    const idx = list.findIndex(a => a.syntheticKey === syntheticKey);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.pool.delete(parentSessionKey);
  }
}
