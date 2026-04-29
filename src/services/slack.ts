import { env } from "../config/env";
import { httpPost, type HttpError } from "../lib/http";
import { type Result } from "../lib/result";

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
}

interface AlertOptions {
  fields?: Record<string, string>;
  urgent?: boolean;
}

function buildBlocks(message: string, fields?: Record<string, string>): SlackBlock[] {
  const blocks: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: message } },
  ];

  if (fields && Object.keys(fields).length > 0) {
    blocks.push({
      type: "section",
      fields: Object.entries(fields).map(([k, v]) => ({
        type: "mrkdwn",
        text: `*${k}:*\n${v}`,
      })),
    });
  }

  return blocks;
}

export async function sendAlert(
  message: string,
  options: AlertOptions = {},
): Promise<Result<unknown, HttpError>> {
  const text = options.urgent ? `:rotating_light: ${message}` : message;

  return httpPost(env.SLACK_WEBHOOK_URL, {
    text,
    blocks: buildBlocks(text, options.fields),
  });
}

export async function sendOrderAlert(
  message: string,
  orderId: string,
  extra?: Record<string, string>,
): Promise<Result<unknown, HttpError>> {
  return sendAlert(message, {
    fields: { "Order ID": orderId, ...extra },
    urgent: true,
  });
}

export async function sendStockAlert(
  supplierSku: string,
  supplierCode: string,
  quantity: number,
): Promise<Result<unknown, HttpError>> {
  return sendAlert(`:warning: Stock alert for *${supplierSku}*`, {
    fields: { Supplier: supplierCode, "Current Stock": String(quantity) },
  });
}
