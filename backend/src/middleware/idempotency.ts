import { createHash } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import { LRUCache } from 'lru-cache'
import { ErrorCode } from '../errors/errorCodes.js'

interface CachedResponse {
  status: number
  body: unknown
  createdAt: number
}

export interface IdempotencyStore {
  get(key: string): CachedResponse | undefined
  set(key: string, value: CachedResponse): void
  has(key: string): boolean
  markInFlight(key: string): boolean
  clearInFlight(key: string): void
  size: number
  stop(): void
}

export class LRUIdempotencyStore implements IdempotencyStore {
  private cache: LRUCache<string, CachedResponse>
  private inFlight = new Set<string>()

  constructor(ttlMs: number) {
    this.cache = new LRUCache({
      max: 10000,
      ttl: ttlMs,
    })
  }

  get(key: string): CachedResponse | undefined {
    return this.cache.get(key)
  }

  set(key: string, value: CachedResponse): void {
    this.cache.set(key, value)
    this.inFlight.delete(key)
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  markInFlight(key: string): boolean {
    if (this.inFlight.has(key)) return false
    this.inFlight.add(key)
    return true
  }

  clearInFlight(key: string): void {
    this.inFlight.delete(key)
  }

  get size(): number {
    return this.cache.size
  }

  stop(): void {
    this.cache.clear()
    this.inFlight.clear()
  }
}

const DEFAULT_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

const defaultStore = new LRUIdempotencyStore(DEFAULT_DEDUP_WINDOW_MS)

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function idempotency(store: IdempotencyStore = defaultStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.headers['idempotency-key']

    if (typeof key !== 'string' || key.trim() === '') {
      res.status(400).json({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Missing or empty Idempotency-Key header',
          docs: 'https://docs.shelterflex.com/api#idempotency'
        },
      })
      return
    }

    const trimmedKey = key.trim()
    if (!uuidRegex.test(trimmedKey)) {
      res.status(400).json({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Idempotency-Key must be a valid UUID',
          docs: 'https://docs.shelterflex.com/api#idempotency'
        },
      })
      return
    }

    const userId = (req as any).user?.id || req.headers['x-user-id'] || 'anonymous'

    const cacheKey = createHash('sha256')
      .update(`${userId}:${trimmedKey}`)
      .digest('hex')

    const cached = store.get(cacheKey)
    if (cached) {
      res.setHeader('x-idempotent-replay', 'true')
      res.status(cached.status).json(cached.body)
      return
    }

    if (!store.markInFlight(cacheKey)) {
      res.status(409).json({
        code: 'REQUEST_IN_FLIGHT',
        message: 'A request with this idempotency key is already being processed'
      })
      return
    }

    const originalJson = res.json.bind(res)
    res.json = (body: unknown) => {
      store.set(cacheKey, {
        status: res.statusCode,
        body,
        createdAt: Date.now()
      })
      return originalJson(body)
    }

    res.on('close', () => {
      if (!store.has(cacheKey)) {
        store.clearInFlight(cacheKey)
      }
    })

    next()
  }
}

export { defaultStore }
