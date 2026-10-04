import type { z } from "zod";
import { ProviderError } from "../errors.ts";

/** The admin/management credential an adapter acts with. Never written to any .env. */
export interface AdminInput {
  value: string;
  meta: Record<string, string>;
}

export interface MintContext {
  /** Project slug the key is for — adapters put it in the remote key's name. */
  project: string;
  label: string;
}

export interface Minted {
  value: string;
  /** Whatever `revoke` needs later; adapters encode compound ids as `a/b`. */
  remoteId: string;
  /** One human line about where the key was made ("service account in project Default"). */
  note: string;
}

/**
 * One provider's admin API. Adding a provider that can mint = one new file
 * exporting this shape + one line in ./index.ts.
 */
export interface MintAdapter {
  id: string;
  /** Where a human makes the admin credential this adapter needs. */
  adminConsoleUrl: string;
  /** What that credential is called on the provider's side ("Admin key", "Management key"). */
  adminKind: string;
  /** User env var the admin credential may also come from when the vault has none. */
  adminEnvVar?: string;
  /** Absent when the provider's API can't create keys (Anthropic). */
  mint?: (admin: AdminInput, ctx: MintContext) => Promise<Minted>;
  revoke?: (admin: AdminInput, remoteId: string) => Promise<void>;
  /** Resolve the remote id of a key known only by value (pasted/imported), when the API allows it. */
  locate?: (admin: AdminInput, value: string) => Promise<string | undefined>;
}

/** Remote key names: `keys-<project>-<label>`, trimmed to something every provider accepts. */
export function remoteName(ctx: MintContext): string {
  const label = ctx.label ? `-${ctx.label}` : "";
  return `keys-${ctx.project}${label}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
}

/** Pull a readable message out of an error body without ever echoing a success payload. */
function errorText(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return "(unreadable body)";
  }
}

/**
 * fetch + JSON + zod. Non-2xx → ProviderError with the provider's own message.
 * A 2xx body that fails the schema is reported by shape only — it may hold a key.
 */
export async function call<S extends z.ZodType>(url: string, init: RequestInit, schema: S): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ProviderError(`${init.method ?? "GET"} ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body: keep the text for the error message */
  }
  if (!res.ok) throw new ProviderError(`${init.method ?? "GET"} ${new URL(url).pathname} → HTTP ${res.status}: ${errorText(body)}`);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ProviderError(`${init.method ?? "GET"} ${new URL(url).pathname} returned an unexpected shape (${issues})`);
  }
  return parsed.data;
}

export function json(method: string, headers: Record<string, string>, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

/** Split `a/b` compound remote ids; throws a ProviderError naming the adapter when malformed. */
export function splitRemote(adapter: string, remoteId: string): [string, string] {
  const i = remoteId.indexOf("/");
  if (i <= 0 || i === remoteId.length - 1) throw new ProviderError(`${adapter}: malformed remote id "${remoteId}"`);
  return [remoteId.slice(0, i), remoteId.slice(i + 1)];
}
