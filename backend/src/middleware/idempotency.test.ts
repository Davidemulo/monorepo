import { describe, it, expect, beforeEach } from 'vitest'
import express, { type Request, type Response } from 'express'
import supertest from 'supertest'
import { idempotency, LRUIdempotencyStore } from './idempotency.js'

function buildApp(store: LRUIdempotencyStore) {
  const app = express()
  app.use(express.json())

  let callCount = 0

  app.post('/test', idempotency(store), (_req: Request, res: Response) => {
    callCount++
    res.status(201).json({ created: true, callCount })
  })

  return { app, getCallCount: () => callCount }
}

describe('idempotency middleware', () => {
  let store: LRUIdempotencyStore

  beforeEach(() => {
    store = new LRUIdempotencyStore(60_000)
  })

  it('rejects requests without idempotency-key', async () => {
    const { app } = buildApp(store)
    const res = await supertest(app).post('/test').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toContain('Idempotency-Key')
  })

  it('rejects requests with empty idempotency-key', async () => {
    const { app } = buildApp(store)
    const res = await supertest(app)
      .post('/test')
      .set('idempotency-key', '   ')
      .send({})
    expect(res.status).toBe(400)
  })

  it('rejects keys that are not valid UUIDs', async () => {
    const { app } = buildApp(store)
    const longKey = 'a'.repeat(257)
    const res = await supertest(app)
      .post('/test')
      .set('idempotency-key', longKey)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('UUID')
  })

  it('allows the first request through', async () => {
    const { app, getCallCount } = buildApp(store)
    const res = await supertest(app)
      .post('/test')
      .set('idempotency-key', '123e4567-e89b-12d3-a456-426614174000')
      .send({})

    expect(res.status).toBe(201)
    expect(res.body.created).toBe(true)
    expect(getCallCount()).toBe(1)
  })

  it('replays cached response for duplicate key', async () => {
    const { app, getCallCount } = buildApp(store)

    const first = await supertest(app)
      .post('/test')
      .set('idempotency-key', '123e4567-e89b-12d3-a456-426614174001')
      .send({})
    expect(first.status).toBe(201)
    expect(first.body.callCount).toBe(1)

    const second = await supertest(app)
      .post('/test')
      .set('idempotency-key', '123e4567-e89b-12d3-a456-426614174001')
      .send({})

    expect(second.status).toBe(201)
    expect(second.body.callCount).toBe(1) // Same response as first
    expect(second.headers['x-idempotent-replay']).toBe('true')
    expect(getCallCount()).toBe(1) // Handler was NOT called again
  })

  it('allows different keys through independently', async () => {
    const { app, getCallCount } = buildApp(store)

    await supertest(app)
      .post('/test')
      .set('idempotency-key', '123e4567-e89b-12d3-a456-426614174002')
      .send({})

    await supertest(app)
      .post('/test')
      .set('idempotency-key', '123e4567-e89b-12d3-a456-426614174003')
      .send({})

    expect(getCallCount()).toBe(2)
  })
})

describe('LRUIdempotencyStore', () => {
  it('evicts entries after TTL', async () => {
    const store = new LRUIdempotencyStore(50) // 50ms TTL

    store.set('temp', { status: 200, body: {}, createdAt: Date.now() })
    expect(store.has('temp')).toBe(true)

    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 60))

    expect(store.has('temp')).toBe(false)
    expect(store.get('temp')).toBeUndefined()

    store.stop()
  })

  it('tracks size correctly', () => {
    const store = new LRUIdempotencyStore(60_000)

    store.set('a', { status: 200, body: {}, createdAt: Date.now() })
    store.set('b', { status: 200, body: {}, createdAt: Date.now() })

    expect(store.size).toBe(2)
    store.stop()
  })
})
