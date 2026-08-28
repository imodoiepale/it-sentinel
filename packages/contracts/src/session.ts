import { z } from "zod";

/** The remote-session broker contract. Note what is absent: no credential field, ever. */
export const SessionRequest = z.object({
  assetId: z.string().uuid(),
  operatorId: z.string().uuid(),
  ticketRef: z.string().optional(),
  reason: z.string().min(3),
  mode: z.enum(["view", "control"]),
});
export type SessionRequest = z.infer<typeof SessionRequest>;

export const SessionGrant = z.object({
  sessionId: z.string().uuid(),
  relayUrl: z.string().url(),
  singleUseToken: z.string(),
  expiresAt: z.string().datetime(),
  mode: z.enum(["view", "control"]),
  recorded: z.literal(true),
});
export type SessionGrant = z.infer<typeof SessionGrant>;
