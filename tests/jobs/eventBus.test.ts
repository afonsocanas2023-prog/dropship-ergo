import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'
import type { AppEvent } from '../../src/jobs/eventBus'

// ── Hoisted stubs ─────────────────────────────────────────────────────────────

const mockWorkerOn    = vi.hoisted(() => vi.fn())
const mockExistingJob = vi.hoisted(() => ({ remove: vi.fn().mockResolvedValue(undefined) }))

const mockQueueInstance = vi.hoisted(() => ({
  add:    vi.fn().mockResolvedValue(undefined),
  getJob: vi.fn().mockResolvedValue(null),
}))

const mockPrisma = vi.hoisted(() => ({
  revenueLog: { create: vi.fn().mockResolvedValue({}) },
}))

const mockKlaviyo = vi.hoisted(() => ({
  triggerPostPurchaseFlow:  vi.fn().mockResolvedValue(undefined),
  triggerAbandonedCartFlow: vi.fn().mockResolvedValue(undefined),
}))

const mockSlack = vi.hoisted(() => ({
  sendAlert:      vi.fn().mockResolvedValue(undefined),
  sendStockAlert: vi.fn().mockResolvedValue(undefined),
}))

const mockGorgias = vi.hoisted(() => ({
  createReply: vi.fn().mockResolvedValue(undefined),
}))

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('bullmq', () => ({
  Worker: vi.fn(() => ({ on: mockWorkerOn })),
  Queue:  vi.fn(() => mockQueueInstance),
}))

vi.mock('../../src/lib/queue', () => ({
  QUEUE_NAMES: {
    ORDER_ROUTER:      'order-router',
    INVENTORY_SYNC:    'inventory-sync',
    TICKET_CLASSIFIER: 'ticket-classifier',
    EVENT_BUS:         'event-bus',
  },
  makeQueue: vi.fn(() => mockQueueInstance),
  redis: {},
}))

vi.mock('../../src/lib/db',     () => ({ prisma: mockPrisma }))
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

vi.mock('../../src/services/klaviyo', () => mockKlaviyo)
vi.mock('../../src/services/slack',   () => mockSlack)
vi.mock('../../src/services/gorgias', () => mockGorgias)

// ── Imports ───────────────────────────────────────────────────────────────────

import { Worker } from 'bullmq'
import { emitEvent, emitEventDelayed, createEventBusWorker } from '../../src/jobs/eventBus'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJob(data: AppEvent): Job<AppEvent> {
  return { data } as unknown as Job<AppEvent>
}

function captureProcessor(): (job: Job<AppEvent>) => Promise<void> {
  vi.mocked(Worker).mockClear()
  createEventBusWorker()
  return vi.mocked(Worker).mock.calls[0]![1] as unknown as (job: Job<AppEvent>) => Promise<void>
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('emitEvent', () => {
  it('adds the event to the queue using the event type as the job name', async () => {
    const event: AppEvent = {
      type: 'order.paid', orderId: 'ord-1', shopifyOrderId: 'shop_1',
      totalPrice: 99.99, currency: 'USD', customerId: 'c1',
    }
    await emitEvent(event)
    expect(mockQueueInstance.add).toHaveBeenCalledWith('order.paid', event)
  })
})

describe('emitEventDelayed', () => {
  beforeEach(() => {
    mockQueueInstance.add.mockReset().mockResolvedValue(undefined)
    mockQueueInstance.getJob.mockReset().mockResolvedValue(null)
    mockExistingJob.remove.mockReset().mockResolvedValue(undefined)
  })

  it('happy path — no existing job, schedules a delayed job with the dedupeKey as jobId', async () => {
    const event: AppEvent = { type: 'cart.abandoned', cartToken: 'tok_abc', customerEmail: 'user@shop.com' }
    await emitEventDelayed(event, 3_600_000, 'cart-tok_abc')

    expect(mockQueueInstance.getJob).toHaveBeenCalledWith('cart-tok_abc')
    expect(mockQueueInstance.add).toHaveBeenCalledWith(
      'cart.abandoned', event, { delay: 3_600_000, jobId: 'cart-tok_abc' },
    )
  })

  it('existing job found — removes it first to reset the 1-hour debounce timer', async () => {
    mockQueueInstance.getJob.mockResolvedValue(mockExistingJob)
    const event: AppEvent = { type: 'cart.abandoned', cartToken: 'tok_xyz', customerEmail: 'other@shop.com' }
    await emitEventDelayed(event, 3_600_000, 'cart-tok_xyz')

    expect(mockExistingJob.remove).toHaveBeenCalled()
    expect(mockQueueInstance.add).toHaveBeenCalledWith(
      'cart.abandoned', event, { delay: 3_600_000, jobId: 'cart-tok_xyz' },
    )
  })
})

describe('event bus handler (internal handle())', () => {
  let processor: (job: Job<AppEvent>) => Promise<void>

  beforeEach(() => {
    processor = captureProcessor()
    mockPrisma.revenueLog.create.mockResolvedValue({})
    mockKlaviyo.triggerPostPurchaseFlow.mockResolvedValue(undefined)
    mockKlaviyo.triggerAbandonedCartFlow.mockResolvedValue(undefined)
    mockSlack.sendAlert.mockResolvedValue(undefined)
    mockSlack.sendStockAlert.mockResolvedValue(undefined)
    mockGorgias.createReply.mockResolvedValue(undefined)
  })

  it('order.paid — creates a revenue log entry with the correct fields', async () => {
    const event: AppEvent = {
      type: 'order.paid', orderId: 'ord-2', shopifyOrderId: 'shop_2',
      totalPrice: 249.95, currency: 'USD', customerId: 'c2',
    }
    await processor(makeJob(event))

    expect(mockPrisma.revenueLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: 'ord-2', totalPrice: 249.95, currency: 'USD' }),
      }),
    )
    expect(mockKlaviyo.triggerPostPurchaseFlow).not.toHaveBeenCalled()
  })

  it('order.fulfilled — triggers Klaviyo post-purchase sequence for the customer', async () => {
    const event: AppEvent = {
      type: 'order.fulfilled', orderId: 'ord-3', customerId: 'c3', customerEmail: 'happy@shop.com',
    }
    await processor(makeJob(event))

    expect(mockKlaviyo.triggerPostPurchaseFlow).toHaveBeenCalledWith('happy@shop.com', 'ord-3')
    expect(mockPrisma.revenueLog.create).not.toHaveBeenCalled()
  })

  it('review.negative — sends urgent Slack alert and creates a Gorgias draft reply', async () => {
    const event: AppEvent = {
      type: 'review.negative', score: 1, gorgiasTicketId: 88, customerEmail: 'upset@shop.com',
    }
    await processor(makeJob(event))

    expect(mockSlack.sendAlert).toHaveBeenCalledWith(
      expect.stringContaining('Negative review'),
      expect.objectContaining({ urgent: true }),
    )
    expect(mockGorgias.createReply).toHaveBeenCalledWith(88, expect.any(String))
  })
})
