/**
 * Per-session / per-turn token accounting.
 *
 * Usage arrives on `assistant/message` session events; each report is filed
 * into the peak or off-peak bucket according to the *request's own* timestamp,
 * so a turn that straddles a price boundary is still priced correctly. A turn
 * is settled on `turn/end`, which is what the status line reports as
 * "this turn cost".
 *
 * Pure and clock-injected: no timers, no I/O, no host services.
 *
 * @module dsh-peak-balance/tracker
 */

import { emptyBuckets, emptyTotals, estimateCostCny, totalTokens } from './pricing.js'
import { isPeak } from './peak.js'

/**
 * Coerce one provider usage report into plain counts.
 *
 * @param usage - `assistant/message` event `data.usage` (shape varies across
 *   adapters and durable replays); unknown fields are ignored.
 * @returns Counts, or `undefined` when the report carried no usable number.
 */
export function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const pick = (...names) => {
    for (const name of names) {
      const value = usage[name]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    }
    return undefined
  }
  const input = pick('inputTokens', 'input_tokens', 'input')
  const output = pick('outputTokens', 'output_tokens', 'output')
  const cacheRead = pick('cacheReadTokens', 'cache_read_tokens', 'cacheRead', 'cache_read_input_tokens')
  const cacheWrite = pick('cacheWriteTokens', 'cache_write_tokens', 'cacheWrite')
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined
  }
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
  }
}

/** Fold one report into a bucket, in place. */
export function addToBucket(bucket, counts) {
  bucket.input += counts.input
  bucket.output += counts.output
  bucket.cacheRead += counts.cacheRead
  bucket.cacheWrite += counts.cacheWrite
  return bucket
}

/** Fresh per-session accounting state. */
function freshState() {
  return {
    model: '',
    session: emptyBuckets(),
    turn: emptyBuckets(),
    turnIndex: 0,
    lastTurn: undefined,
  }
}

/**
 * Create one tracker. The caller owns one tracker per session.
 *
 * @returns A small mutable tracker with pure update methods.
 */
export function createTracker() {
  const state = freshState()

  const bucketFor = atMs => (isPeak(atMs) ? state.turn.peak : state.turn.idle)
  const sessionBucketFor = atMs => (isPeak(atMs) ? state.session.peak : state.session.idle)

  return {
    /** Current model id; used for pricing. */
    get model() {
      return state.model
    },

    /** Set the model seen on `request/header` (pricing key). */
    setModel(model) {
      if (typeof model === 'string' && model !== '') state.model = model
    },

    /**
     * Record one provider usage report.
     * @param usage - raw `data.usage` from an `assistant/message` event.
     * @param atMs - the event's timestamp (its own price window).
     * @returns The normalized counts, or `undefined` when unusable.
     */
    onUsage(usage, atMs = Date.now()) {
      const counts = normalizeUsage(usage)
      if (counts === undefined) return undefined
      addToBucket(bucketFor(atMs), counts)
      addToBucket(sessionBucketFor(atMs), counts)
      return counts
    },

    /** Tokens accumulated in the running turn. */
    turnTokens() {
      return totalTokens(state.turn)
    },

    /** Estimated cost of the running turn, or `undefined` (unrated model / empty). */
    turnCost(atMs = Date.now(), customRates = undefined) {
      return estimateCostCny(state.turn, state.model, atMs, customRates)
    },

    /** Estimated cost of the whole session, or `undefined`. */
    sessionCost(atMs = Date.now(), customRates = undefined) {
      return estimateCostCny(state.session, state.model, atMs, customRates)
    },

    /**
     * Close the running turn: settle its cost, reset the turn buckets and
     * remember the result for the status line.
     *
     * @param atMs - settlement instant (rerating only).
     * @param customRates - user-supplied rates from `/th price` (optional).
     * @returns The settled `{ cost, tokens, model, turn }`, or `undefined` when
     *   the turn produced no token report.
     */
    endTurn(atMs = Date.now(), customRates = undefined) {
      const tokens = this.turnTokens()
      const cost = this.turnCost(atMs, customRates)
      state.turnIndex += 1
      if (tokens <= 0) {
        state.turn = emptyBuckets()
        return undefined
      }
      const settled = { cost, tokens, model: state.model, turn: state.turnIndex }
      state.lastTurn = settled
      state.turn = emptyBuckets()
      return settled
    },

    /** The most recently settled turn, or `undefined`. */
    lastTurn() {
      return state.lastTurn
    },

    /** Read-only snapshot for tests and diagnostics. */
    snapshot() {
      return {
        model: state.model,
        session: { peak: { ...state.session.peak }, idle: { ...state.session.idle } },
        turn: { peak: { ...state.turn.peak }, idle: { ...state.turn.idle } },
        turnIndex: state.turnIndex,
        lastTurn: state.lastTurn === undefined ? undefined : { ...state.lastTurn },
      }
    },

    /** Drop all accounting (session restart). */
    reset() {
      const fresh = freshState()
      state.model = fresh.model
      state.session = fresh.session
      state.turn = fresh.turn
      state.turnIndex = fresh.turnIndex
      state.lastTurn = fresh.lastTurn
    },
  }
}

/** An empty bucket literal, re-exported for callers building fixtures. */
export { emptyTotals }
