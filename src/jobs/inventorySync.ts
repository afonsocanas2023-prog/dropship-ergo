import { Worker } from "bullmq";
import { StockEventAction } from "@prisma/client";
import { redis, QUEUE_NAMES, makeQueue } from "../lib/queue";
import { prisma } from "../lib/db";
import { logger } from "../lib/logger";
import { getAllStockLevels } from "../services/supplier";
import { setProductAvailability } from "../services/shopify";
import { sendStockAlert } from "../services/slack";
import { emitEvent } from "./eventBus";

const STOCK_LOW_THRESHOLD = 5;
const CRON_EVERY_4H = "0 */4 * * *";

// ── Queue ─────────────────────────────────────────────────────────────────────

const inventorySyncQueue = makeQueue(QUEUE_NAMES.INVENTORY_SYNC);

export async function scheduleInventorySync(): Promise<void> {
  await inventorySyncQueue.add("sync", {}, {
    repeat: { pattern: CRON_EVERY_4H },
    jobId: "inventory-sync-cron",
  });
  logger.info("inventory sync scheduled", { cron: CRON_EVERY_4H });
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function runSync(): Promise<void> {
  const mappings = await prisma.skuSupplierMap.findMany({
    where: { isActive: true },
    include: { primarySupplier: true },
  });

  // Group active SKUs by supplier
  const bySupplier = new Map<string, { id: string; code: string; skus: string[]; productIds: Map<string, string> }>();
  for (const m of mappings) {
    const { id, code } = m.primarySupplier;
    if (!bySupplier.has(code)) bySupplier.set(code, { id, code, skus: [], productIds: new Map() });
    const entry = bySupplier.get(code)!;
    entry.skus.push(m.primarySupplierSku);
    entry.productIds.set(m.primarySupplierSku, m.shopifyProductId);
  }

  for (const supplier of bySupplier.values()) {
    const result = await getAllStockLevels(supplier.code, supplier.skus);
    if (!result.ok) {
      logger.error("stock fetch failed", { supplier: supplier.code, error: result.error.message });
      continue;
    }

    for (const { supplierSku, quantity } of result.value) {
      const cache = await prisma.stockCache.findUnique({
        where: { supplierId_supplierSku: { supplierId: supplier.id, supplierSku } },
      });
      const previousStock = cache?.stockLevel ?? 0;

      if (previousStock === quantity) continue; // no change

      // Update cache
      await prisma.stockCache.upsert({
        where:  { supplierId_supplierSku: { supplierId: supplier.id, supplierSku } },
        update: { stockLevel: quantity, lastSyncedAt: new Date() },
        create: { supplierId: supplier.id, supplierSku, stockLevel: quantity },
      });

      // Determine action and log stock event
      const droppedToZero    = quantity === 0 && previousStock > 0;
      const restoredFromZero = quantity > STOCK_LOW_THRESHOLD && previousStock === 0;
      const action = droppedToZero    ? StockEventAction.PRODUCT_HIDDEN
                   : restoredFromZero ? StockEventAction.PRODUCT_PUBLISHED
                   :                    StockEventAction.UPDATED;

      const shopifyProductId = supplier.productIds.get(supplierSku);
      await prisma.stockEvent.create({
        data: { supplierId: supplier.id, supplierSku, previousStock, newStock: quantity, shopifyProductId, action },
      });

      // Shopify visibility + Slack alert on zero / restore
      if (droppedToZero) {
        if (shopifyProductId) await setProductAvailability(shopifyProductId, false);
        await sendStockAlert(supplierSku, supplier.code, quantity);
      } else if (restoredFromZero) {
        if (shopifyProductId) await setProductAvailability(shopifyProductId, true);
        await sendStockAlert(supplierSku, supplier.code, quantity);
      }

      // Emit stock_low only when crossing below threshold (not on every sync)
      if (quantity > 0 && quantity < STOCK_LOW_THRESHOLD && previousStock >= STOCK_LOW_THRESHOLD) {
        await emitEvent({ type: "supplier.stock_low", supplierCode: supplier.code, supplierSku, quantity });
      }

      logger.info("stock updated", { supplier: supplier.code, supplierSku, previousStock, quantity, action });
    }
  }
}

// ── Worker factory ────────────────────────────────────────────────────────────

export function createInventorySyncWorker(): Worker {
  const worker = new Worker(
    QUEUE_NAMES.INVENTORY_SYNC,
    async () => runSync(),
    { connection: redis },
  );

  worker.on("failed", (job, err) => {
    logger.error("inventory sync job failed", { jobId: job?.id, error: err.message });
  });

  return worker;
}
