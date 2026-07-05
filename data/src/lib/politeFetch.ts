/**
 * Polite JSON fetch client for museum collection APIs: request pacing with a
 * small concurrency pool, session-cookie reuse (Imperva/Incapsula treats a
 * cookie-holding client as one "visitor"), and WAF-aware retry — 403 is
 * transient bot-blocking (waits ≥60 s), 429/5xx back off exponentially,
 * 404 resolves to null (deleted/invalid record).
 *
 * Extracted verbatim from data/src/objects.ts + data/src/nightly.ts (the two
 * copies had identical semantics). Per-source pacing lives in the options so
 * each museum adapter declares its own etiquette.
 */

export interface PoliteClientOptions {
  /** Nominal request starts per second (the pool paces starts, not completions). */
  reqsPerSec: number;
  /** Pool width for pooledMap. */
  concurrency: number;
  /** Retry attempts before giving up (default 10). */
  maxAttempts?: number;
  /** User-Agent header. Default: a desktop-browser UA (default node UAs get 403 from some CDNs). */
  userAgent?: string;
  /** Extra headers sent on every request. */
  headers?: Record<string, string>;
  /** Label used in retry/progress logs. */
  label?: string;
}

export interface PoliteClient {
  fetchJson(url: string): Promise<any>;
  /**
   * Run `fn` over items with the pool, pacing request starts at reqsPerSec.
   * Logs progress with rate + ETA every `progressEvery` completions (default 1000).
   */
  pooledMap<T>(items: T[], fn: (item: T) => Promise<void>, progressEvery?: number): Promise<void>;
}

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createPoliteClient(opts: PoliteClientOptions): PoliteClient {
  const maxAttempts = opts.maxAttempts ?? 10;
  const ua = opts.userAgent ?? BROWSER_UA;
  const label = opts.label ?? "politeFetch";
  let cookie = ""; // session cookies — reusing them keeps us one "visitor"

  async function fetchJson(url: string): Promise<any> {
    let delay = 2000;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
          headers: { "user-agent": ua, ...(opts.headers ?? {}), ...(cookie ? { cookie } : {}) },
        });
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        await sleep(delay);
        delay = Math.min(delay * 2, 60_000);
        continue;
      }
      const setCookies = res.headers.getSetCookie();
      if (setCookies.length) cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
      if (res.ok) {
        // A 200 that isn't JSON is a bot-challenge/maintenance page in
        // disguise (measured 2026-07-05: collections.louvre.fr served an
        // HTML challenge with HTTP 200 ~12k requests into a hydration,
        // which crashed the run via res.json()). Treat it exactly like a
        // 403: long wait, keep retrying — the challenge lifts.
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          if (attempt >= maxAttempts)
            throw new Error(`non-JSON 200 (bot challenge?) for ${url}: ${text.slice(0, 80)}`);
          const wait = Math.max(delay, 120_000);
          console.log(
            `${label}: non-JSON 200 on ${url} (bot challenge?), retry ${attempt}/${maxAttempts} in ${wait / 1000}s`,
          );
          await sleep(wait);
          delay = Math.min(delay * 2, 300_000);
          continue;
        }
      }
      if (res.status === 404) return null; // invalid/removed record
      // 403 = WAF bot-block (transient, lifts in ~1 min) — wait it out like 429/5xx
      if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const wait = res.status === 403 ? Math.max(delay, 60_000) : delay;
        if (attempt >= 2) {
          console.log(`${label}: ${res.status} on ${url}, retry ${attempt}/${maxAttempts} in ${wait / 1000}s`);
        }
        await sleep(wait);
        delay = Math.min(delay * 2, 120_000);
        continue;
      }
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
  }

  async function pooledMap<T>(
    items: T[],
    fn: (item: T) => Promise<void>,
    progressEvery = 1000,
  ): Promise<void> {
    const interval = 1000 / opts.reqsPerSec;
    let nextStart = Date.now();
    let i = 0;
    let done = 0;
    const t0 = Date.now();

    async function worker(): Promise<void> {
      while (i < items.length) {
        const item = items[i++];
        const wait = nextStart - Date.now();
        nextStart = Math.max(nextStart, Date.now()) + interval;
        if (wait > 0) await sleep(wait);
        await fn(item);
        done++;
        if (done % progressEvery === 0) {
          const rate = done / ((Date.now() - t0) / 1000);
          const etaMin = Math.round((items.length - done) / rate / 60);
          console.log(`${label}: ${done}/${items.length} (${rate.toFixed(1)} req/s, eta ${etaMin} min)`);
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(opts.concurrency, Math.max(items.length, 1)) }, worker),
    );
  }

  return { fetchJson, pooledMap };
}
