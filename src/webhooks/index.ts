import express, { type Request, type Response, type NextFunction } from "express";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { shopifyHmac, type RawBodyRequest } from "./shopifyHmac";
import { gorgiasAuth } from "./gorgiasAuth";
import { handleOrdersPaid, handleOrdersFulfilled, handleCartsUpdated } from "./shopifyHandlers";
import { handleTicketCreated, handleReviewCreated } from "./gorgiasHandlers";
import { reportsRouter } from "./reports";
import { createEventBusWorker } from "../jobs/eventBus";
import { createOrderRouterWorker } from "../jobs/orderRouter";
import { createInventorySyncWorker, scheduleInventorySync } from "../jobs/inventorySync";
import { createTicketClassifierWorker } from "../jobs/ticketClassifier";

// ── App ───────────────────────────────────────────────────────────────────────

const app: express.Express = express();

// Capture raw body for Shopify HMAC verification before JSON parsing
app.use(
  express.json({
    verify: (req: Request, _res: Response, buf: Buffer) => {
      (req as RawBodyRequest).rawBody = buf;
    },
  }),
);

// ── Shopify webhooks ──────────────────────────────────────────────────────────

app.post("/webhooks/shopify/orders-paid",      shopifyHmac, handleOrdersPaid);
app.post("/webhooks/shopify/orders-fulfilled", shopifyHmac, handleOrdersFulfilled);
app.post("/webhooks/shopify/carts-updated",    shopifyHmac, handleCartsUpdated);

// ── Gorgias webhooks ──────────────────────────────────────────────────────────

app.post("/webhooks/gorgias/ticket-created", gorgiasAuth, handleTicketCreated);
app.post("/webhooks/gorgias/review-created", gorgiasAuth, handleReviewCreated);

// ── Reports ───────────────────────────────────────────────────────────────────

app.use("/reports", reportsRouter);

// ── Global error handler ──────────────────────────────────────────────────────

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error("unhandled express error", { message: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal Server Error" });
});

// ── Server + worker startup ───────────────────────────────────────────────────

export function startServer(): void {
  createEventBusWorker();
  createOrderRouterWorker();
  createInventorySyncWorker();
  createTicketClassifierWorker();

  scheduleInventorySync().catch((err: Error) =>
    logger.error("failed to schedule inventory sync", { error: err.message }),
  );

  app.listen(env.PORT, () => {
    logger.info("webhook server listening", { port: env.PORT });
  });
}

