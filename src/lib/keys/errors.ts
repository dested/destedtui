/** A mistake on the caller's side (exit 1), as opposed to a provider failure (exit 2). */
export class UserError extends Error {}

/** The provider's API refused or failed (exit 2). */
export class ProviderError extends Error {}
