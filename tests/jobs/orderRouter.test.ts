import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'
import type { OrderRouterJobData } from '../../src/jobs/orderRouter'

// ── Hoisted stubs ─────────────────────────────────────────────────────────────

const mockWorkerOn    = vi.hoisted(() => vi.fn())
const mockQueueAdd    = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

const mockPrisma = vi.hoisted(() => ({
  order: {
    findUnique: vi.fn(),
    update:     vi.fn().mockResolvedValue({}),
  },
  orderItem: {
    update: vi.fn().mockResolvedValue({}),
  },
  skuSupplierMap: {
    findUnique: vi.fn(),
  },
}))

const mockGetStockLevel  = vi.hoisted(() => vi.fn())
const mockSubmitViaDsers = vi.hoisted(() => vi.fn())
const mockSendOrderAlert = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockEmitEvent      = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

// ── Module mocks (hoisted by Vitest) ─────────────────────────────────────────

vi.mock('bullmq', () => ({
  Worker: vi.fn(() => ({ on: mockWorkerOn })),
  Queue:  vi.fn(() => ({ add: mockQueueAdd })),
}))

vi.mock('../../src/lib/queue', () => ({
  QUEUE_NAMES: {
    ORDER_ROUTER:       'order-router',
    INVENTORY_SYNC:     'inventory-sync',
    TICKET_CLASSIFIER:  'ticket-classifier',
    EVENT_BUS:          'event-bus',
  },
  makeQueue: vi.fn(() => ({ add: mockQueueAdd })),
  redis: {},
}))

vi.mock('../../src/lib/db',     () => ({ prisma: mockPrisma }))
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

vi.mock('../../src/services/supplier', () => ({ getStockLevel:      mockGetStockLevel }))
vi.mock('../../src/services/dsers',    () => ({ submitOrderViaDsers: mockSubmitViaDsers }))
vi.mock('../../src/services/slack',    () => ({ sendOrderAlert:      mockSendOrderAlert }))
vi.mock('../../src/jobs/eventBus',     () => ({ emitEvent:           mockEmitEvent }))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { Worker } from 'bullmq'
import { enqueueOrderRouter, createOrderRouterWorker } from '../../src/jobs/orderRouter'

// ── Shared fixtures ───────────────────────────────────────────────────────────

const SHIPPING_ADDRESS = {
  firstName: 'Jane', lastName: 'Doe', address1: '1 Ergo Ave',
  city: 'Portland', province: 'OR', country: 'US', zip: '97201',
}

const FAKE_ORDER = {
  id: 'order-db-1',
  shopifyOrderId: 'shop_111',
  totalPrice: 149.99,
  currency: 'USD',
  customerId: 'cust-1',
  status: 'PENDING',
  customer: null,
  orderItems: [
    { id: 'item-1', shopifyVariantId: 'var-1', quantity: 1, price: '149.99' },
  ],
}

const FAKE_MAPPING = {
  primarySupplier:    { id: 'sup-1', code: 'CJ' },
  primarySupplierSku: 'CJ-SKU-001',
  backupSupplier:     { id: 'sup-2', code: 'AUTODS' },
  backupSupplierSku:  'AD-SKU-001',
}

function makeJob(data: OrderRouterJobData): Job<OrderRouterJobData> {
  return { data } as unknown as Job<OrderRouterJobData>
}

function captureProcessor(): (job: Job<OrderRouterJobData>) => Promise<void> {
  vi.mocked(Worker).mockClear()
  createOrderRouterWorker()
  // Second argument to the Worker constructor is the processor function
  return vi.mocked(Worker).mock.calls[0]![1] as unknown as (job: Job<OrderRouterJobData>) => Promise<void>
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('enqueueOrderRouter', () => {
  it('adds a route-order job with the supplied payload', async () => {
    const data: OrderRouterJobData = { shopifyOrderId: 'shop_1', shippingAddress: SHIPPING_ADDRESS }
    await enqueueOrderRouter(data)
    expect(mockQueueAdd).toHaveBeenCalledWith('route-order', data)
  })
})

describe('routeOrder processor', () => {
  let processor: (job: Job<OrderRouterJobData>) => Promise<void>

  beforeEach(() => {
    processor = captureProcessor()
    // Reset per-test mocks to avoid bleed between tests
    mockPrisma.order.findUnique.mockReset()
    mockPrisma.skuSupplierMap.findUnique.mockReset()
    mockGetStockLevel.mockReset()
    mockSubmitViaDsers.mockReset()
    mockPrisma.order.update.mockResolvedValue({})
    mockPrisma.orderItem.update.mockResolvedValue({})
    mockSendOrderAlert.mockResolvedValue(undefined)
    mockEmitEvent.mockResolvedValue(undefined)
  })

  it('happy path — primary stock available, routes via DSers and emits order.paid', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(FAKE_ORDER)
    mockPrisma.skuSupplierMap.findUnique.mockResolvedValue(FAKE_MAPPING)
    mockGetStockLevel.mockResolvedValue({ ok: true, value: { quantity: 10 } })
    mockSubmitViaDsers.mockResolvedValue({ ok: true, value: { dsersOrderId: 'dsers-99' } })

    await processor(makeJob({ shopifyOrderId: 'shop_111', shippingAddress: SHIPPING_ADDRESS }))

    expect(mockPrisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ supplierSku: 'CJ-SKU-001', routedSupplierId: 'CJ' }),
      }),
    )
    expect(mockPrisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ROUTED_TO_SUPPLIER' } }),
    )
    expect(mockEmitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'order.paid', shopifyOrderId: 'shop_111' }),
    )
    expect(mockSendOrderAlert).not.toHaveBeenCalled()
  })

  it('all suppliers out of stock — marks NEEDS_MANUAL_REVIEW and fires Slack alert', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(FAKE_ORDER)
    mockPrisma.skuSupplierMap.findUnique.mockResolvedValue(FAKE_MAPPING)
    // Both primary and backup return zero stock
    mockGetStockLevel.mockResolvedValue({ ok: true, value: { quantity: 0 } })

    await processor(makeJob({ shopifyOrderId: 'shop_111', shippingAddress: SHIPPING_ADDRESS }))

    expect(mockPrisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'NEEDS_MANUAL_REVIEW' } }),
    )
    expect(mockSendOrderAlert).toHaveBeenCalledWith(
      expect.stringContaining('manual review'),
      'shop_111',
    )
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('DSers submission fails — marks NEEDS_MANUAL_REVIEW and fires Slack alert', async () => {
    mockPrisma.order.findUnique.mockResolvedValue(FAKE_ORDER)
    mockPrisma.skuSupplierMap.findUnique.mockResolvedValue(FAKE_MAPPING)
    mockGetStockLevel.mockResolvedValue({ ok: true, value: { quantity: 5 } })
    mockSubmitViaDsers.mockResolvedValue({ ok: false, error: new Error('DSers API timeout') })

    await processor(makeJob({ shopifyOrderId: 'shop_111', shippingAddress: SHIPPING_ADDRESS }))

    expect(mockPrisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'NEEDS_MANUAL_REVIEW' } }),
    )
    expect(mockSendOrderAlert).toHaveBeenCalled()
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })
})
