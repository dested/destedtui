// One project's Claude spend, computed in usageWorker.ts so the panel never
// blocks on the 16 MB usage cache.

import { z } from "zod";

export const usageMsgSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("usage"),
    week: z.number(),
    month: z.number(),
    all: z.number(),
    sessions30: z.number(),
    /** unix seconds of the last message, 0 = never */
    lastTs: z.number(),
    /** daily cost over the last 30 days */
    series: z.array(z.number()),
  }),
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type UsageMsg = z.infer<typeof usageMsgSchema>;
export type ProjectUsage = Extract<UsageMsg, { type: "usage" }>;

/** Ask the worker once; resolves with its answer (never rejects). */
export function projectUsage(name: string): Promise<UsageMsg> {
  return new Promise((done) => {
    let w: Worker;
    try {
      w = new Worker(new URL("./usageWorker.ts", import.meta.url).href);
    } catch (err) {
      return done({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    w.onmessage = (e: MessageEvent<unknown>) => {
      const parsed = usageMsgSchema.safeParse(e.data);
      done(parsed.success ? parsed.data : { type: "error", message: "bad worker message" });
      w.terminate();
    };
    w.onerror = (e) => {
      done({ type: "error", message: e.message });
      w.terminate();
    };
    w.postMessage(name);
  });
}
