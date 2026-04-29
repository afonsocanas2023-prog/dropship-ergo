# CLAUDE.md — Ergonomic Home Office Dropshipping Automation

## Project Overview
This is a Node.js/TypeScript automation layer for a Shopify dropshipping store
in the premium ergonomic home office niche. The goal is near-autonomous
operations: orders route to suppliers automatically, inventory syncs across
suppliers, customer support tickets are classified and auto-responded, and
all key events trigger downstream notifications.

## Tech Stack
- Runtime: Node.js 20+ with TypeScript (strict mode)
- Framework: Express.js for webhook receivers
- Database: PostgreSQL via Prisma ORM
- Queue: BullMQ with Redis for async job processing
- Testing: Vitest
- Package manager: pnpm

## Coding Conventions
- Named exports only, no default exports
- async/await throughout, no .then() chains
- Result<T, E> pattern for error handling (see src/lib/result.ts)
- All environment variables accessed via src/config/env.ts (validated with zod)
- No magic strings — use typed enums or const objects

## File Structure
src/
  webhooks/      # Express routes that receive Shopify/supplier webhooks
  jobs/          # BullMQ job processors (order routing, stock sync, etc.)
  services/      # External API clients (Shopify, DSers, Gorgias, Klaviyo)
  lib/           # Shared utilities (result type, logger, http client)
  config/        # Environment config, constants
  types/         # Shared TypeScript interfaces
prisma/          # Schema and migrations
tests/           # Vitest test files mirroring src/ structure

## Rules
- DO NOT modify prisma/migrations/ directly
- DO NOT install new dependencies without noting it in your response
- Always run `pnpm lint && pnpm typecheck` before considering a task done
- Keep files under 200 lines; extract helpers when needed
- Every external API call must go through the retry wrapper in src/lib/http.ts

---

## Module Specifications

### MODULE 1: Order Routing Engine
**File:** src/jobs/orderRouter.ts
**Trigger:** Shopify webhook — orders/paid
**Logic:**
  1. Receive order payload from Shopify
  2. For each line item, look up the mapped supplier SKU from the DB
  3. If primary supplier stock > 0, route to primary supplier via DSers API
  4. If primary stock = 0, check backup supplier (also in DB)
  5. If both out of stock, flag order as NEEDS_MANUAL_REVIEW in DB and
     fire a Slack alert via src/services/slack.ts
  6. On successful submission, update order status in DB to ROUTED_TO_SUPPLIER
**DB Tables needed:** orders, order_items, sku_supplier_map, suppliers

### MODULE 2: Inventory Sync
**File:** src/jobs/inventorySync.ts
**Trigger:** CRON every 4 hours via BullMQ repeatable job
**Logic:**
  1. For every active SKU in sku_supplier_map, call each supplier's stock API
  2. Compare returned stock to DB cache
  3. If stock changed: update DB, update Shopify product availability via API
  4. If stock drops to 0: set Shopify product to draft (unavailable), send Slack alert
  5. If stock returns from 0 to >5: re-publish product on Shopify, send Slack alert
  6. Log all stock changes to stock_events table for audit trail
**DB Tables needed:** sku_supplier_map, suppliers, stock_cache, stock_events

### MODULE 3: Customer Support Classifier
**File:** src/jobs/ticketClassifier.ts
**Trigger:** Gorgias webhook — ticket/created
**Categories and actions:**
  - WHERE_IS_ORDER: fetch tracking from DB, reply via Gorgias macro #1 with
    tracking link. Auto-close ticket.
  - CANCELLATION: check if order status is ROUTED_TO_SUPPLIER.
    If not yet routed, cancel via Shopify API and reply with confirmation.
    If already routed, reply with "processing" macro, escalate to human.
  - PRODUCT_QUESTION: tag ticket with NEEDS_FAQ_RESPONSE, assign to Gorgias
    AI agent queue (do not auto-reply — let Gorgias AI handle from KB).
  - DAMAGE_CLAIM: create supplier dispute record in DB, attach to ticket,
    escalate to human queue with pre-filled template.
  - RETURN_REQUEST: send Loop Returns portal link via macro #5. Log in DB.
  - UNKNOWN: tag as NEEDS_HUMAN, escalate. Log for macro training review.
**Classification method:** keyword matching first (fast path), then call
  Anthropic API (claude-haiku-4-5) for ambiguous cases only to reduce cost.
**DB Tables needed:** support_tickets, supplier_disputes

### MODULE 4: Event Bus (Zapier-replacement)
**File:** src/jobs/eventBus.ts
**Trigger:** Internal events emitted by other modules
**Events to handle:**
  - order.paid → log to revenue_log table
  - order.fulfilled → add customer to Klaviyo post-purchase sequence via API
  - review.negative (score ≤ 2) → Slack alert + create draft Gorgias reply
  - supplier.stock_low (< 5 units) → email alert to owner
  - cart.abandoned (1hr, from Shopify webhook) → trigger Klaviyo flow via API

### MODULE 5: Webhook Server
**File:** src/webhooks/index.ts
**Routes:**
  POST /webhooks/shopify/orders-paid        → enqueues orderRouter job
  POST /webhooks/shopify/orders-fulfilled   → emits order.fulfilled event
  POST /webhooks/shopify/carts-updated      → emits cart.abandoned event (debounced 1hr)
  POST /webhooks/gorgias/ticket-created     → enqueues ticketClassifier job
  POST /webhooks/gorgias/review-created     → emits review event if score ≤ 2
**Security:** All Shopify webhooks verified via HMAC (X-Shopify-Hmac-Sha256 header)
  All Gorgias webhooks verified via shared secret in X-Gorgias-Secret header

### MODULE 6: Shopify Service Client
**File:** src/services/shopify.ts
**Methods needed:**
  - getOrder(orderId): fetch full order with line items
  - updateOrderNote(orderId, note): add internal note to order
  - setProductAvailability(productId, available: boolean)
  - cancelOrder(orderId, reason)
  - getCustomer(customerId)
**Auth:** Shopify Admin API, access token from env.SHOPIFY_ACCESS_TOKEN

### MODULE 7: Supplier Service Client
**File:** src/services/supplier.ts
**Methods needed:**
  - submitOrder(supplierCode, orderPayload): POST to supplier API
  - getStockLevel(supplierCode, supplierSku): GET stock for one SKU
  - getAllStockLevels(supplierCode): bulk stock fetch
**Note:** CJ Dropshipping and AutoDS have different API formats. Use the
  Strategy pattern — a SupplierAdapter interface with concrete implementations
  for each supplier in src/services/suppliers/.

### MODULE 8: Reporting Endpoint
**File:** src/webhooks/reports.ts
**Routes:**
  GET /reports/revenue?from=&to=    → total GMV, order count, AOV from revenue_log
  GET /reports/tickets              → ticket volume by category, auto-resolution rate
  GET /reports/stock                → current stock levels and recent stock events
**Auth:** Bearer token (REPORTS_API_KEY env var)

---

## Environment Variables Required
SHOPIFY_SHOP_DOMAIN=
SHOPIFY_ACCESS_TOKEN=
SHOPIFY_WEBHOOK_SECRET=
GORGIAS_API_KEY=
GORGIAS_WEBHOOK_SECRET=
KLAVIYO_API_KEY=
SLACK_WEBHOOK_URL=
DSERS_API_KEY=
CJ_DROPSHIPPING_API_KEY=
AUTODS_API_KEY=
ANTHROPIC_API_KEY=           # for ticket classification fallback only
LOOP_RETURNS_API_KEY=
REDIS_URL=
DATABASE_URL=
REPORTS_API_KEY=
PORT=3000

## Database Schema (Prisma — ask Claude to generate full schema from this)
Tables: orders, order_items, sku_supplier_map, suppliers, stock_cache,
        stock_events, support_tickets, supplier_disputes, revenue_log, customers

---

## Build Order for Claude Code Sessions
Work in this order to avoid dependency issues:
1. prisma/schema.prisma (full schema)
2. src/config/env.ts (zod-validated env)
3. src/lib/ (result type, logger, http retry wrapper)
4. src/services/ (Shopify, Gorgias, Klaviyo, Slack, supplier adapters)
5. src/jobs/ (order router, inventory sync, ticket classifier, event bus)
6. src/webhooks/ (Express server, all routes, HMAC verification)
7. src/webhooks/reports.ts (reporting endpoints)
8. tests/ (one test file per module)
9. README.md (setup instructions, deployment notes)
