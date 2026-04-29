import { env } from "../../config/env";
import { httpGet, httpPost, type HttpError } from "../../lib/http";
import { ok, err, type Result } from "../../lib/result";
import { logger } from "../../lib/logger";
import type { SupplierAdapter, StockLevel, SupplierOrderPayload, SupplierOrderResult } from "./adapter";

const BASE = "https://developers.cjdropshipping.com/api2.0/v1";
const SUPPLIER_CODE = "CJ_DROPSHIPPING";

function authHeaders(): Record<string, string> {
  return { "CJ-Access-Token": env.CJ_DROPSHIPPING_API_KEY };
}

interface CjApiResponse<T> {
  code: number;
  result: boolean;
  message: string;
  data: T;
}

interface CjVariant {
  vid: string;
  variantStock: number;
}

interface CjOrderResult {
  orderId: string;
  orderNum: string;
}

async function getStockLevel(supplierSku: string): Promise<Result<StockLevel, HttpError>> {
  const url = `${BASE}/product/variant/queryByVid?vid=${encodeURIComponent(supplierSku)}`;
  const res = await httpGet<CjApiResponse<CjVariant>>(url, authHeaders());

  if (!res.ok) return res;
  if (!res.value.result) {
    return err({ message: res.value.message ?? "CJ API error" });
  }

  return ok({ supplierSku, quantity: res.value.data.variantStock ?? 0 });
}

async function getAllStockLevels(supplierSkus: string[]): Promise<Result<StockLevel[], HttpError>> {
  const url = `${BASE}/product/inventory/queryByVids`;
  const res = await httpPost<CjApiResponse<CjVariant[]>>(url, { vids: supplierSkus }, authHeaders());

  if (!res.ok) return res;
  if (!res.value.result) {
    return err({ message: res.value.message ?? "CJ bulk inventory error" });
  }

  const levels: StockLevel[] = res.value.data.map((v) => ({
    supplierSku: v.vid,
    quantity: v.variantStock ?? 0,
  }));
  return ok(levels);
}

async function submitOrder(payload: SupplierOrderPayload): Promise<Result<SupplierOrderResult, HttpError>> {
  const { shippingAddress: addr, lineItems, shopifyOrderId } = payload;

  const body = {
    orderNumber: shopifyOrderId,
    shippingCustomerName: `${addr.firstName} ${addr.lastName}`.trim(),
    shippingAddress: addr.address1,
    shippingAddress2: addr.address2 ?? "",
    shippingCity: addr.city,
    shippingProvince: addr.province,
    shippingCountry: addr.country,
    shippingZip: addr.zip,
    shippingPhone: addr.phone ?? "",
    products: lineItems.map((li) => ({
      vid: li.supplierSku,
      quantity: li.quantity,
      sellPrice: li.unitPrice,
    })),
  };

  const res = await httpPost<CjApiResponse<CjOrderResult>>(
    `${BASE}/shopping/order/createOrder`,
    body,
    authHeaders(),
  );

  if (!res.ok) return res;
  if (!res.value.result) {
    return err({ message: res.value.message ?? "CJ order creation failed" });
  }

  logger.info("CJ order created", { shopifyOrderId, cjOrderId: res.value.data.orderId });
  return ok({ supplierOrderId: res.value.data.orderId });
}

export const cjAdapter: SupplierAdapter = {
  supplierCode: SUPPLIER_CODE,
  submitOrder,
  getStockLevel,
  getAllStockLevels,
};
