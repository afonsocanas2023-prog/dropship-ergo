import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import type { Response, NextFunction } from 'express'
import type { RawBodyRequest } from '../../src/webhooks/shopifyHmac'

// shopifyHmac only imports env and logger — no Redis/Prisma needed.
vi.mock('../../src/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))

// env.ts uses process.env populated by tests/setup.ts; SHOPIFY_WEBHOOK_SECRET = 'whsec_test'
import { shopifyHmac } from '../../src/webhooks/shopifyHmac'

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECRET  = 'whsec_test'                                             // matches setup.ts
const BODY    = Buffer.from(JSON.stringify({ id: 42, total_price: '99.00' }))
const DIGEST  = createHmac('sha256', SECRET).update(BODY).digest('base64')

function makeReq(overrides: Partial<{
  headers: Record<string, string>
  rawBody: Buffer | undefined
}> = {}): RawBodyRequest {
  const defaultHeaders = 'headers' in overrides
    ? overrides.headers
    : { 'x-shopify-hmac-sha256': DIGEST }
  return {
    headers: defaultHeaders,
    rawBody: 'rawBody' in overrides ? overrides.rawBody : BODY,
    path: '/webhooks/shopify/orders-paid',
  } as unknown as RawBodyRequest
}
function makeRes() {
  const json   = vi.fn().mockReturnThis()
  const status = vi.fn().mockReturnValue({ json })
  return { status, json } as unknown as Response & { status: ReturnType<typeof vi.fn> }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('shopifyHmac middleware', () => {
  it('happy path — valid HMAC passes through to next()', () => {
    const res  = makeRes()
    const next = vi.fn() as unknown as NextFunction

    shopifyHmac(makeReq(), res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('missing X-Shopify-Hmac-Sha256 header — responds 401 without calling next()', () => {
    const res  = makeRes()
    const next = vi.fn() as unknown as NextFunction

    shopifyHmac(makeReq({ headers: {} }), res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('tampered HMAC value — responds 401 without calling next()', () => {
    const res  = makeRes()
    const next = vi.fn() as unknown as NextFunction
    const req  = makeReq({ headers: { 'x-shopify-hmac-sha256': 'aW52YWxpZA==' } }) // "invalid" in base64

    shopifyHmac(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rawBody is missing — responds 400 without calling next()', () => {
    const res  = makeRes()
    const next = vi.fn() as unknown as NextFunction

    shopifyHmac(makeReq({ rawBody: undefined }), res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(next).not.toHaveBeenCalled()
  })
})
