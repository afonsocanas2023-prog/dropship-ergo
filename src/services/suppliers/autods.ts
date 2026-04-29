import { env } from "../../config/env";
import { httpGet, httpPost, type HttpError } from "../../lib/http";
import { ok, type Result } from "../../lib/result";
import { logger } from "../../lib/logger";
import type { SupplierAdapter, StockLevel, SupplierOrderPayload, SupplierOrderResult } from "./adapter";

const BASE = "https://api.autods.com/v1";
const SUPPLIER_CODE = "AUTODS";

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.AUTODS_API_KEY}` };
}

interface AutoDsInventoryItem {
  sku: string;
  quantity: number;
}

interface AutoDsBulkInventoryResponse {
  items: AutoDsInventoryItem[];
}

interface AutoDsOrderResponse {
  id: string;
  externalId: string;
  trackingNumber?: string;
  estimatedDeliveryDays?: number;
}

async function getStockLevel(supplierSku: string): Promise<Result<StockLevel, HttpError>> {
  const url = `${BASE}/inventory/${encodeURIComponent(supplierSku)}`;
  const res = await httpGet<AutoDsInventoryItem>(url, authHeaders());

  if (!res.ok) return res;
  return ok({ supplierSku, quantity: res.value.quantity ?? 0 });
}

async function getAllStockLevels(supplierSkus: string[]): Promise<Result<StockLevel[], HttpError>> {
  const res = await httpPost<AutoDsBulkInventoryResponse>(
    `${BASE}/inventory/bulk`,
    { skus: supplierSkus },
    authHeaders(),
  );

  if (!res.ok) return res;

  const levels: StockLevel[] = res.value.items.map((item) => ({
    supplierSku: item.sku,
    quantity: item.quantity ?? 0,
  }));
  return ok(levels);
}

async function submitOrder(payload: SupplierOrderPayload): Promise<Result<SupplierOrderResult, HttpError>> {
  const { shippingAddress: addr, lineItems, shopifyOrderId } = payload;

  const body = {
    externalId: shopifyOrderId,
    shipping: {
      firstName: addr.firstName,
      lastName: addr.lastName,
      address1: addr.address1,
      address2: addr.address2,
      city: addr.city,
      state: addr.province,
      country: addr.country,
      zipCode: addr.zip,
      phone: addr.phone,
    },
    items: lineItems.map((li) => ({
      sku: li.supplierSku,
      quantity: li.quantity,
      price: li.unitPrice,
    })),
  };

  const res = await httpPost<AutoDsOrderResponse>(
    `${BASE}/orders`,
    body,
    authHeaders(),
  );

  if (!res.ok) return res;

  logger.info("AutoDS order created", { shopifyOrderId, autoDsOrderId: res.value.id });
  return ok({
    supplierOrderId: res.value.id,
    trackingNumber: res.value.trackingNumber,
    estimatedDeliveryDays: res.value.estimatedDeliveryDays,
  });
}

export const autodsAdapter: SupplierAdapter = {
  supplierCode: SUPPLIER_CODE,
  submitOrder,
  getStockLevel,
  getAllStockLevels,
};
