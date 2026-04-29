import { env } from "../config/env";
import { httpPost, type HttpError } from "../lib/http";
import { type Result } from "../lib/result";

const BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-02-15";

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Klaviyo-API-Key ${env.KLAVIYO_API_KEY}`,
    revision: REVISION,
  };
}

/**
 * Add a customer profile to a Klaviyo list (e.g. post-purchase sequence).
 */
export async function addProfileToList(
  listId: string,
  profileId: string,
): Promise<Result<unknown, HttpError>> {
  return httpPost(
    `${BASE}/lists/${listId}/relationships/profiles/`,
    { data: [{ type: "profile", id: profileId }] },
    authHeaders(),
  );
}

/**
 * Create a Klaviyo event to trigger an event-based flow (e.g. abandoned cart,
 * post-purchase). `properties` are merged into the event payload.
 */
export async function trackEvent(
  eventName: string,
  customerEmail: string,
  properties: Record<string, unknown> = {},
): Promise<Result<unknown, HttpError>> {
  const body = {
    data: {
      type: "event",
      attributes: {
        metric: { data: { type: "metric", attributes: { name: eventName } } },
        profile: {
          data: {
            type: "profile",
            attributes: { email: customerEmail },
          },
        },
        properties,
        time: new Date().toISOString(),
      },
    },
  };

  return httpPost(`${BASE}/events/`, body, authHeaders());
}

/**
 * Trigger the post-purchase Klaviyo flow for a fulfilled order.
 */
export async function triggerPostPurchaseFlow(
  customerEmail: string,
  orderId: string,
): Promise<Result<unknown, HttpError>> {
  return trackEvent("Order Fulfilled", customerEmail, { orderId });
}

/**
 * Trigger the abandoned cart Klaviyo flow.
 */
export async function triggerAbandonedCartFlow(
  customerEmail: string,
  cartToken: string,
): Promise<Result<unknown, HttpError>> {
  return trackEvent("Checkout Abandoned", customerEmail, { cartToken });
}
