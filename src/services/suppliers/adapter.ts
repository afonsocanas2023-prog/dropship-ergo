import type { Result } from "../../lib/result";
import type { HttpError } from "../../lib/http";
import type { StockLevel, SupplierOrderPayload, SupplierOrderResult } from "../../types";

export type { StockLevel, SupplierOrderPayload, SupplierOrderResult };

export interface SupplierAdapter {
  readonly supplierCode: string;

  /**
   * Submit a complete order to the supplier.
   */
  submitOrder(
    payload: SupplierOrderPayload,
  ): Promise<Result<SupplierOrderResult, HttpError>>;

  /**
   * Fetch live stock for a single supplier SKU.
   */
  getStockLevel(supplierSku: string): Promise<Result<StockLevel, HttpError>>;

  /**
   * Fetch live stock for a batch of supplier SKUs in one API round-trip
   * where the supplier supports it, or fan-out to individual calls otherwise.
   */
  getAllStockLevels(
    supplierSkus: string[],
  ): Promise<Result<StockLevel[], HttpError>>;
}
