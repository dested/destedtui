import type { MintAdapter } from "./types.ts";
import { anthropic } from "./anthropic.ts";
import { elevenlabs } from "./elevenlabs.ts";
import { fal } from "./fal.ts";
import { openai } from "./openai.ts";
import { openrouter } from "./openrouter.ts";
import { xai } from "./xai.ts";

/** Every mint adapter, by id. A provider's `mint` field names one of these. */
export const ADAPTERS: ReadonlyMap<string, MintAdapter> = new Map(
  [anthropic, elevenlabs, fal, openai, openrouter, xai].map((a) => [a.id, a]),
);

export type { AdminInput, MintAdapter, MintContext, Minted } from "./types.ts";
