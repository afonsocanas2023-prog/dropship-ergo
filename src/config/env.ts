import { z } from "zod";

const envSchema = z.object({
  SHOPIFY_SHOP_DOMAIN:      z.string().min(1),
  SHOPIFY_ACCESS_TOKEN:     z.string().min(1),
  SHOPIFY_WEBHOOK_SECRET:   z.string().min(1),
  GORGIAS_API_KEY:          z.string().min(1),
  GORGIAS_WEBHOOK_SECRET:   z.string().min(1),
  KLAVIYO_API_KEY:          z.string().min(1),
  SLACK_WEBHOOK_URL:        z.url(),
  DSERS_API_KEY:            z.string().min(1),
  CJ_DROPSHIPPING_API_KEY:  z.string().min(1),
  AUTODS_API_KEY:           z.string().min(1),
  ANTHROPIC_API_KEY:        z.string().min(1),
  LOOP_RETURNS_API_KEY:     z.string().min(1),
  REDIS_URL:                z.string().min(1),
  DATABASE_URL:             z.string().min(1),
  REPORTS_API_KEY:          z.string().min(1),
  PORT:                     z.coerce.number().int().positive().default(3000),
  NODE_ENV:                 z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

const result = envSchema.safeParse(process.env);

if (!result.success) {
  process.stderr.write("Invalid environment variables:\n");
  process.stderr.write(JSON.stringify(result.error.flatten().fieldErrors, null, 2) + "\n");
  process.exit(1);
}

// result.success is true here (process.exit above handles the failure branch)
export const env: Env = result.data!;
