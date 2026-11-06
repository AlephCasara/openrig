/**
 * Fail closed for global fetch() outside loopback in disposable daemon A/B
 * benchmarks. This guard applies only to the benchmark's daemon Node process,
 * not to child provider executables or non-fetch network clients.
 */
const originalFetch = globalThis.fetch;
globalThis.fetch = function benchmarkLoopbackOnlyFetch(input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    return Promise.reject(new Error("BENCH_FETCH_GUARD: non-loopback fetch refused"));
  }
  return originalFetch(input, init);
};
