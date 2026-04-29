import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted stubs ─────────────────────────────────────────────────────────────

const mockWorkerOn = vi.hoisted(() => vi.fn())
const mockQueueAdd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

const mockPrisma = vi.hoisted(() => ({
  skuSupplierMap: { findMany: vi.fn() },
  stockCache: {
    findUnique: vi.fn(),
    upsert:     vi.fn().mockResolvedValue({}),
  },
  stockEvent: { create: vi.fn().mockResolvedValue({}) },
}))

const mockGetAllStockLevels      = vi.hoisted(() => vi.fn())
const mockSetProductAvailability = vi.hoisted(() => vi.fn().mockResolvedValue({}))
const mockSendStockAlert         = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockEmitEvent              = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('bullmq', () => ({
  Worker: vi.fn(() => ({ on: mockWorkerOn })),
  Queue:  vi.fn(() => ({ add: mockQueueAdd })),
}))

vi.mock('../../src/lib/queue', () => ({
  QUEUE_NAMES: {
    ORDER_ROUTER:      'order-router',
    INVENTORY_SYNC:    'inventory-sync',
    TICKET_CLASSIFIER: 'ticket-classifier',
    EVENT_BUS:         'event-bus',
  },
  // Every makeQueue() call returns the same stub so module-level queues share mockQueueAdd
  makeQueue: vi.fn(() => ({ add: mockQueueAdd })),
  redis: {},
}))

vi.mock('../../src/lib/db',     () => ({ prisma: mockPrisma }))
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

vi.mock('../../src/services/supplier', () => ({ getAllStockLevels:      mockGetAllStockLevels }))
vi.mock('../../src/services/shopify',  () => ({ setProductAvailability: mockSetProductAvailability }))
vi.mock('../../src/services/slack',    () => ({ sendStockAlert:         mockSendStockAlert }))
vi.mock('../../src/jobs/eventBus',     () => ({ emitEvent:              mockEmitEvent }))

// ── Imports ───────────────────────────────────────────────────────────────────

import { Worker } from 'bullmq'
import { scheduleInventorySync, createInventorySyncWorker } from '../../src/jobs/inventorySync'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACTIVE_MAPPING = {
  isActive:           true,
  primarySupplierSku: 'CJ-SKU-001',
  shopifyProductId:   'shopify-prod-42',
  primarySupplier:    { id: 'sup-1', code: 'CJ' },
}

function captureProcessor(): () => Promise<void> {
  vi.mocked(Worker).mockClear()
  createInventorySyncWorker()
  // inventorySync passes `async () => runSync()` — no job arg used
  return vi.mocked(Worker).mock.calls[0]![1] as unknown as () => Promise<void>
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('scheduleInventorySync', () => {
  it('enqueues a repeating cron job on the inventory-sync queue', async () => {
    // mockQueueAdd is the .add of the module-level inventorySyncQueue because
    // makeQueue() always returns { add: mockQueueAdd }.
    // clearMocks:true resets call history before this test, so the assertion is clean.
    await scheduleInventorySync()
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'sync',
      {},
      expect.objectContaining({ jobId: 'inventory-sync-cron' }),
    )
  })
})

describe('inventorySync processor (runSync)', () => {
  let processor: () => Promise<void>

  beforeEach(() => {
    processor = captureProcessor()
    mockPrisma.skuSupplierMap.findMany.mockReset()
    mockPrisma.stockCache.findUnique.mockReset()
    mockGetAllStockLevels.mockReset()
    mockPrisma.stockCache.upsert.mockResolvedValue({})
    mockPrisma.stockEvent.create.mockResolvedValue({})
    mockSetProductAvailability.mockResolvedValue({})
    mockSendStockAlert.mockResolvedValue(undefined)
    mockEmitEvent.mockResolvedValue(undefined)
  })

  it('happy path — stock unchanged, no DB writes or Shopify calls made', async () => {
    mockPrisma.skuSupplierMap.findMany.mockResolvedValue([ACTIVE_MAPPING])
    mockGetAllStockLevels.mockResolvedValue({
      ok: true, value: [{ supplierSku: 'CJ-SKU-001', quantity: 20 }],
    })
    mockPrisma.stockCache.findUnique.mockResolvedValue({ stockLevel: 20 })

    await processor()

    expect(mockPrisma.stockCache.upsert).not.toHaveBeenCalled()
    expect(mockSetProductAvailability).not.toHaveBeenCalled()
    expect(mockSendStockAlert).not.toHaveBeenCalled()
  })

  it('stock drops to zero — hides product on Shopify, logs PRODUCT_HIDDEN event, sends Slack alert', async () => {
    mockPrisma.skuSupplierMap.findMany.mockResolvedValue([ACTIVE_MAPPING])
    mockGetAllStockLevels.mockResolvedValue({
      ok: true, value: [{ supplierSku: 'CJ-SKU-001', quantity: 0 }],
    })
    mockPrisma.stockCache.findUnique.mockResolvedValue({ stockLevel: 10 })

    await processor()

    expect(mockPrisma.stockCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ stockLevel: 0 }) }),
    )
    expect(mockPrisma.stockEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'PRODUCT_HIDDEN', newStock: 0, previousStock: 10 }),
      }),
    )
    expect(mockSetProductAvailability).toHaveBeenCalledWith('shopify-prod-42', false)
    expect(mockSendStockAlert).toHaveBeenCalledWith('CJ-SKU-001', 'CJ', 0)
    // stock_low event fires only on threshold crossing, not on drop-to-zero
    expect(mockEmitEvent).not.toHaveBeenCalled()
  })

  it('supplier stock API fails — logs error and does not throw or write to DB', async () => {
    mockPrisma.skuSupplierMap.findMany.mockResolvedValue([ACTIVE_MAPPING])
    mockGetAllStockLevels.mockResolvedValue({ ok: false, error: new Error('Supplier API 503') })

    await expect(processor()).resolves.toBeUndefined()
    expect(mockPrisma.stockCache.upsert).not.toHaveBeenCalled()
    expect(mockSetProductAvailability).not.toHaveBeenCalled()
  })
})
