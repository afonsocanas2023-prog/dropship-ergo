import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// ── Hoisted stubs ─────────────────────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  revenueLog: {
    findMany: vi.fn(),
  },
  supportTicket: {
    groupBy: vi.fn(),
    count:   vi.fn(),
  },
  stockCache: { findMany: vi.fn() },
  stockEvent: { findMany: vi.fn() },
}))

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/lib/db',     () => ({ prisma: mockPrisma }))
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// env.ts loads fine — REPORTS_API_KEY = 'reports-key' from tests/setup.ts

// ── App under test ────────────────────────────────────────────────────────────

import { reportsRouter } from '../../src/webhooks/reports'

const app = express()
app.use(express.json())
app.use('/reports', reportsRouter)

const request = supertest(app)
const AUTH    = { Authorization: 'Bearer reports-key' } // matches process.env.REPORTS_API_KEY

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /reports/revenue', () => {
  beforeEach(() => {
    mockPrisma.revenueLog.findMany.mockReset()
  })

  it('happy path — returns GMV, order count and AOV for the requested window', async () => {
    mockPrisma.revenueLog.findMany.mockResolvedValue([
      { totalPrice: '100.00' },
      { totalPrice: '50.00' },
      { totalPrice: '75.00' },
    ])

    const res = await request.get('/reports/revenue').set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      gmv:        '225.00',
      orderCount: 3,
      aov:        '75.00',
    })
  })

  it('no Authorization header — responds 401', async () => {
    const res = await request.get('/reports/revenue')
    expect(res.status).toBe(401)
  })

  it('wrong Bearer token — responds 403', async () => {
    const res = await request.get('/reports/revenue').set('Authorization', 'Bearer wrong-token')
    expect(res.status).toBe(403)
  })
})

describe('GET /reports/tickets', () => {
  beforeEach(() => {
    mockPrisma.supportTicket.groupBy.mockReset()
    mockPrisma.supportTicket.count.mockReset()
  })

  it('happy path — returns volume by category and correct auto-resolution rate', async () => {
    mockPrisma.supportTicket.groupBy.mockResolvedValue([
      { category: 'WHERE_IS_ORDER', _count: { id: 5 } },
      { category: 'RETURN_REQUEST', _count: { id: 2 } },
    ])
    mockPrisma.supportTicket.count
      .mockResolvedValueOnce(7)  // total
      .mockResolvedValueOnce(3)  // autoClosed (rate = 3/7 ≈ 0.4286)

    const res = await request.get('/reports/tickets').set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(7)
    expect(res.body.autoResolutionRate).toBe(0.4286)
    expect(res.body.byCategory).toEqual([
      { category: 'WHERE_IS_ORDER', count: 5 },
      { category: 'RETURN_REQUEST', count: 2 },
    ])
  })

  it('no tickets yet — returns zero rate without dividing by zero', async () => {
    mockPrisma.supportTicket.groupBy.mockResolvedValue([])
    mockPrisma.supportTicket.count
      .mockResolvedValueOnce(0)  // total
      .mockResolvedValueOnce(0)  // autoClosed

    const res = await request.get('/reports/tickets').set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body.total).toBe(0)
    expect(res.body.autoResolutionRate).toBe(0)
  })
})

describe('GET /reports/stock', () => {
  beforeEach(() => {
    mockPrisma.stockCache.findMany.mockReset()
    mockPrisma.stockEvent.findMany.mockReset()
  })

  it('happy path — returns current stock levels and recent stock events', async () => {
    mockPrisma.stockCache.findMany.mockResolvedValue([
      { supplierSku: 'CJ-SKU-001', stockLevel: 3, supplier: { code: 'CJ', name: 'CJ Dropshipping' } },
    ])
    mockPrisma.stockEvent.findMany.mockResolvedValue([
      { id: 'ev-1', action: 'PRODUCT_HIDDEN', newStock: 0, supplier: { code: 'CJ' } },
    ])

    const res = await request.get('/reports/stock').set(AUTH)

    expect(res.status).toBe(200)
    expect(res.body.stockLevels).toHaveLength(1)
    expect(res.body.stockLevels[0]).toMatchObject({ supplierSku: 'CJ-SKU-001', stockLevel: 3 })
    expect(res.body.recentEvents).toHaveLength(1)
    expect(res.body.recentEvents[0]).toMatchObject({ action: 'PRODUCT_HIDDEN' })
  })
})
