import { env } from "../config/env";
import { httpGet, httpPost, httpPut, type HttpError } from "../lib/http";
import { type Result } from "../lib/result";
import type { ShopifyOrder, ShopifyCustomer } from "../types";

const API_VERSION = "2024-01";

function baseUrl(): string {
  return `https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/${API_VERSION}`;
}

function authHeaders(): Record<string, string> {
  return { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN };
}

interface ShopifyOrderEnvelope {
  order: ShopifyOrder;
}

interface ShopifyCustomerEnvelope {
  customer: ShopifyCustomer;
}

export async function getOrder(
  orderId: string,
): Promise<Result<ShopifyOrder, HttpError>> {
  const res = await httpGet<ShopifyOrderEnvelope>(
    `${baseUrl()}/orders/${orderId}.json`,
    authHeaders(),
  );
  if (!res.ok) return res;
  return { ok: true, value: res.value.order };
}

export async function updateOrderNote(
  orderId: string,
  note: string,
): Promise<Result<ShopifyOrder, HttpError>> {
  const res = await httpPut<ShopifyOrderEnvelope>(
    `${baseUrl()}/orders/${orderId}.json`,
    { order: { id: orderId, note } },
    authHeaders(),
  );
  if (!res.ok) return res;
  return { ok: true, value: res.value.order };
}

export async function setProductAvailability(
  productId: string,
  available: boolean,
): Promise<Result<unknown, HttpError>> {
  // Toggle product status: "active" = published, "draft" = unavailable
  const status = available ? "active" : "draft";
  return httpPut(
    `${baseUrl()}/products/${productId}.json`,
    { product: { id: productId, status } },
    authHeaders(),
  );
}

export async function cancelOrder(
  orderId: string,
  reason: string,
): Promise<Result<ShopifyOrder, HttpError>> {
  const res = await httpPost<ShopifyOrderEnvelope>(
    `${baseUrl()}/orders/${orderId}/cancel.json`,
    { reason },
    authHeaders(),
  );
  if (!res.ok) return res;
  return { ok: true, value: res.value.order };
}

export async function getCustomer(
  customerId: string,
): Promise<Result<ShopifyCustomer, HttpError>> {
  const res = await httpGet<ShopifyCustomerEnvelope>(
    `${baseUrl()}/customers/${customerId}.json`,
    authHeaders(),
  );
  if (!res.ok) return res;
  return { ok: true, value: res.value.customer };
}
