import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { logger } from "../lib/logger";

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Express middleware that verifies the X-Shopify-Hmac-Sha256 header.
 * Must be applied AFTER the rawBody-capturing json() middleware in index.ts.
 */
export function shopifyHmac(req: RawBodyRequest, res: Response, next: NextFunction): void {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
if (!hmacHeader || typeof hmacHeader !== "string") {
  res.status(401).json({ error: 'Missing HMAC header' });
  return;
}
  if (!hmacHeader || typeof hmacHeader !== "string") {
    logger.warn("shopify webhook missing hmac header", { path: req.path });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!req.rawBody) {
    logger.warn("shopify webhook missing raw body", { path: req.path });
    res.status(400).json({ error: "Bad Request" });
    return;
  }

  const digest = createHmac("sha256", env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");

  const digestBuf = Buffer.from(digest);
  const headerBuf = Buffer.from(hmacHeader);

  // timingSafeEqual requires equal-length buffers — length mismatch is itself a failure
  if (
    digestBuf.length !== headerBuf.length ||
    !timingSafeEqual(digestBuf, headerBuf)
  ) {
    logger.warn("shopify webhook hmac mismatch", { path: req.path });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
