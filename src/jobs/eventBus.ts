import { Worker, type Job } from "bullmq";
import { redis, QUEUE_NAMES, makeQueue } from "../lib/queue";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import * as klaviyo from "../services/klaviyo";
import * as slack from "../services/slack";
import * as gorgias from "../services/gorgias";

// ── Event union ───────────────────────────────────────────────────────────────

export type AppEvent =
  | { type: "order.paid";         orderId: string; shopifyOrderId: string; totalPrice: number; currency: string; customerId: string | null }
  | { type: "order.fulfilled";    orderId: string; customerId: string; customerEmail: string }
  | { type: "review.negative";    score: number; gorgiasTicketId: number; customerEmail: string }
  | { type: "supplier.stock_low"; supplierCode: string; supplierSku: string; quantity: number }
  | { type: "cart.abandoned";     cartToken: string; customerEmail: string };

// ── Queue ─────────────────────────────────────────────────────────────────────

const eventQueue = makeQueue<AppEvent>(QUEUE_NAMES.EVENT_BUS);

export async function emitEvent(event: AppEvent): Promise<void> {
  await eventQueue.add(event.type, event);
  logger.info("event emitted", { type: event.type });
}

/**
 * Schedule a delayed event. If a job with the same dedupeKey already exists
 * it is removed first, resetting the timer — this is the debounce mechanism
 * used for cart.abandoned (1 hr window).
 */
export async function emitEventDelayed(
  event: AppEvent,
  delayMs: number,
  dedupeKey: string,
): Promise<void> {
  const existing = await eventQueue.getJob(dedupeKey);
  if (existing) {
    try { await existing.remove(); } catch { /* already processing, ignore */ }
  }
  await eventQueue.add(event.type, event, { delay: delayMs, jobId: dedupeKey });
  logger.info("delayed event scheduled", { type: event.type, delayMs, dedupeKey });
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handle(event: AppEvent): Promise<void> {
  switch (event.type) {
    case "order.paid":
      await prisma.revenueLog.create({
        data: {
          orderId:        event.orderId,
          shopifyOrderId: event.shopifyOrderId,
          customerId:     event.customerId,
          totalPrice:     event.totalPrice,
          currency:       event.currency,
        },
      });
      return;

    case "order.fulfilled":
      await klaviyo.triggerPostPurchaseFlow(event.customerEmail, event.orderId);
      return;

    case "review.negative":
      await Promise.all([
        slack.sendAlert(
          `:star: Negative review (score ${event.score}/5) from ${event.customerEmail}`,
          { urgent: true },
        ),
        gorgias.createReply(
          event.gorgiasTicketId,
          "We're very sorry about your experience. A team member will follow up shortly to make this right.",
        ),
      ]);
      return;

    case "supplier.stock_low":
      await slack.sendStockAlert(event.supplierSku, event.supplierCode, event.quantity);
      return;

    case "cart.abandoned":
      await klaviyo.triggerAbandonedCartFlow(event.customerEmail, event.cartToken);
      return;
  }
}

// ── Worker factory ────────────────────────────────────────────────────────────

export function createEventBusWorker(): Worker<AppEvent> {
  const worker = new Worker<AppEvent>(
    QUEUE_NAMES.EVENT_BUS,
    async (job: Job<AppEvent>) => handle(job.data),
    { connection: redis },
  );

  worker.on("failed", (job, err) => {
    logger.error("event bus job failed", {
      jobId: job?.id,
      type: job?.data?.type,
      error: err.message,
    });
  });

  return worker;
}
