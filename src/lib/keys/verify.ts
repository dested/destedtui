// Does a key work? One cheap authenticated read per provider (list models, /key,
// /account). Only the status code is looked at; the body is never read out.

export interface Check {
  method: "GET";
  url: string;
  headers: (value: string) => Record<string, string>;
}

const bearer = (v: string) => ({ Authorization: `Bearer ${v}` });

export const CHECKS: Record<string, Check> = {
  openai: { method: "GET", url: "https://api.openai.com/v1/models", headers: bearer },
  anthropic: { method: "GET", url: "https://api.anthropic.com/v1/models?limit=1", headers: (v) => ({ "x-api-key": v, "anthropic-version": "2023-06-01" }) },
  elevenlabs: { method: "GET", url: "https://api.elevenlabs.io/v1/models", headers: (v) => ({ "xi-api-key": v }) },
  gemini: { method: "GET", url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: (v) => ({ "x-goog-api-key": v }) },
  xai: { method: "GET", url: "https://api.x.ai/v1/api-key", headers: bearer },
  groq: { method: "GET", url: "https://api.groq.com/openai/v1/models", headers: bearer },
  openrouter: { method: "GET", url: "https://openrouter.ai/api/v1/key", headers: bearer },
  replicate: { method: "GET", url: "https://api.replicate.com/v1/account", headers: bearer },
};

export interface VerifyResult {
  ok: boolean;
  /** No cheap check exists for this provider (fal, custom): not a failure, but not proof either. */
  skipped: boolean;
  note: string;
}

/** What `verify` would call, for dry runs. */
export function describeCheck(providerId: string): string {
  const c = CHECKS[providerId];
  return c ? `${c.method} ${new URL(c.url).host}${new URL(c.url).pathname}` : "no cheap auth check for this provider — test it in the app";
}

/**
 * Call the provider with the key. A freshly minted key can take a few seconds to
 * propagate, so a 401 is retried twice before it counts.
 */
export async function verifyKey(providerId: string, value: string, opts: { retries?: number } = {}): Promise<VerifyResult> {
  const c = CHECKS[providerId];
  if (!c) return { ok: true, skipped: true, note: describeCheck(providerId) };
  const tries = (opts.retries ?? 2) + 1;
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(c.url, { method: c.method, headers: c.headers(value), signal: AbortSignal.timeout(15_000) });
      await res.body?.cancel();
      if (res.ok) return { ok: true, skipped: false, note: `${describeCheck(providerId)} → ${res.status}` };
      last = `${describeCheck(providerId)} → HTTP ${res.status}`;
      if (res.status !== 401 && res.status !== 403) break;
    } catch (err) {
      last = `${describeCheck(providerId)} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (i < tries - 1) await Bun.sleep(3000);
  }
  return { ok: false, skipped: false, note: last };
}
