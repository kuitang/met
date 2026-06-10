/**
 * Abuse protection. Two limiter families, both in-memory on purpose — single
 * Fly machine, no shared state:
 *  - llmRateLimit: per-IP token bucket + a global daily call budget for the
 *    two LLM endpoints.
 *  - imgRateLimit: a separate, much more generous per-IP bucket for the image
 *    proxy (a page load legitimately bursts many images). It never touches
 *    the LLM budget.
 *
 * Env knobs:
 *   RATE_LIMIT_RPM       LLM tokens refilled per minute per IP  (default 10)
 *   RATE_LIMIT_BURST     LLM bucket capacity per IP             (default 5)
 *   LLM_DAILY_BUDGET     total LLM calls allowed per UTC day    (default 2000)
 *   IMG_RATE_LIMIT_RPM   image tokens per minute per IP         (default 120)
 *   IMG_RATE_LIMIT_BURST image bucket capacity per IP           (default 60)
 */
import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'

const RATE_LIMIT_RPM = Number(process.env.RATE_LIMIT_RPM ?? 10)
const RATE_LIMIT_BURST = Number(process.env.RATE_LIMIT_BURST ?? 5)
const LLM_DAILY_BUDGET = Number(process.env.LLM_DAILY_BUDGET ?? 2000)
const IMG_RATE_LIMIT_RPM = Number(process.env.IMG_RATE_LIMIT_RPM ?? 120)
const IMG_RATE_LIMIT_BURST = Number(process.env.IMG_RATE_LIMIT_BURST ?? 60)

interface Bucket {
  tokens: number
  updatedAt: number
}

function clientIp(c: Context): string {
  // Fly fronts us, so trust the first x-forwarded-for hop
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    getConnInfo(c).remote.address ||
    'unknown'
  )
}

/**
 * Take one token from `ip`'s bucket. Returns 0 when allowed, otherwise the
 * suggested Retry-After in seconds.
 */
function takeToken(
  buckets: Map<string, Bucket>,
  ip: string,
  nowMs: number,
  rpm: number,
  burst: number,
): number {
  let bucket = buckets.get(ip)
  if (!bucket) {
    bucket = { tokens: burst, updatedAt: nowMs }
    buckets.set(ip, bucket)
  } else {
    bucket.tokens = Math.min(burst, bucket.tokens + ((nowMs - bucket.updatedAt) / 60_000) * rpm)
    bucket.updatedAt = nowMs
  }
  if (bucket.tokens < 1) {
    return Math.max(1, Math.ceil(((1 - bucket.tokens) / rpm) * 60))
  }
  bucket.tokens -= 1
  // Keep the map bounded: drop buckets idle for >10 minutes
  if (buckets.size > 10_000) {
    for (const [key, b] of buckets) {
      if (nowMs - b.updatedAt > 600_000) buckets.delete(key)
    }
  }
  return 0
}

function rateLimited(c: Context, retryAfter: number) {
  c.header('Retry-After', String(retryAfter))
  return c.json(
    {
      error: {
        code: 'rate_limited',
        message: 'Too many requests from this address; slow down.',
        retryAfter,
      },
    },
    429,
  )
}

const llmBuckets = new Map<string, Bucket>()
const imgBuckets = new Map<string, Bucket>()
let budgetDay = ''
let budgetUsed = 0

function secondsToUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.ceil((next - now.getTime()) / 1000)
}

export const llmRateLimit: MiddlewareHandler = async (c, next) => {
  // Daily budget (resets at UTC midnight)
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  if (today !== budgetDay) {
    budgetDay = today
    budgetUsed = 0
  }
  if (budgetUsed >= LLM_DAILY_BUDGET) {
    const retryAfter = secondsToUtcMidnight(now)
    c.header('Retry-After', String(retryAfter))
    return c.json(
      {
        error: {
          code: 'budget_exhausted',
          message: 'Daily LLM budget exhausted; LLM-backed features resume tomorrow.',
          retryAfter,
        },
      },
      503,
    )
  }

  const retryAfter = takeToken(
    llmBuckets,
    clientIp(c),
    now.getTime(),
    RATE_LIMIT_RPM,
    RATE_LIMIT_BURST,
  )
  if (retryAfter > 0) return rateLimited(c, retryAfter)
  budgetUsed += 1

  await next()
}

export const imgRateLimit: MiddlewareHandler = async (c, next) => {
  const retryAfter = takeToken(
    imgBuckets,
    clientIp(c),
    Date.now(),
    IMG_RATE_LIMIT_RPM,
    IMG_RATE_LIMIT_BURST,
  )
  if (retryAfter > 0) return rateLimited(c, retryAfter)
  await next()
}
