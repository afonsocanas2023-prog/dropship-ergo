import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env";

export const QUEUE_NAMES = {
  EVENT_BUS:            "event-bus",
  ORDER_ROUTER:         "order-router",
  INVENTORY_SYNC:       "inventory-sync",
  TICKET_CLASSIFIER:    "ticket-classifier",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// maxRetriesPerRequest: null is required by BullMQ for blocking commands
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export function makeQueue<T>(name: string): Queue<T> {
  return new Queue<T>(name, { connection: redis });
}
