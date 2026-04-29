import { env } from "../config/env";
import { httpPost, type HttpError } from "../lib/http";
import { type Result } from "../lib/result";
import { logger } from "../lib/logger";
import type { SupplierOrderPayload, SupplierOrderResult } from "../types";

const BASE = "https://openapi.dserspro.com/api/v1";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.DSERS_API_KEY}` };
}

interface DsersOrderResponse {
  data: {
    order_id: string;
    tracking_number?: string;
  };
}

/**
 * DSers is used as the fulfilment channel for CJ Dropshipping orders routed
 * through the Shopify-DSers integration. The supplier adapters handle stock
 * queries; this service handles actual order placement via DSers' open API.
 */
export async function submitOrderViaDsers(
  payload: SupplierOrderPayload,
): Promise<Result<SupplierOrderResult, HttpError>> {
  const { shippingAddress: addr, lineItems, shopifyOrderId } = payload;

  const body = {
    platform_order_id: shopifyOrderId,
    shipping_address: {
      first_name: addr.firstName,
      last_name: addr.lastName,
      address1: addr.address1,
      address2: addr.address2 ?? "",
      city: addr.city,
      province: addr.province,
      country: addr.country,
      zip: addr.zip,
      phone: addr.phone ?? "",
    },
    line_items: lineItems.map((li) => ({
      sku: li.supplierSku,
      quantity: li.quantity,
      price: li.unitPrice,
    })),
  };

  const res = await httpPost<DsersOrderResponse>(
    `${BASE}/orders`,
    body,
    authHeaders(),
  );

  if (!res.ok) return res;

  logger.info("DSers order submitted", {
    shopifyOrderId,
    dsersOrderId: res.value.data.order_id,
  });

  return {
    ok: true,
    value: {
      supplierOrderId: res.value.data.order_id,
      trackingNumber: res.value.data.tracking_number,
    },
  };
}
