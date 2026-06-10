/**
 * Abuse protection for the two LLM endpoints: per-IP token bucket + a global
 * daily call budget. In-memory on purpose — single Fly machine, no shared state.
 *
 * Env knobs:
 *   RATE_LIMIT_RPM   tokens refilled per minute per IP   (default 10)
 *   RATE_LIMIT_BURST bucket capacity per IP              (default 5)
 *   LLM_DAILY_BUDGET total LLM calls allowed per UTC day (default 2000)
 */
import type { MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'

const RATE_LIMIT_RPM = Number(process.env.RATE_LIMIT_RPM ?? 10)
const RATE_LIMIT_BURST = Number(process.env.RATE_LIMIT_BURST ?? 5)
const LLM_DAILY_BUDGET = Number(process.env.LLM_DAILY_BUDGET ?? 2000)

interface Bucket {
  tokens: number
  updatedAt: number
}

const buckets = new Map<string, Bucket>()
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

  // Per-IP token bucket (Fly fronts us, so trust the first x-forwarded-for hop)
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    getConnInfo(c).remote.address ||
    'unknown'
  const nowMs = now.getTime()
  let bucket = buckets.get(ip)
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_BURST, updatedAt: nowMs }
    buckets.set(ip, bucket)
  } else {
    bucket.tokens = Math.min(
      RATE_LIMIT_BURST,
      bucket.tokens + ((nowMs - bucket.updatedAt) / 60_000) * RATE_LIMIT_RPM,
    )
    bucket.updatedAt = nowMs
  }
  if (bucket.tokens < 1) {
    const retryAfter = Math.max(1, Math.ceil(((1 - bucket.tokens) / RATE_LIMIT_RPM) * 60))
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
  bucket.tokens -= 1
  budgetUsed += 1

  // Keep the map bounded: drop buckets idle for >10 minutes
  if (buckets.size > 10_000) {
    for (const [key, b] of buckets) {
      if (nowMs - b.updatedAt > 600_000) buckets.delete(key)
    }
  }

  await next()
}
