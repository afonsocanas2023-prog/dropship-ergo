import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env";
import { logger } from "../lib/logger";

/**
 * Express middleware that verifies the X-Gorgias-Secret shared-secret header.
 */
export function gorgiasAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = req.headers["x-gorgias-secret"];

  if (!secret || typeof secret !== "string") {
    logger.warn("gorgias webhook missing secret header", { path: req.path });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const incoming = Buffer.from(secret);
  const expected = Buffer.from(env.GORGIAS_WEBHOOK_SECRET);

  if (
    incoming.length !== expected.length ||
    !timingSafeEqual(incoming, expected)
  ) {
    logger.warn("gorgias webhook secret mismatch", { path: req.path });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
