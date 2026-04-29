import { err, type Result } from "../lib/result";
import type { HttpError } from "../lib/http";
import type { SupplierAdapter, StockLevel, SupplierOrderPayload, SupplierOrderResult } from "./suppliers/adapter";
import { cjAdapter } from "./suppliers/cj";
import { autodsAdapter } from "./suppliers/autods";

const ADAPTERS: ReadonlyMap<string, SupplierAdapter> = new Map([
  [cjAdapter.supplierCode, cjAdapter],
  [autodsAdapter.supplierCode, autodsAdapter],
]);

function getAdapter(supplierCode: string): Result<SupplierAdapter, HttpError> {
  const adapter = ADAPTERS.get(supplierCode);
  if (!adapter) {
    return err({ message: `No adapter registered for supplier: ${supplierCode}` });
  }
  return { ok: true, value: adapter };
}

export async function submitOrder(
  supplierCode: string,
  payload: SupplierOrderPayload,
): Promise<Result<SupplierOrderResult, HttpError>> {
  const adapterResult = getAdapter(supplierCode);
  if (!adapterResult.ok) return adapterResult;
  return adapterResult.value.submitOrder(payload);
}

export async function getStockLevel(
  supplierCode: string,
  supplierSku: string,
): Promise<Result<StockLevel, HttpError>> {
  const adapterResult = getAdapter(supplierCode);
  if (!adapterResult.ok) return adapterResult;
  return adapterResult.value.getStockLevel(supplierSku);
}

export async function getAllStockLevels(
  supplierCode: string,
  supplierSkus: string[],
): Promise<Result<StockLevel[], HttpError>> {
  const adapterResult = getAdapter(supplierCode);
  if (!adapterResult.ok) return adapterResult;
  return adapterResult.value.getAllStockLevels(supplierSkus);
}

export { ADAPTERS };
export type { SupplierAdapter, StockLevel, SupplierOrderPayload, SupplierOrderResult };
