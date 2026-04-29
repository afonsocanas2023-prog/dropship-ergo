import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'
import type { TicketClassifierJobData } from '../../src/jobs/ticketClassifier'

// ── Hoisted stubs ─────────────────────────────────────────────────────────────

const mockWorkerOn = vi.hoisted(() => vi.fn())

const mockPrisma = vi.hoisted(() => ({
  supportTicket: {
    upsert:  vi.fn(),
    update:  vi.fn().mockResolvedValue({}),
  },
  order: {
    findFirst: vi.fn(),
    update:    vi.fn().mockResolvedValue({}),
  },
  skuSupplierMap: { findUnique: vi.fn() },
  supplierDispute: { create: vi.fn().mockResolvedValue({}) },
}))

const mockClassify = vi.hoisted(() => vi.fn())

const mockGorgias = vi.hoisted(() => ({
  applyMacro:      vi.fn().mockResolvedValue(undefined),
  closeTicket:     vi.fn().mockResolvedValue(undefined),
  escalateToHuman: vi.fn().mockResolvedValue(undefined),
  addTags:         vi.fn().mockResolvedValue(undefined),
  assignToTeam:    vi.fn().mockResolvedValue(undefined),
  createReply:     vi.fn().mockResolvedValue(undefined),
}))

const mockShopify = vi.hoisted(() => ({
  cancelOrder: vi.fn().mockResolvedValue({}),
}))

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('bullmq', () => ({
  Worker: vi.fn(() => ({ on: mockWorkerOn })),
  Queue:  vi.fn(() => ({ add: vi.fn().mockResolvedValue(undefined) })),
}))

vi.mock('../../src/lib/queue', () => ({
  QUEUE_NAMES: {
    ORDER_ROUTER:      'order-router',
    INVENTORY_SYNC:    'inventory-sync',
    TICKET_CLASSIFIER: 'ticket-classifier',
    EVENT_BUS:         'event-bus',
  },
  makeQueue: vi.fn(() => ({ add: vi.fn().mockResolvedValue(undefined) })),
  redis: {},
}))

vi.mock('../../src/lib/db',     () => ({ prisma: mockPrisma }))
vi.mock('../../src/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

vi.mock('../../src/services/gorgias', () => mockGorgias)
vi.mock('../../src/services/shopify', () => mockShopify)
vi.mock('../../src/jobs/classify',    () => ({ classify: mockClassify }))

// ── Imports ───────────────────────────────────────────────────────────────────

import { Worker } from 'bullmq'
import { createTicketClassifierWorker } from '../../src/jobs/ticketClassifier'

// ── Constants mirrored from source ────────────────────────────────────────────

const MACRO = { TRACKING: 1, PROCESSING: 2, LOOP_RETURNS: 5 } as const
const TEAM  = { AI_AGENT: 10, HUMAN: 20 } as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJob(data: TicketClassifierJobData): Job<TicketClassifierJobData> {
  return { data } as unknown as Job<TicketClassifierJobData>
}

function captureProcessor(): (job: Job<TicketClassifierJobData>) => Promise<void> {
  vi.mocked(Worker).mockClear()
  createTicketClassifierWorker()
  return vi.mocked(Worker).mock.calls[0]![1] as unknown as (job: Job<TicketClassifierJobData>) => Promise<void>
}

const BASE_JOB: TicketClassifierJobData = {
  gorgiasTicketId: 777,
  subject:         'Where is my order?',
  body:            'I ordered 3 days ago and have no tracking.',
  customerEmail:   'buyer@example.com',
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ticketClassifier processor', () => {
  let processor: (job: Job<TicketClassifierJobData>) => Promise<void>

  beforeEach(() => {
    processor = captureProcessor()
    mockPrisma.supportTicket.upsert.mockReset()
    mockPrisma.order.findFirst.mockReset()
    mockClassify.mockReset()
    // Common default: upsert returns a DB ticket record
    mockPrisma.supportTicket.upsert.mockResolvedValue({ id: 'ticket-db-1' })
    mockPrisma.supportTicket.update.mockResolvedValue({})
    mockPrisma.order.update.mockResolvedValue({})
  })

  it('WHERE_IS_ORDER — applies tracking macro, auto-closes ticket in DB', async () => {
    mockClassify.mockResolvedValue({ category: 'WHERE_IS_ORDER', method: 'KEYWORD' })

    await processor(makeJob(BASE_JOB))

    expect(mockGorgias.applyMacro).toHaveBeenCalledWith(777, MACRO.TRACKING)
    expect(mockGorgias.closeTicket).toHaveBeenCalledWith(777)
    expect(mockPrisma.supportTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'AUTO_CLOSED' } }),
    )
    expect(mockGorgias.escalateToHuman).not.toHaveBeenCalled()
  })

  it('CANCELLATION when order is already ROUTED_TO_SUPPLIER — escalates without cancelling', async () => {
    mockClassify.mockResolvedValue({ category: 'CANCELLATION', method: 'KEYWORD' })
    mockPrisma.order.findFirst.mockResolvedValue({
      id:             'ord-1',
      shopifyOrderId: 'shop_999',
      status:         'ROUTED_TO_SUPPLIER',
    })

    await processor(makeJob(BASE_JOB))

    expect(mockShopify.cancelOrder).not.toHaveBeenCalled()
    expect(mockGorgias.applyMacro).toHaveBeenCalledWith(777, MACRO.PROCESSING)
    expect(mockGorgias.escalateToHuman).toHaveBeenCalledWith(777, TEAM.HUMAN)
  })

  it('UNKNOWN category — tags NEEDS_HUMAN, escalates to human queue, sets ESCALATED status', async () => {
    mockClassify.mockResolvedValue({ category: 'UNKNOWN', method: 'AI' })

    await processor(makeJob(BASE_JOB))

    expect(mockGorgias.addTags).toHaveBeenCalledWith(777, ['NEEDS_HUMAN'])
    expect(mockGorgias.escalateToHuman).toHaveBeenCalledWith(777, TEAM.HUMAN)
    expect(mockPrisma.supportTicket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'ESCALATED' } }),
    )
    expect(mockGorgias.closeTicket).not.toHaveBeenCalled()
  })
})
