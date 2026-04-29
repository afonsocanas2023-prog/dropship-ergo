import { env } from "../config/env";
import { httpGet, httpPost, httpPut, type HttpError } from "../lib/http";
import { type Result } from "../lib/result";
import type { GorgiasTicket } from "../types";

// Gorgias uses basic auth: base64("email:api_key") — derived from the API key
// which encodes as "account_email:api_key" in the Gorgias developer docs.
// We embed the full base64 token directly in GORGIAS_API_KEY.
function authHeaders(): Record<string, string> {
  return { Authorization: `Basic ${env.GORGIAS_API_KEY}` };
}

// The Gorgias domain is embedded in the API key env var comment; here we
// derive the base URL from the shop domain for consistency.
const BASE = `https://${env.SHOPIFY_SHOP_DOMAIN.split(".")[0]}.gorgias.com/api`;

interface GorgiasTicketEnvelope {
  id: number;
  status: string;
  tags: Array<{ name: string }>;
  customer: { id: number; email: string } | null;
  messages_count: number;
}

export async function getTicket(
  ticketId: number,
): Promise<Result<GorgiasTicket, HttpError>> {
  return httpGet<GorgiasTicket>(`${BASE}/tickets/${ticketId}`, authHeaders());
}

export async function applyMacro(
  ticketId: number,
  macroId: number,
): Promise<Result<GorgiasTicketEnvelope, HttpError>> {
  return httpPost<GorgiasTicketEnvelope>(
    `${BASE}/tickets/${ticketId}/macros`,
    { macro_id: macroId },
    authHeaders(),
  );
}

export async function closeTicket(
  ticketId: number,
): Promise<Result<GorgiasTicketEnvelope, HttpError>> {
  return httpPut<GorgiasTicketEnvelope>(
    `${BASE}/tickets/${ticketId}`,
    { status: "closed" },
    authHeaders(),
  );
}

export async function addTags(
  ticketId: number,
  tags: string[],
): Promise<Result<GorgiasTicketEnvelope, HttpError>> {
  const existing = await getTicket(ticketId);
  if (!existing.ok) return existing;

  const merged = [
    ...existing.value.tags.map((t) => ({ name: t.name })),
    ...tags.map((name) => ({ name })),
  ];

  return httpPut<GorgiasTicketEnvelope>(
    `${BASE}/tickets/${ticketId}`,
    { tags: merged },
    authHeaders(),
  );
}

export async function assignToTeam(
  ticketId: number,
  teamId: number,
): Promise<Result<GorgiasTicketEnvelope, HttpError>> {
  return httpPut<GorgiasTicketEnvelope>(
    `${BASE}/tickets/${ticketId}`,
    { assignee_team: { id: teamId } },
    authHeaders(),
  );
}

export async function createReply(
  ticketId: number,
  bodyHtml: string,
  options: { internal?: boolean } = {},
): Promise<Result<unknown, HttpError>> {
  return httpPost(
    `${BASE}/tickets/${ticketId}/messages`,
    {
      channel: "email",
      via: "helpdesk",
      source: { type: "helpdesk" },
      body_html: bodyHtml,
      internal: options.internal ?? false,
    },
    authHeaders(),
  );
}

export async function escalateToHuman(
  ticketId: number,
  teamId: number,
): Promise<Result<GorgiasTicketEnvelope, HttpError>> {
  return httpPut<GorgiasTicketEnvelope>(
    `${BASE}/tickets/${ticketId}`,
    { status: "open", assignee_team: { id: teamId } },
    authHeaders(),
  );
}
