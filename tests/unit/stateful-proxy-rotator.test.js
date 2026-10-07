import { describe, it, expect, beforeEach, vi } from "vitest";
import { StatefulProxyRotator } from "../../src/lib/network/statefulProxyRotator.js";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";

describe("StatefulProxyRotator", () => {
  let mockPools;
  let rotator;

  beforeEach(() => {
    mockPools = [
      { id: "p1", name: "Pool 1", proxyUrl: "http://127.0.0.1:8001", isActive: true },
      { id: "p2", name: "Pool 2", proxyUrl: "http://127.0.0.1:8002", isActive: true },
      { id: "p3", name: "Pool 3", proxyUrl: "http://127.0.0.1:8003", isActive: true },
      { id: "p4", name: "Pool 4", proxyUrl: "http://127.0.0.1:8004", isActive: true },
      { id: "p5", name: "Pool 5", proxyUrl: "http://127.0.0.1:8005", isActive: true },
    ];

    rotator = new StatefulProxyRotator({
      provider: "grok-cli",
      cooldownMs: 1000,
      waitTimeoutMs: 500,
      refreshIntervalMs: 100000,
      fetchPoolsFn: async () => mockPools,
    });
  });

  it("allocates each proxy exactly once per cycle (anti-repeat)", async () => {
    const allocated = [];
    for (let i = 0; i < 5; i++) {
      const lease = await rotator.acquire();
      allocated.push(lease.proxyPoolId);
      lease.release();
    }

    // Must contain all 5 unique pool IDs
    expect(new Set(allocated).size).toBe(5);
    expect(allocated.sort()).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("never allocates an in-flight proxy to an overlapping concurrent request", async () => {
    const lease1 = await rotator.acquire();
    const lease2 = await rotator.acquire();
    const lease3 = await rotator.acquire();

    // None of the in-flight leases should share the same pool ID
    expect(lease1.proxyPoolId).not.toBe(lease2.proxyPoolId);
    expect(lease2.proxyPoolId).not.toBe(lease3.proxyPoolId);
    expect(lease1.proxyPoolId).not.toBe(lease3.proxyPoolId);

    const stats = rotator.getStats();
    expect(stats.inFlightCount).toBe(3);

    lease1.release();
    lease2.release();
    lease3.release();

    expect(rotator.getStats().inFlightCount).toBe(0);
  });

  it("queues and waits when all proxies are in-flight instead of falling back to direct", async () => {
    // Acquire all 5 proxies
    const leases = [];
    for (let i = 0; i < 5; i++) {
      leases.push(await rotator.acquire());
    }

    expect(rotator.getStats().inFlightCount).toBe(5);

    // 6th acquire should be queued
    let queuedResolved = false;
    let lease6 = null;
    const acquirePromise = rotator.acquire({ timeoutMs: 1000 }).then((l) => {
      queuedResolved = true;
      lease6 = l;
      return l;
    });

    // Yield microtask to allow async acquire to reach the queue
    await new Promise((r) => setTimeout(r, 10));

    // Check that it's waiting
    expect(queuedResolved).toBe(false);
    expect(rotator.getStats().waitingQueueLength).toBe(1);
    // Release one proxy
    const releasedPoolId = leases[0].proxyPoolId;
    leases[0].release();

    // Now the queued acquire resolves
    await acquirePromise;
    expect(queuedResolved).toBe(true);
    expect(lease6).toBeTruthy();
    expect(lease6.strictProxy).toBe(true);

    lease6.release();
    for (let i = 1; i < 5; i++) {
      leases[i].release();
    }
  });

  it("times out with error if all proxies remain saturated (never direct)", async () => {
    const leases = [];
    for (let i = 0; i < 5; i++) {
      leases.push(await rotator.acquire());
    }

    // 6th acquire with short timeout
    await expect(rotator.acquire({ timeoutMs: 50 })).rejects.toThrow(/Timeout waiting for proxy/);

    for (const l of leases) l.release();
  });

  it("places failed proxy into cooldown and skips it on next acquire", async () => {
    const lease = await rotator.acquire();
    const failedId = lease.proxyPoolId;

    // Mark failed
    lease.markFailed(new Error("ECONNRESET"), 5000);

    expect(rotator.getStats().cooldownCount).toBe(1);

    // Next acquire should not be the failed one
    const nextLease = await rotator.acquire();
    expect(nextLease.proxyPoolId).not.toBe(failedId);

    nextLease.release();
  });

  it("cycle boundary guard ensures first card of new cycle is not lastUsedId", async () => {
    // Run two full cycles (10 allocations)
    let previousId = null;
    for (let i = 0; i < 10; i++) {
      const lease = await rotator.acquire();
      if (i === 5) {
        // At the cycle boundary (index 5 is the first of cycle 2), it should not match index 4
        expect(lease.proxyPoolId).not.toBe(previousId);
      }
      previousId = lease.proxyPoolId;
      lease.release();
    }
  });

  it("always enforces strictProxy: true on every lease", async () => {
    const lease = await rotator.acquire();
    expect(lease.strictProxy).toBe(true);
    expect(lease.proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:800/);
    lease.release();
  });
});

describe("GrokCliExecutor rotating proxy retry integration", () => {
  it("retries same logical request with a fresh proxy on network failure", async () => {
    const executor = new GrokCliExecutor();

    const usedPools = [];
    const mockRotator = {
      acquire: vi.fn().mockImplementation(async () => {
        const poolId = `p${usedPools.length + 1}`;
        usedPools.push(poolId);
        return {
          proxyPoolId: poolId,
          proxyUrl: `http://127.0.0.1:800${usedPools.length}`,
          strictProxy: true,
          release: vi.fn(),
          markFailed: vi.fn(),
        };
      }),
    };

    let attemptCount = 0;
    // Mock BaseExecutor.prototype.execute
    vi.spyOn(Object.getPrototypeOf(GrokCliExecutor.prototype), "execute").mockImplementation(async (args) => {
      attemptCount++;
      if (attemptCount === 1) {
        const netErr = new Error("fetch failed: socket hang up");
        netErr.code = "ECONNRESET";
        throw netErr;
      }
      return {
        response: new Response('data: {"choices":[]}\n\n', { status: 200 }),
        url: "https://cli-chat-proxy.grok.com/v1/responses",
        headers: {},
        transformedBody: {},
      };
    });

    const result = await executor.execute({
      model: "grok-2",
      body: { input: [] },
      stream: true,
      credentials: { accessToken: "test-token" },
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      proxyOptions: { rotator: mockRotator },
    });

    expect(attemptCount).toBe(2);
    expect(usedPools).toEqual(["p1", "p2"]);
    expect(result.response.status).toBe(200);
  });

  it("does NOT retry across proxies for account/auth errors (401, 429)", async () => {
    const executor = new GrokCliExecutor();

    const usedPools = [];
    const mockRotator = {
      acquire: vi.fn().mockImplementation(async () => {
        const poolId = `p${usedPools.length + 1}`;
        usedPools.push(poolId);
        return {
          proxyPoolId: poolId,
          proxyUrl: `http://127.0.0.1:800${usedPools.length}`,
          strictProxy: true,
          release: vi.fn(),
          markFailed: vi.fn(),
        };
      }),
    };

    let attemptCount = 0;
    vi.spyOn(Object.getPrototypeOf(GrokCliExecutor.prototype), "execute").mockImplementation(async () => {
      attemptCount++;
      return {
        response: new Response('{"error":"unauthorized"}', { status: 401 }),
        url: "https://cli-chat-proxy.grok.com/v1/responses",
        headers: {},
        transformedBody: {},
      };
    });

    const result = await executor.execute({
      model: "grok-2",
      body: { input: [] },
      stream: true,
      credentials: { accessToken: "expired-token" },
      log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      proxyOptions: { rotator: mockRotator },
    });

    // Exactly 1 attempt — must NOT retry proxy for auth error!
    expect(attemptCount).toBe(1);
    expect(result.response.status).toBe(401);
  });

  it("bounds proxy retries to MAX_PROXY_RETRIES (3) on continuous failure", async () => {
    const executor = new GrokCliExecutor();

    const usedPools = [];
    const mockRotator = {
      acquire: vi.fn().mockImplementation(async () => {
        const poolId = `p${usedPools.length + 1}`;
        usedPools.push(poolId);
        return {
          proxyPoolId: poolId,
          proxyUrl: `http://127.0.0.1:800${usedPools.length}`,
          strictProxy: true,
          release: vi.fn(),
          markFailed: vi.fn(),
        };
      }),
    };

    let attemptCount = 0;
    vi.spyOn(Object.getPrototypeOf(GrokCliExecutor.prototype), "execute").mockImplementation(async () => {
      attemptCount++;
      const netErr = new Error("ETIMEDOUT: connect timeout");
      netErr.code = "ETIMEDOUT";
      throw netErr;
    });

    await expect(
      executor.execute({
        model: "grok-2",
        body: { input: [] },
        stream: true,
        credentials: { accessToken: "token" },
        log: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        proxyOptions: { rotator: mockRotator },
      })
    ).rejects.toThrow(/ETIMEDOUT/);

    expect(attemptCount).toBe(3);
    expect(usedPools).toEqual(["p1", "p2", "p3"]);
  });
});
