# dropship-ergo

Near-autonomous Shopify dropshipping automation for the ergonomic home-office niche.
Orders route to suppliers automatically, inventory syncs every 4 hours, support tickets
are classified and actioned by keyword/AI, and every key event triggers downstream
notifications via an internal event bus.

## Architecture

```
Shopify ──────────────────────────────────────────────────────────────┐
  orders/paid       → /webhooks/shopify/orders-paid    → orderRouter job (BullMQ)
  orders/fulfilled  → /webhooks/shopify/orders-fulfilled→ eventBus (order.fulfilled)
  carts/updated     → /webhooks/shopify/carts-updated  → eventBus (cart.abandoned, 1 h debounce)

Gorgias ───────────────────────────────────────────────────────────────┐
  ticket/created    → /webhooks/gorgias/ticket-created → ticketClassifier job (BullMQ)
  review/created    → /webhooks/gorgias/review-created → eventBus (review.negative)

Cron ──────────────────────────────────────────────────────────────────┐
  every 4 h                                            → inventorySync job (BullMQ)

Event bus (BullMQ) ─────────────────────────────────────────────────────┐
  order.paid        → writes revenue_log
  order.fulfilled   → Klaviyo post-purchase flow
  review.negative   → Slack alert + Gorgias draft reply
  supplier.stock_low→ Slack stock alert
  cart.abandoned    → Klaviyo abandoned-cart flow

Reports ───────────────────────────────────────────────────────────────┐
  GET /reports/revenue   Bearer token auth
  GET /reports/tickets
  GET /reports/stock
```

---

## Local setup

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 20+ |
| pnpm | 10+ |
| PostgreSQL | 14+ |
| Redis | 7+ |

Install pnpm if you don't have it:
```bash
npm install -g pnpm@10
```

### 1 — Clone and install

```bash
git clone <repo-url> dropship-ergo
cd dropship-ergo
pnpm install
```

### 2 — Configure environment

```bash
cp .env.example .env
# Open .env and fill in all values (see Environment Variables below)
```

### 3 — Database setup

```bash
# Apply migrations and generate the Prisma client
pnpm prisma migrate dev --name init
pnpm prisma generate
```

### 4 — Add startup scripts to package.json

Add these two scripts (the project ships without them so the entry point is explicit):

```json
"dev":   "tsx watch src/main.ts",
"start": "node dist/webhooks/index.js",
"build": "tsc"
```

Then create `src/main.ts`:

```ts
import { startServer } from './webhooks/index'
startServer()
```

### 5 — Start the server

```bash
pnpm dev
# → webhook server listening on port 3000
# → BullMQ workers for orderRouter, inventorySync, ticketClassifier, eventBus started
# → inventory sync scheduled (cron: 0 */4 * * *)
```

The server is ready when you see:
```
{"level":"info","message":"webhook server listening","port":3000}
{"level":"info","message":"inventory sync scheduled","cron":"0 */4 * * *"}
```

### 6 — Seed SKU supplier mappings

The system cannot route orders until `sku_supplier_map` has at least one row linking
each Shopify variant ID to a supplier SKU. Insert rows directly or write a seed script:

```sql
INSERT INTO suppliers (id, code, name, api_endpoint)
VALUES ('sup-cj', 'CJ', 'CJ Dropshipping', 'https://developers.cjdropshipping.com/api2.0');

INSERT INTO sku_supplier_map
  (id, shopify_variant_id, shopify_sku, shopify_product_id,
   primary_supplier_id, primary_supplier_sku)
VALUES
  ('map-1', '12345678', 'ERGO-CHAIR-BLK', '98765432', 'sup-cj', 'CJ-ERGO-001');
```

---

## Environment variables

All variables are validated at startup via Zod. The process exits immediately with a
clear error message if any required value is missing or malformed.

| Variable | Required | Description |
|----------|----------|-------------|
| `SHOPIFY_SHOP_DOMAIN` | ✓ | Your store domain, e.g. `mystore.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | ✓ | Admin API access token (starts with `shpat_`) |
| `SHOPIFY_WEBHOOK_SECRET` | ✓ | Shopify webhook signing secret — copied from the webhook registration page in your Partner dashboard or app settings |
| `GORGIAS_API_KEY` | ✓ | Gorgias REST API key (Settings → REST API) |
| `GORGIAS_WEBHOOK_SECRET` | ✓ | Arbitrary secret you choose; must match the value you enter in each Gorgias webhook's header |
| `KLAVIYO_API_KEY` | ✓ | Klaviyo private API key |
| `SLACK_WEBHOOK_URL` | ✓ | Incoming Webhook URL from your Slack app (must be a valid URL) |
| `DSERS_API_KEY` | ✓ | DSers REST API key for order submission |
| `CJ_DROPSHIPPING_API_KEY` | ✓ | CJ Dropshipping API key for stock queries |
| `AUTODS_API_KEY` | ✓ | AutoDS API key for backup-supplier stock queries |
| `ANTHROPIC_API_KEY` | ✓ | Anthropic API key — used only for ambiguous ticket classification (falls back to `UNKNOWN` on failure) |
| `LOOP_RETURNS_API_KEY` | ✓ | Loop Returns API key for return portal links |
| `REDIS_URL` | ✓ | Redis connection string, e.g. `redis://localhost:6379` |
| `DATABASE_URL` | ✓ | PostgreSQL connection string, e.g. `postgresql://user:pass@localhost:5432/dropship` |
| `REPORTS_API_KEY` | ✓ | Static Bearer token that protects all `/reports/*` endpoints. Choose a long random string. |
| `PORT` | — | HTTP port (default: `3000`) |

---

## Registering Shopify webhooks

Shopify webhooks must be registered so Shopify knows where to `POST` events.
The HMAC signature on every request is verified using `SHOPIFY_WEBHOOK_SECRET`.

### Option A — Shopify CLI (recommended for development)

```bash
npm install -g @shopify/cli
shopify auth login --store mystore.myshopify.com

# Register each topic
shopify webhooks register \
  --address https://YOUR_PUBLIC_URL/webhooks/shopify/orders-paid \
  --topic orders/paid

shopify webhooks register \
  --address https://YOUR_PUBLIC_URL/webhooks/shopify/orders-fulfilled \
  --topic orders/fulfilled

shopify webhooks register \
  --address https://YOUR_PUBLIC_URL/webhooks/shopify/carts-updated \
  --topic carts/updated
```

### Option B — Admin API (scriptable, good for CI)

```bash
SHOP="mystore.myshopify.com"
TOKEN="shpat_..."
BASE="https://YOUR_PUBLIC_URL"

for TOPIC_PATH in \
  "orders/paid   /webhooks/shopify/orders-paid" \
  "orders/fulfilled /webhooks/shopify/orders-fulfilled" \
  "carts/updated /webhooks/shopify/carts-updated"; do
  TOPIC=$(echo $TOPIC_PATH | awk '{print $1}')
  PATH=$(echo $TOPIC_PATH | awk '{print $2}')
  curl -s -X POST "https://${SHOP}/admin/api/2024-01/webhooks.json" \
    -H "X-Shopify-Access-Token: ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"webhook\":{\"topic\":\"${TOPIC}\",\"address\":\"${BASE}${PATH}\",\"format\":\"json\"}}"
  echo
done
```

Copy the `signing_secret` from each response into `SHOPIFY_WEBHOOK_SECRET`.
All three webhooks share the same secret.

### Option C — Shopify admin dashboard

Partners Dashboard → Apps → Your App → Webhooks → Create webhook.
Enter each address above, choose JSON format, and copy the signing secret.

### Verify registration

```bash
curl "https://mystore.myshopify.com/admin/api/2024-01/webhooks.json" \
  -H "X-Shopify-Access-Token: shpat_..."
```

### Registering Gorgias webhooks

In Gorgias: Settings → Webhooks → Add webhook.

| Event | URL | Header to add |
|-------|-----|--------------|
| `ticket.created` | `https://YOUR_PUBLIC_URL/webhooks/gorgias/ticket-created` | `X-Gorgias-Secret: <GORGIAS_WEBHOOK_SECRET>` |
| `ticket_review.created` | `https://YOUR_PUBLIC_URL/webhooks/gorgias/review-created` | `X-Gorgias-Secret: <GORGIAS_WEBHOOK_SECRET>` |

The value of `GORGIAS_WEBHOOK_SECRET` is a string you choose; set the same value in both the Gorgias header and your environment.

---

## Deploy to Railway

Railway provisions PostgreSQL and Redis as managed services and sets the connection
strings automatically.

### 1 — Install Railway CLI and log in

```bash
npm install -g @railway/cli
railway login
```

### 2 — Create project and attach services

```bash
railway init          # creates a new Railway project, links the current directory
```

Then in the Railway dashboard (or via CLI):
```bash
railway add --database postgresql
railway add --database redis
```

Railway auto-injects `DATABASE_URL` and `REDIS_URL` into your service environment.

### 3 — Set environment variables

```bash
railway variables set \
  SHOPIFY_SHOP_DOMAIN="mystore.myshopify.com" \
  SHOPIFY_ACCESS_TOKEN="shpat_..." \
  SHOPIFY_WEBHOOK_SECRET="..." \
  GORGIAS_API_KEY="..." \
  GORGIAS_WEBHOOK_SECRET="..." \
  KLAVIYO_API_KEY="..." \
  SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..." \
  DSERS_API_KEY="..." \
  CJ_DROPSHIPPING_API_KEY="..." \
  AUTODS_API_KEY="..." \
  ANTHROPIC_API_KEY="sk-ant-..." \
  LOOP_RETURNS_API_KEY="..." \
  REPORTS_API_KEY="$(openssl rand -hex 32)" \
  NODE_ENV="production"
```

### 4 — Configure start command

In the Railway dashboard → Settings → Deploy → Start command:
```
pnpm build && pnpm prisma migrate deploy && node dist/main.js
```

Or add to `package.json`:
```json
"railway:start": "pnpm build && pnpm prisma migrate deploy && node dist/main.js"
```

### 5 — Deploy

```bash
railway up
```

Railway will build the image, run migrations, and start the server.
The public URL appears in the dashboard — use it when registering webhooks.

### 6 — Tail logs

```bash
railway logs
```

---

## Deploy to Render

Render runs the web service, PostgreSQL, and Redis as separate services that can
reference each other via environment variable groups.

### 1 — Add a `render.yaml` to the repo root

```yaml
services:
  - type: web
    name: dropship-ergo
    runtime: node
    plan: starter
    buildCommand: pnpm install && pnpm build && pnpm prisma generate
    startCommand: pnpm prisma migrate deploy && node dist/main.js
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase:
          name: dropship-ergo-db
          property: connectionString
      - key: REDIS_URL
        fromService:
          name: dropship-ergo-redis
          type: redis
          property: connectionString
      # Add remaining secrets via the Render dashboard (not in this file)

databases:
  - name: dropship-ergo-db
    plan: starter

  - name: dropship-ergo-redis
    type: redis
    plan: starter
    ipAllowList: []
```

### 2 — Push the file and connect on Render

1. Commit and push `render.yaml` to GitHub.
2. Go to [dashboard.render.com](https://dashboard.render.com) → New → Blueprint.
3. Select your repository. Render will detect `render.yaml` and create all three services.

### 3 — Set secret environment variables

In the Render dashboard → dropship-ergo (web service) → Environment, add:

```
SHOPIFY_SHOP_DOMAIN
SHOPIFY_ACCESS_TOKEN
SHOPIFY_WEBHOOK_SECRET
GORGIAS_API_KEY
GORGIAS_WEBHOOK_SECRET
KLAVIYO_API_KEY
SLACK_WEBHOOK_URL
DSERS_API_KEY
CJ_DROPSHIPPING_API_KEY
AUTODS_API_KEY
ANTHROPIC_API_KEY
LOOP_RETURNS_API_KEY
REPORTS_API_KEY
```

### 4 — Deploy

Trigger the first deploy from the dashboard or push a commit. Render will run
`pnpm prisma migrate deploy` before starting the server, so migrations are
always applied before traffic is served.

### 5 — Tail logs

```bash
# Install Render CLI: https://render.com/docs/cli
render logs --service dropship-ergo --tail
```

---

## Runbook — 5 most common operational alerts

All alerts arrive in Slack. Each message includes the affected order ID, SKU, or
customer email for immediate context.

---

### Alert 1 — `:warning: Order needs manual review — items out of stock or routing failed`

**What it means:** One or more line items could not be routed to either the primary or
backup supplier. This fires when every supplier stock API returns `quantity = 0`, or
when DSers rejects the order submission (e.g., API timeout, invalid payload).

**Order status in DB:** `NEEDS_MANUAL_REVIEW`

**Investigate:**
```sql
-- Find the order and its items
SELECT o.shopify_order_id, o.status, oi.shopify_variant_id, oi.routed_supplier_id
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'NEEDS_MANUAL_REVIEW'
ORDER BY o.created_at DESC LIMIT 10;

-- Check current cached stock for those variants
SELECT sc.supplier_sku, sc.stock_level, s.code, sc.last_synced_at
FROM stock_cache sc
JOIN suppliers s ON s.id = sc.supplier_id
WHERE sc.supplier_sku IN ('<sku1>', '<sku2>');
```

**Resolve:**
1. If stock is a data problem (sync lag), wait for the next 4-hour inventory sync and
   re-enqueue the job: update `orders.status` back to `'PENDING'` and re-POST the
   `orders/paid` webhook from Shopify admin (Resend notification).
2. If the supplier is genuinely out of stock, route the item manually in the DSers
   dashboard. Then update the order in your DB:
   ```sql
   UPDATE orders SET status = 'ROUTED_TO_SUPPLIER' WHERE shopify_order_id = '<id>';
   ```
3. If DSers was down, the job will retry automatically per the BullMQ retry policy.
   Check DSers status page and monitor the queue.

---

### Alert 2 — `:warning: Order has no shipping address — needs manual review`

**What it means:** Shopify sent an `orders/paid` event but the payload contained no
`shipping_address` field. This can happen for digital orders, orders from draft orders
without an address, or edge-case webhook payloads.

**Order status in DB:** `NEEDS_MANUAL_REVIEW`

**Investigate:**
1. Open the Shopify admin → Orders → find the order by ID from the alert.
2. Check whether the customer provided an address on the storefront or if it is a
   digital/virtual product that does not need shipping.

**Resolve:**
- **Physical product, address missing:** Contact the customer via Gorgias to collect
  their address. Add it in Shopify admin. Then manually re-enqueue:
  ```sql
  UPDATE orders SET status = 'PENDING' WHERE shopify_order_id = '<id>';
  ```
  And resend the `orders/paid` webhook from Shopify admin.
- **Digital product (expected):** No action needed. Mark as fulfilled manually.

---

### Alert 3 — `:warning: Stock alert for *[SKU]* — stock dropped to 0`

**What it means:** The 4-hour inventory sync detected that a supplier SKU went from
`> 0` to `0` units. The corresponding Shopify product was automatically set to `draft`
(hidden from the storefront) to prevent overselling.

**Investigate:**
```sql
-- Confirm the event and when it happened
SELECT se.supplier_sku, se.previous_stock, se.new_stock, se.action, se.created_at, s.code
FROM stock_events se
JOIN suppliers s ON s.id = se.supplier_id
WHERE se.action = 'PRODUCT_HIDDEN'
ORDER BY se.created_at DESC LIMIT 5;
```

**Resolve:**
1. Check the supplier's portal for a restock ETA.
2. If restock is confirmed, do nothing — when the next sync detects `quantity > 5`,
   `inventorySync` will automatically re-publish the product on Shopify and send a
   "restored" alert.
3. If restock is uncertain, update your product description or remove it from
   collections manually in Shopify until stock returns.
4. To force an immediate sync without waiting 4 hours, add a one-off job to the queue:
   ```bash
   # With redis-cli
   redis-cli LPUSH bull:inventory-sync:wait '{"name":"sync","data":{}}'
   ```

---

### Alert 4 — `:warning: Stock alert for *[SKU]* — supplier.stock_low (< 5 units)`

**What it means:** Stock crossed below the 5-unit low-stock threshold during a sync
cycle. Unlike Alert 3, the product is **still live** on Shopify. This is an early
warning before a potential stockout.

**Investigate:**
```sql
SELECT sc.supplier_sku, sc.stock_level, sc.last_synced_at, s.code
FROM stock_cache sc
JOIN suppliers s ON s.id = sc.supplier_id
WHERE sc.stock_level > 0 AND sc.stock_level < 5
ORDER BY sc.stock_level ASC;
```

**Resolve:**
1. Check the supplier portal for incoming stock.
2. If restocking will take > 3 days, consider manually setting the Shopify product to
   draft to avoid disappointed customers. Shopify Admin → Products → select product →
   Status: Draft.
3. Check if the backup supplier in `sku_supplier_map` has adequate stock. If the backup
   is well-stocked, no action is needed — `orderRouter` will automatically fall back to
   it when primary stock hits 0.
4. Alert fires once per threshold crossing, not on every sync — you will not receive
   repeated alerts as long as stock stays below 5.

---

### Alert 5 — `:rotating_light: Negative review (score X/5) from [email]`

**What it means:** A Gorgias review webhook arrived with `score ≤ 2`. The event bus
has already (a) posted this Slack alert and (b) created a draft reply on the Gorgias
ticket thanking the customer and promising follow-up.

**Investigate:**
1. Open Gorgias → search for the customer email in the alert.
2. The draft reply is already attached to the ticket — review it before sending.
3. Check the linked order in your DB to understand what was purchased and whether a
   supplier dispute exists:
   ```sql
   SELECT o.shopify_order_id, o.status, sd.status AS dispute_status, sd.description
   FROM orders o
   JOIN customers c ON c.id = o.customer_id
   LEFT JOIN supplier_disputes sd ON sd.order_id = o.id
   WHERE c.email = '<email>'
   ORDER BY o.created_at DESC LIMIT 1;
   ```

**Resolve:**
1. Review and personalise the draft Gorgias reply, then send it.
2. If the complaint is about a damaged or defective item and no `supplier_disputes` row
   exists yet, create one via the Gorgias `DAMAGE_CLAIM` flow (re-submit a ticket with
   keywords like "damaged" or "broken" to trigger the classifier), or insert manually:
   ```sql
   INSERT INTO supplier_disputes (id, support_ticket_id, supplier_id, order_id, order_item_id, status, description)
   VALUES (gen_random_uuid(), '<ticket_id>', '<supplier_id>', '<order_id>', '<item_id>', 'OPEN', '<brief description>');
   ```
3. Offer a replacement or full refund at your discretion, then update the dispute status
   to `RESOLVED` once settled.
