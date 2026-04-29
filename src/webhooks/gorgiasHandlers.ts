import type { Request, Response } from "express";
import { logger } from "../lib/logger";
import { enqueueTicketClassifier } from "../jobs/ticketClassifier";
import { emitEvent } from "../jobs/eventBus";

// ── Gorgias payload shapes ────────────────────────────────────────────────────

interface GorgiasMessage { body_text?: string; }
interface GorgiasCustomer { email: string; }

interface GorgiasTicketPayload {
  id: number;
  subject?: string;
  messages?: GorgiasMessage[];
  customer?: GorgiasCustomer;
}

interface GorgiasReviewPayload {
  score: number;
  ticket?: { id: number };
  customer?: GorgiasCustomer;
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function handleTicketCreated(req: Request, res: Response): Promise<void> {
  const payload = req.body as GorgiasTicketPayload;

  await enqueueTicketClassifier({
    gorgiasTicketId: payload.id,
    subject:         payload.subject ?? "",
    body:            payload.messages?.[0]?.body_text ?? "",
    customerEmail:   payload.customer?.email ?? null,
  });

  logger.info("gorgias ticket queued for classification", { gorgiasTicketId: payload.id });
  res.status(200).json({ ok: true });
}

export async function handleReviewCreated(req: Request, res: Response): Promise<void> {
  const payload = req.body as GorgiasReviewPayload;

  if (payload.score <= 2) {
    await emitEvent({
      type:            "review.negative",
      score:           payload.score,
      gorgiasTicketId: payload.ticket?.id ?? 0,
      customerEmail:   payload.customer?.email ?? "",
    });
    logger.info("negative review event emitted", { score: payload.score });
  }

  res.status(200).json({ ok: true });
}
