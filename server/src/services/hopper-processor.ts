import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { hopperService } from "./hopper.js";

const classifyResponseSchema = z.object({
  kind: z.enum(["bug", "feature"]).nullable(),
  has_info: z.boolean(),
  question: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
});

const SYSTEM_PROMPT = `You are a product intake assistant for a software project management tool.
Your job is to classify a user's idea or bug report and determine if it has enough context to create an actionable issue.

You must respond with a JSON object that has exactly these fields:
- kind: "bug" or "feature" or null (if unclear)
- has_info: boolean — true if the prompt has enough context to create a clear, actionable issue
- question: string or null — if has_info is false, ONE short clarifying question that would unlock the missing context. If has_info is true, set this to null.
- title: string or null — if has_info is true, a concise issue title (under 100 chars). If has_info is false, set this to null.
- description: string or null — if has_info is true, a clear issue description in markdown. If has_info is false, set this to null.

Respond ONLY with valid JSON. No explanation, no markdown fences.`;

export function hopperProcessor(db: Db) {
  const svc = hopperService(db);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const ctoAgentId = "d33e935d-533f-45a1-bb7a-ee4a2c86b2d8";

  async function processItem(itemId: string): Promise<void> {
    const item = await svc.getById(itemId);
    if (!item) return;

    const threads = await svc.listThreads(itemId);

    // Build conversation context
    const messages: { role: "user" | "assistant"; content: string }[] = [];
    messages.push({ role: "user", content: item.prompt });
    for (const t of threads) {
      const role = t.authorType === "agent" ? "assistant" : "user";
      messages.push({ role, content: t.body });
    }

    let raw: string;
    try {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
      });
      raw = response.content[0].type === "text" ? response.content[0].text : "";
    } catch {
      // On API failure, ask a fallback question
      await svc.update(itemId, { status: "needs_info" });
      await svc.addThread({
        itemId,
        authorType: "agent",
        authorId: ctoAgentId,
        body: "Could you provide more details about what you'd like to achieve and any relevant context?",
      });
      return;
    }

    let parsed: z.infer<typeof classifyResponseSchema>;
    try {
      parsed = classifyResponseSchema.parse(JSON.parse(raw));
    } catch {
      // Parse failure — ask fallback question
      await svc.update(itemId, { status: "needs_info" });
      await svc.addThread({
        itemId,
        authorType: "agent",
        authorId: ctoAgentId,
        body: "Could you provide more details about what you'd like to achieve and any relevant context?",
      });
      return;
    }

    if (!parsed.has_info) {
      await svc.update(itemId, {
        status: "needs_info",
        kind: parsed.kind ?? null,
        question: parsed.question ?? null,
      });
      if (parsed.question) {
        await svc.addThread({
          itemId,
          authorType: "agent",
          authorId: ctoAgentId,
          body: parsed.question,
        });
      }
      return;
    }

    // Create the issue via Paperclip API
    const apiUrl = process.env.PAPERCLIP_API_URL ?? "http://localhost:3100";
    const apiKey = process.env.PAPERCLIP_API_KEY;

    let linkedIssueId: string | undefined;
    let linkedIssueIdentifier: string | undefined;

    try {
      const resp = await fetch(`${apiUrl}/api/companies/${item.companyId}/issues`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          title: parsed.title,
          description: parsed.description,
          assigneeAgentId: ctoAgentId,
          status: "todo",
          priority: parsed.kind === "bug" ? "high" : "medium",
        }),
      });

      if (resp.ok) {
        const issue = await resp.json() as { id: string; identifier: string };
        linkedIssueId = issue.id;
        linkedIssueIdentifier = issue.identifier;
      }
    } catch {
      // Issue creation failed — still mark created without a link
    }

    await svc.update(itemId, {
      status: "created",
      kind: parsed.kind ?? null,
      linkedIssueId: linkedIssueId ?? null,
      linkedIssueIdentifier: linkedIssueIdentifier ?? null,
    });
  }

  return { process: processItem };
}
