import { getProxyPools } from "@/lib/db/index.js";

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * StatefulProxyRotator
 *
 * Guarantees:
 * 1. Shuffled deck (Fisher-Yates) — every pool is used exactly once per cycle before repeat.
 * 2. Cycle-boundary guard — first card of a new cycle is swapped if it matches lastUsedId.
 * 3. In-flight protection — in-use proxies are never allocated to overlapping concurrent requests.
 * 4. Cooldown on network/proxy failure — failed proxies are quarantined (default 60s).
 * 5. In-flight wait queue — if all proxies are busy, requests wait (FIFO); never falls back to direct.
 * 6. strictProxy: true — enforced on every lease.
 */
export class StatefulProxyRotator {
  constructor({
    provider = "grok-cli",
    cooldownMs = 60000,
    waitTimeoutMs = 15000,
    refreshIntervalMs = 60000,
    fetchPoolsFn = null,
  } = {}) {
    this.provider = provider;
    this.cooldownMs = cooldownMs;
    this.waitTimeoutMs = waitTimeoutMs;
    this.refreshIntervalMs = refreshIntervalMs;
    this.fetchPoolsFn = fetchPoolsFn || (() => getProxyPools({ isActive: true }));

    this.poolsMap = new Map(); // poolId -> pool object
    this.deck = []; // Array of pool IDs for current cycle
    this.lastUsedId = null;
    this.inFlight = new Set(); // Set of currently in-flight pool IDs
    this.cooldown = new Map(); // poolId -> cooldownEndTimestamp
    this.waitQueue = []; // Array of { resolve, reject, signal, timer }

    this.lastRefreshAt = 0;
    this.initialized = false;
  }

  /**
   * Refresh pool definitions from DB
   */
  async refreshPools(force = false) {
    const now = Date.now();
    if (!force && this.initialized && now - this.lastRefreshAt < this.refreshIntervalMs) {
      return;
    }

    try {
      const pools = await this.fetchPoolsFn();
      const validPools = (pools || []).filter((p) => p && p.isActive !== false && typeof p.proxyUrl === "string" && p.proxyUrl.trim().length > 0);

      const nextMap = new Map();
      const newPoolIds = [];

      for (const p of validPools) {
        nextMap.set(p.id, {
          id: p.id,
          name: p.name || p.id,
          proxyUrl: p.proxyUrl.trim(),
          noProxy: p.noProxy || "",
          type: p.type || "http",
          strictProxy: true,
        });
        newPoolIds.push(p.id);
      }

      this.poolsMap = nextMap;
      this.lastRefreshAt = now;

      // Clean up stale IDs from inFlight and cooldown
      for (const id of this.inFlight) {
        if (!this.poolsMap.has(id)) this.inFlight.delete(id);
      }
      for (const id of this.cooldown.keys()) {
        if (!this.poolsMap.has(id)) this.cooldown.delete(id);
      }

      // If deck is empty or corrupted, build a new cycle
      if (this.deck.length === 0 && newPoolIds.length > 0) {
        this._refillDeck();
      } else {
        // Filter out any deleted pools from existing deck
        this.deck = this.deck.filter((id) => this.poolsMap.has(id));
      }

      this.initialized = true;
    } catch (err) {
      if (!this.initialized) {
        throw new Error(`[StatefulProxyRotator] Failed to initialize proxy pools: ${err.message}`);
      }
    }
  }

  /**
   * Refill and shuffle deck for a new cycle
   */
  _refillDeck() {
    const allIds = Array.from(this.poolsMap.keys());
    if (allIds.length === 0) {
      this.deck = [];
      return;
    }

    const shuffled = shuffleArray(allIds);

    // Guard cycle boundary: if the candidate at the top (pop end) matches lastUsedId, swap it
    if (shuffled.length > 1 && shuffled[shuffled.length - 1] === this.lastUsedId) {
      const swapIndex = Math.floor(Math.random() * (shuffled.length - 1));
      [shuffled[shuffled.length - 1], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[shuffled.length - 1]];
    }

    this.deck = shuffled;
  }

  /**
   * Internal synchronous allocation attempt
   */
  _tryAllocate() {
    const now = Date.now();

    // Expire cooldowns
    for (const [id, until] of this.cooldown.entries()) {
      if (now >= until) {
        this.cooldown.delete(id);
      }
    }

    if (this.poolsMap.size === 0) return null;

    if (this.deck.length === 0) {
      this._refillDeck();
    }

    const skipped = [];
    let candidateId = null;

    while (this.deck.length > 0) {
      const id = this.deck.pop();

      // Check if candidate is still valid
      if (!this.poolsMap.has(id)) continue;

      // Skip if currently in-flight
      if (this.inFlight.has(id)) {
        skipped.push(id);
        continue;
      }

      // Skip if in cooldown
      const cdUntil = this.cooldown.get(id);
      if (cdUntil && now < cdUntil) {
        skipped.push(id);
        continue;
      }

      candidateId = id;
      break;
    }

    // Preserve skipped candidates for future cycles or later in this cycle
    if (skipped.length > 0) {
      this.deck.unshift(...skipped);
    }

    if (candidateId) {
      this.inFlight.add(candidateId);
      this.lastUsedId = candidateId;
      const pool = this.poolsMap.get(candidateId);
      return this._createLease(candidateId, pool);
    }

    return null;
  }

  /**
   * Create a proxy lease
   */
  _createLease(poolId, pool) {
    let released = false;

    return {
      proxyPoolId: poolId,
      proxyUrl: pool.proxyUrl,
      type: pool.type,
      noProxy: pool.noProxy,
      strictProxy: true,
      provider: this.provider,

      release: () => {
        if (released) return;
        released = true;
        this.release(poolId);
      },

      markFailed: (error, customCooldownMs) => {
        if (released) return;
        released = true;
        this.markFailed(poolId, error, customCooldownMs);
      },
    };
  }

  /**
   * Acquire a proxy lease. If all proxies are in-flight or in cooldown,
   * waits in FIFO queue up to timeoutMs. Never falls back to direct.
   */
  async acquire({ signal, timeoutMs = this.waitTimeoutMs } = {}) {
    const now = Date.now();
    if (!this.initialized || now - this.lastRefreshAt >= this.refreshIntervalMs) {
      await this.refreshPools();
    }
    const immediateLease = this._tryAllocate();
    if (immediateLease) {
      return immediateLease;
    }

    // Queue request
    return new Promise((resolve, reject) => {
      let timer = null;
      let abortListener = null;

      const cleanup = () => {
        clearTimeout(timer);
        if (signal && abortListener) {
          signal.removeEventListener("abort", abortListener);
        }
      };

      const entry = {
        resolve: (lease) => {
          cleanup();
          resolve(lease);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };

      if (signal) {
        if (signal.aborted) {
          return reject(new Error("Proxy acquisition aborted"));
        }
        abortListener = () => {
          const idx = this.waitQueue.indexOf(entry);
          if (idx !== -1) this.waitQueue.splice(idx, 1);
          entry.reject(new Error("Proxy acquisition aborted"));
        };
        signal.addEventListener("abort", abortListener);
      }

      timer = setTimeout(() => {
        const idx = this.waitQueue.indexOf(entry);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        entry.reject(
          new Error(`[StatefulProxyRotator] Timeout waiting for proxy (${timeoutMs}ms; inFlight=${this.inFlight.size}, cooldown=${this.cooldown.size})`)
        );
      }, timeoutMs);

      this.waitQueue.push(entry);
    });
  }

  /**
   * Release a proxy after successful stream/response completion
   */
  release(poolId) {
    this.inFlight.delete(poolId);
    this._drainQueue();
  }

  /**
   * Mark proxy as failed and place in cooldown
   */
  markFailed(poolId, error = null, customCooldownMs = null) {
    this.inFlight.delete(poolId);
    const duration = typeof customCooldownMs === "number" ? customCooldownMs : this.cooldownMs;
    this.cooldown.set(poolId, Date.now() + duration);
    this._drainQueue();
  }

  /**
   * Drain FIFO wait queue when a proxy is released or cooldown expires
   */
  _drainQueue() {
    while (this.waitQueue.length > 0) {
      const lease = this._tryAllocate();
      if (!lease) break;
      const next = this.waitQueue.shift();
      next.resolve(lease);
    }
  }

  /**
   * Diagnostic stats
   */
  getStats() {
    return {
      provider: this.provider,
      totalPools: this.poolsMap.size,
      deckRemaining: this.deck.length,
      inFlightCount: this.inFlight.size,
      cooldownCount: this.cooldown.size,
      waitingQueueLength: this.waitQueue.length,
      lastUsedId: this.lastUsedId,
    };
  }

  /**
   * Reset rotator state (for testing)
   */
  _resetForTesting() {
    this.deck = [];
    this.inFlight.clear();
    this.cooldown.clear();
    while (this.waitQueue.length > 0) {
      const w = this.waitQueue.shift();
      w.reject(new Error("Rotator reset"));
    }
    this.lastUsedId = null;
    this.initialized = false;
  }
}

// Singleton instances per provider to maintain in-flight and deck continuity across requests
const rotators = new Map();

export function getStatefulProxyRotator(provider = "grok-cli", options = {}) {
  const key = String(provider).toLowerCase();
  if (!rotators.has(key)) {
    rotators.set(key, new StatefulProxyRotator({ provider: key, ...options }));
  }
  return rotators.get(key);
}

export default getStatefulProxyRotator;
