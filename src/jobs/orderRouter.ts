import { Worker, type Job } from "bullmq";
import { OrderStatus } from "@prisma/client";
import { redis, QUEUE_NAMES, makeQueue } from "../lib/queue";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { getStockLevel } from "../services/supplier";
import { submitOrderViaDsers } from "../services/dsers";
import { sendOrderAlert } from "../services/slack";
import { emitEvent } from "./eventBus";
import type { ShippingAddress, SupplierOrderPayload } from "../types";

// ── Job data ──────────────────────────────────────────────────────────────────

export interface OrderRouterJobData {
  shopifyOrderId: string;
  shippingAddress: ShippingAddress;
}

// ── Queue ─────────────────────────────────────────────────────────────────────

const orderRouterQueue = makeQueue<OrderRouterJobData>(QUEUE_NAMES.ORDER_ROUTER);

export async function enqueueOrderRouter(data: OrderRouterJobData): Promise<void> {
  await orderRouterQueue.add("route-order", data);
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function routeOrder(job: Job<OrderRouterJobData>): Promise<void> {
  const { shopifyOrderId, shippingAddress } = job.data;

  const order = await prisma.order.findUnique({
    where: { shopifyOrderId },
    include: { orderItems: true, customer: true },
  });

  if (!order) throw new Error(`Order not found in DB: ${shopifyOrderId}`);

  let allRouted = true;

  for (const item of order.orderItems) {
    const mapping = await prisma.skuSupplierMap.findUnique({
      where: { shopifyVariantId: item.shopifyVariantId },
      include: { primarySupplier: true, backupSupplier: true },
    });

    if (!mapping) {
      logger.warn("no SKU mapping for line item", { variantId: item.shopifyVariantId });
      allRouted = false;
      continue;
    }

    // Try primary supplier
    const primaryStock = await getStockLevel(mapping.primarySupplier.code, mapping.primarySupplierSku);
    const usePrimary = primaryStock.ok && primaryStock.value.quantity > 0;

    let chosenCode: string | null = usePrimary ? mapping.primarySupplier.code : null;
    let chosenSku:  string | null = usePrimary ? mapping.primarySupplierSku   : null;

    // Fall back to backup supplier
    if (!usePrimary && mapping.backupSupplier && mapping.backupSupplierSku) {
      const backupStock = await getStockLevel(mapping.backupSupplier.code, mapping.backupSupplierSku);
      if (backupStock.ok && backupStock.value.quantity > 0) {
        chosenCode = mapping.backupSupplier.code;
        chosenSku  = mapping.backupSupplierSku;
      }
    }

    if (!chosenSku || !chosenCode) {
      logger.warn("all suppliers out of stock", { variantId: item.shopifyVariantId });
      allRouted = false;
      continue;
    }

    const payload: SupplierOrderPayload = {
      shopifyOrderId,
      shippingAddress,
      lineItems: [{ supplierSku: chosenSku, quantity: item.quantity, unitPrice: Number(item.price) }],
    };

    const submitResult = await submitOrderViaDsers(payload);
    if (!submitResult.ok) {
      logger.error("DSers submission failed", { error: submitResult.error.message, itemId: item.id });
      allRouted = false;
      continue;
    }

    await prisma.orderItem.update({
      where: { id: item.id },
      data: { supplierSku: chosenSku, routedSupplierId: chosenCode, routedAt: new Date() },
    });
  }

  if (!allRouted) {
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.NEEDS_MANUAL_REVIEW } });
    await sendOrderAlert(":warning: Order needs manual review — items out of stock or routing failed", shopifyOrderId);
    return;
  }

  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.ROUTED_TO_SUPPLIER } });

  await emitEvent({
    type:           "order.paid",
    orderId:        order.id,
    shopifyOrderId,
    totalPrice:     Number(order.totalPrice),
    currency:       order.currency,
    customerId:     order.customerId,
  });
}

// ── Worker factory ────────────────────────────────────────────────────────────

export function createOrderRouterWorker(): Worker<OrderRouterJobData> {
  const worker = new Worker<OrderRouterJobData>(
    QUEUE_NAMES.ORDER_ROUTER,
    routeOrder,
    { connection: redis },
  );

  worker.on("failed", (job, err) => {
    logger.error("order router job failed", { jobId: job?.id, shopifyOrderId: job?.data?.shopifyOrderId, error: err.message });
  });

  return worker;
}
