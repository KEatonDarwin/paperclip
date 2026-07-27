import { z } from "zod";
import { LLM_PROVIDERS } from "../constants.js";

export const createProviderModelSchema = z.object({
  provider: z.enum(LLM_PROVIDERS),
  modelKey: z.string().min(1),
  displayName: z.string().min(1),
  contextWindow: z.number().int().positive().optional().nullable(),
});

export type CreateProviderModel = z.infer<typeof createProviderModelSchema>;

export const updateProviderModelSchema = z.object({
  displayName: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional().nullable(),
});

export type UpdateProviderModel = z.infer<typeof updateProviderModelSchema>;
