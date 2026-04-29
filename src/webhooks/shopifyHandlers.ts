import type { Request, Response } from "express";
import { OrderStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { enqueueOrderRouter } from "../jobs/orderRouter";
import { emitEvent, emitEventDelayed } from "../jobs/eventBus";
import { sendOrderAlert } from "../services/slack";
import type { ShippingAddress } from "../types";

// ── Shopify payload shapes (minimal — only fields we consume) ─────────────────

interface ShopifyAddress {
  first_name: string; last_name: string; address1: string; address2?: string;
  city: string; province: string; country: string; zip: string; phone?: string;
}
interface ShopifyCustomer { id: number; email: string; first_name: string; last_name: string; }
interface ShopifyLineItem {
  id: number; variant_id: number; product_id: number;
  title: string; variant_title: string | null; quantity: number; price: string;
}
interface ShopifyFulfillment { tracking_number?: string; tracking_url?: string; }
interface ShopifyOrderPayload {
  id: number; total_price: string; currency: string;
  customer?: ShopifyCustomer; shipping_address?: ShopifyAddress;
  line_items: ShopifyLineItem[]; fulfillments?: ShopifyFulfillment[];
}
interface ShopifyCartPayload { token: string; email?: string; }

function toShippingAddress(a: ShopifyAddress): ShippingAddress {
  return {
    firstName: a.first_name, lastName: a.last_name,
    address1: a.address1, address2: a.address2,
    city: a.city, province: a.province, country: a.country,
    zip: a.zip, phone: a.phone,
  };
}

// ── Route handlers ────────────────────────────────────────────────────────────

export async function handleOrdersPaid(req: Request, res: Response): Promise<void> {
  const payload = req.body as ShopifyOrderPayload;
  const shopifyOrderId = String(payload.id);

  // Upsert customer
  let customerId: string | null = null;
  if (payload.customer) {
    const c = payload.customer;
    const customer = await prisma.customer.upsert({
      where:  { shopifyCustomerId: String(c.id) },
      update: { email: c.email, firstName: c.first_name, lastName: c.last_name },
      create: { shopifyCustomerId: String(c.id), email: c.email, firstName: c.first_name, lastName: c.last_name },
    });
    customerId = customer.id;
  }

  // Upsert order (idempotent — Shopify may retry)
  const order = await prisma.order.upsert({
    where:  { shopifyOrderId },
    update: {},
    create: { shopifyOrderId, customerId, status: OrderStatus.PENDING, totalPrice: payload.total_price, currency: payload.currency },
  });

  // Create line items (skip duplicates on retry)
  await prisma.orderItem.createMany({
    skipDuplicates: true,
    data: payload.line_items.map((li) => ({
      orderId:          order.id,
      shopifyLineItemId: String(li.id),
      productTitle:     li.title,
      variantTitle:     li.variant_title,
      shopifyProductId: String(li.product_id),
      shopifyVariantId: String(li.variant_id),
      quantity:         li.quantity,
      price:            li.price,
    })),
  });

  if (!payload.shipping_address) {
    logger.warn("orders-paid missing shipping address — flagging manual review", { shopifyOrderId });
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.NEEDS_MANUAL_REVIEW } });
    await sendOrderAlert(":warning: Order has no shipping address — needs manual review", shopifyOrderId);
    res.status(200).json({ ok: true });
    return;
  }

  await enqueueOrderRouter({ shopifyOrderId, shippingAddress: toShippingAddress(payload.shipping_address) });
  logger.info("order-paid queued for routing", { shopifyOrderId });
  res.status(200).json({ ok: true });
}

export async function handleOrdersFulfilled(req: Request, res: Response): Promise<void> {
  const payload = req.body as ShopifyOrderPayload;
  const shopifyOrderId = String(payload.id);
  const tracking = payload.fulfillments?.[0];

  const order = await prisma.order.findUnique({
    where:   { shopifyOrderId },
    include: { customer: true },
  });

  if (!order) { res.status(200).json({ ok: true }); return; } // not our order

  await prisma.order.update({
    where: { id: order.id },
    data:  { status: OrderStatus.FULFILLED, trackingNumber: tracking?.tracking_number ?? null, trackingUrl: tracking?.tracking_url ?? null },
  });

  if (order.customer) {
    await emitEvent({ type: "order.fulfilled", orderId: order.id, customerId: order.customer.id, customerEmail: order.customer.email });
  }

  res.status(200).json({ ok: true });
}

export async function handleCartsUpdated(req: Request, res: Response): Promise<void> {
  const payload = req.body as ShopifyCartPayload;
  if (!payload.email) { res.status(200).json({ ok: true }); return; }

  await emitEventDelayed(
    { type: "cart.abandoned", cartToken: payload.token, customerEmail: payload.email },
    60 * 60 * 1000,          // 1 hour
    `cart-${payload.token}`, // dedupeKey — resets the timer on each cart update
  );

  res.status(200).json({ ok: true });
}
