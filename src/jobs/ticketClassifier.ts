import { Worker, type Job } from "bullmq";
import { DisputeStatus, OrderStatus, TicketStatus } from "@prisma/client";
import { redis, QUEUE_NAMES, makeQueue } from "../lib/queue";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import * as gorgias from "../services/gorgias";
import * as shopify from "../services/shopify";
import { classify } from "./classify";

// ── Job data ──────────────────────────────────────────────────────────────────

export interface TicketClassifierJobData {
  gorgiasTicketId: number;
  subject: string;
  body: string;
  customerEmail: string | null;
}

// ── Gorgias IDs — set these to match your account ────────────────────────────
const MACRO = { TRACKING: 1, PROCESSING: 2, LOOP_RETURNS: 5 } as const;
const TEAM  = { AI_AGENT: 10, HUMAN: 20 } as const;

// ── Queue ─────────────────────────────────────────────────────────────────────

const classifierQueue = makeQueue<TicketClassifierJobData>(QUEUE_NAMES.TICKET_CLASSIFIER);

export async function enqueueTicketClassifier(data: TicketClassifierJobData): Promise<void> {
  await classifierQueue.add("classify-ticket", data);
}

// ── Category handlers ─────────────────────────────────────────────────────────

async function handleWhereIsOrder(ticketId: number): Promise<void> {
  await gorgias.applyMacro(ticketId, MACRO.TRACKING);
  await gorgias.closeTicket(ticketId);
}

async function handleCancellation(ticketId: number, email: string | null): Promise<void> {
  if (!email) { await gorgias.escalateToHuman(ticketId, TEAM.HUMAN); return; }

  const order = await prisma.order.findFirst({
    where: { customer: { email } },
    orderBy: { createdAt: "desc" },
  });

  if (order && order.status !== OrderStatus.ROUTED_TO_SUPPLIER) {
    await shopify.cancelOrder(order.shopifyOrderId, "customer_requested");
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
    await gorgias.applyMacro(ticketId, MACRO.TRACKING); // confirmation macro
    await gorgias.closeTicket(ticketId);
  } else {
    await gorgias.applyMacro(ticketId, MACRO.PROCESSING);
    await gorgias.escalateToHuman(ticketId, TEAM.HUMAN);
  }
}

async function handleDamageClaim(ticketId: number, email: string | null, body: string, dbTicketId: string): Promise<void> {
  if (email) {
    const order = await prisma.order.findFirst({
      where: { customer: { email } },
      include: { orderItems: { take: 1 } },
      orderBy: { createdAt: "desc" },
    });
    const item = order?.orderItems[0];
    if (order && item) {
      const mapping = await prisma.skuSupplierMap.findUnique({ where: { shopifyVariantId: item.shopifyVariantId } });
      if (mapping) {
        await prisma.supplierDispute.create({
          data: {
            supportTicketId: dbTicketId,
            supplierId:      mapping.primarySupplierId,
            orderId:         order.id,
            orderItemId:     item.id,
            status:          DisputeStatus.OPEN,
            description:     body.slice(0, 1000),
          },
        });
      }
    }
  }
  await gorgias.escalateToHuman(ticketId, TEAM.HUMAN);
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function classifyAndHandle(job: Job<TicketClassifierJobData>): Promise<void> {
  const { gorgiasTicketId, subject, body, customerEmail } = job.data;
  const gorgiasIdStr = String(gorgiasTicketId);

  const { category, method } = await classify(subject, body);
  logger.info("ticket classified", { gorgiasTicketId, category, method });

  const ticket = await prisma.supportTicket.upsert({
    where:  { gorgiasTicketId: gorgiasIdStr },
    update: { category, classificationMethod: method },
    create: { gorgiasTicketId: gorgiasIdStr, category, classificationMethod: method, status: TicketStatus.OPEN },
  });

  switch (category) {
    case "WHERE_IS_ORDER":
      await handleWhereIsOrder(gorgiasTicketId);
      await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: TicketStatus.AUTO_CLOSED } });
      break;
    case "CANCELLATION":
      await handleCancellation(gorgiasTicketId, customerEmail);
      break;
    case "PRODUCT_QUESTION":
      await gorgias.addTags(gorgiasTicketId, ["NEEDS_FAQ_RESPONSE"]);
      await gorgias.assignToTeam(gorgiasTicketId, TEAM.AI_AGENT);
      break;
    case "DAMAGE_CLAIM":
      await handleDamageClaim(gorgiasTicketId, customerEmail, body, ticket.id);
      break;
    case "RETURN_REQUEST":
      await gorgias.applyMacro(gorgiasTicketId, MACRO.LOOP_RETURNS);
      await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: TicketStatus.CLOSED } });
      break;
    default: // UNKNOWN
      await gorgias.addTags(gorgiasTicketId, ["NEEDS_HUMAN"]);
      await gorgias.escalateToHuman(gorgiasTicketId, TEAM.HUMAN);
      await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: TicketStatus.ESCALATED } });
  }
}

// ── Worker factory ────────────────────────────────────────────────────────────

export function createTicketClassifierWorker(): Worker<TicketClassifierJobData> {
  const worker = new Worker<TicketClassifierJobData>(
    QUEUE_NAMES.TICKET_CLASSIFIER,
    classifyAndHandle,
    { connection: redis },
  );

  worker.on("failed", (job, err) => {
    logger.error("ticket classifier job failed", { jobId: job?.id, gorgiasTicketId: job?.data?.gorgiasTicketId, error: err.message });
  });

  return worker;
}
