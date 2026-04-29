import Anthropic from "@anthropic-ai/sdk";
import type { ClassificationMethod, TicketCategory } from "@prisma/client";
import { env } from "../config/env";
import { logger } from "../lib/logger";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ── Keyword fast-path ─────────────────────────────────────────────────────────

const KEYWORD_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  { category: "WHERE_IS_ORDER",   pattern: /\b(where is|where's|tracking|order status|shipped|delivery|when will|when does)\b/i },
  { category: "CANCELLATION",     pattern: /\b(cancel|cancellation|cancel my order|want to cancel)\b/i },
  { category: "PRODUCT_QUESTION", pattern: /\b(how does|how do|compatible|specifications|spec|warranty|what is|does it|will it)\b/i },
  { category: "DAMAGE_CLAIM",     pattern: /\b(damaged|broken|defective|arrived broken|cracked|scratched|missing part)\b/i },
  { category: "RETURN_REQUEST",   pattern: /\b(return|refund|exchange|send back|give back)\b/i },
];

function matchKeywords(text: string): TicketCategory | null {
  for (const { category, pattern } of KEYWORD_PATTERNS) {
    if (pattern.test(text)) return category as TicketCategory;
  }
  return null;
}

// ── Claude fallback ───────────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set([
  "WHERE_IS_ORDER", "CANCELLATION", "PRODUCT_QUESTION",
  "DAMAGE_CLAIM", "RETURN_REQUEST", "UNKNOWN",
]);

async function classifyByClaude(subject: string, body: string): Promise<TicketCategory> {
  const prompt = `Classify this customer support ticket into exactly one category.

Categories: WHERE_IS_ORDER | CANCELLATION | PRODUCT_QUESTION | DAMAGE_CLAIM | RETURN_REQUEST | UNKNOWN

Subject: ${subject.slice(0, 200)}
Body: ${body.slice(0, 500)}

Reply with only the category name, nothing else.`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 20,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    if (VALID_CATEGORIES.has(text)) return text as TicketCategory;

    logger.warn("Claude returned unknown category", { text });
    return "UNKNOWN" as TicketCategory;
  } catch (e) {
    logger.error("Claude classification error", { error: String(e) });
    return "UNKNOWN" as TicketCategory;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function classify(
  subject: string,
  body: string,
): Promise<{ category: TicketCategory; method: ClassificationMethod }> {
  const keyword = matchKeywords(`${subject} ${body}`);
  if (keyword) return { category: keyword, method: "KEYWORD" as ClassificationMethod };

  const category = await classifyByClaude(subject, body);
  return { category, method: "AI" as ClassificationMethod };
}
