/**
 * Sizes and deletes ~/.bx/profiles off the UI thread (~800k files, ~13s to
 * size). Requests run one at a time, in order, so a delete never races a
 * scan of the same folder. Contract and fs work live in bxProfiles.ts.
 */
import { deleteProfile, listProfiles, ProfileReqSchema, sizeProfile, type ProfileMsg, type ProfileReq } from "./bxProfiles.ts";

declare const self: Worker;

const send = (m: ProfileMsg) => self.postMessage(m);

async function handle(req: ProfileReq): Promise<void> {
  if (req.type === "scan") {
    const started = performance.now();
    const names = req.names ?? (await listProfiles());
    if (!req.names) send({ type: "listed", names });
    for (const name of names) {
      const info = await sizeProfile(name);
      send(info ? { type: "sized", info } : { type: "gone", name });
    }
    send({ type: "scanned", ms: performance.now() - started, full: !req.names });
    return;
  }
  for (const name of req.names) send({ type: "deleted", name, error: await deleteProfile(name) });
  send({ type: "deleteDone" });
}

let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<unknown>) => {
  const req = ProfileReqSchema.safeParse(e.data);
  if (!req.success) return send({ type: "error", message: `bad request: ${req.error.message}` });
  queue = queue
    .then(() => handle(req.data))
    .catch((err: unknown) => send({ type: "error", message: err instanceof Error ? err.message : String(err) }));
};
