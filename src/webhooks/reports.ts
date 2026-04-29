import express, { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { TicketStatus } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../config/env";
import { logger } from "../lib/logger";

// ── Bearer-token auth ─────────────────────────────────────────────────────────

function reportsAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = Buffer.from(auth.slice(7));
  const expected = Buffer.from(env.REPORTS_API_KEY);
  if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
    logger.warn("reports api invalid token");
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

// ── Router ────────────────────────────────────────────────────────────────────

export const reportsRouter: express.Router = Router();
reportsRouter.use(reportsAuth);

// GET /reports/revenue?from=<iso>&to=<iso>
reportsRouter.get("/revenue", async (req: Request, res: Response): Promise<void> => {
  const now = new Date();
  const from = req.query["from"] ? new Date(String(req.query["from"])) : new Date(now.getTime() - 30 * 864e5);
  const to   = req.query["to"]   ? new Date(String(req.query["to"]))   : now;

  const logs = await prisma.revenueLog.findMany({
    where: { createdAt: { gte: from, lte: to } },
    select: { totalPrice: true },
  });

  const gmv = logs.reduce((sum, l) => sum + Number(l.totalPrice), 0);
  const orderCount = logs.length;
  const aov = orderCount > 0 ? gmv / orderCount : 0;

  res.json({ from, to, gmv: gmv.toFixed(2), orderCount, aov: aov.toFixed(2) });
});

// GET /reports/tickets
reportsRouter.get("/tickets", async (_req: Request, res: Response): Promise<void> => {
  const [byCategory, total, autoClosed] = await Promise.all([
    prisma.supportTicket.groupBy({
      by: ["category"],
      _count: { id: true },
      orderBy: { _count: { id: "desc" } },
    }),
    prisma.supportTicket.count(),
    prisma.supportTicket.count({ where: { status: TicketStatus.AUTO_CLOSED } }),
  ]);

  res.json({
    total,
    autoResolutionRate: total > 0 ? Number((autoClosed / total).toFixed(4)) : 0,
    byCategory: byCategory.map((r) => ({ category: r.category, count: r._count.id })),
  });
});

// GET /reports/stock
reportsRouter.get("/stock", async (_req: Request, res: Response): Promise<void> => {
  const [stockLevels, recentEvents] = await Promise.all([
    prisma.stockCache.findMany({
      include: { supplier: { select: { code: true, name: true } } },
      orderBy: { stockLevel: "asc" },
    }),
    prisma.stockEvent.findMany({
      take: 50,
      include: { supplier: { select: { code: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  res.json({ stockLevels, recentEvents });
});
