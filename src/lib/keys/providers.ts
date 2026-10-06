import type { Provider } from "./vault.ts";

/**
 * Built-in providers. `mint` names an adapter in ./adapters; a provider without
 * one is console-only (open consoleUrl, then `keys add --clipboard`).
 * Researched 2026-10-03 — see features/keys.md "Provider admin APIs".
 */
export const BUILTIN_PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    aliases: ["CLAUDE_API_KEY"],
    prefixes: ["sk-ant-api"],
    consoleUrl: "https://platform.claude.com/settings/keys",
    // Admin API lists/updates/archives keys but cannot create them: the adapter only revokes.
    mint: "anthropic",
    builtin: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    envVar: "OPENAI_API_KEY",
    aliases: [],
    prefixes: ["sk-proj-", "sk-svcacct-"],
    consoleUrl: "https://platform.openai.com/api-keys",
    mint: "openai",
    builtin: true,
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    envVar: "ELEVENLABS_API_KEY",
    aliases: ["ELEVEN_API_KEY", "XI_API_KEY", "ELEVENLABS_KEY"],
    prefixes: [],
    consoleUrl: "https://elevenlabs.io/app/settings/api-keys",
    mint: "elevenlabs",
    builtin: true,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    aliases: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_AI_API_KEY"],
    prefixes: [], // "AIza" is every Google API key (Maps too) — match by var name only
    consoleUrl: "https://aistudio.google.com/apikey",
    builtin: true,
  },
  {
    id: "xai",
    name: "xAI",
    envVar: "XAI_API_KEY",
    aliases: ["GROK_API_KEY"],
    prefixes: ["xai-"],
    consoleUrl: "https://console.x.ai/team/default/api-keys",
    mint: "xai",
    builtin: true,
  },
  {
    id: "groq",
    name: "Groq",
    envVar: "GROQ_API_KEY",
    aliases: [],
    prefixes: ["gsk_"],
    consoleUrl: "https://console.groq.com/keys",
    builtin: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    aliases: [],
    prefixes: ["sk-or-v1-"],
    consoleUrl: "https://openrouter.ai/settings/keys",
    mint: "openrouter",
    builtin: true,
  },
  {
    id: "replicate",
    name: "Replicate",
    envVar: "REPLICATE_API_TOKEN",
    aliases: ["REPLICATE_API_KEY"],
    prefixes: ["r8_"],
    consoleUrl: "https://replicate.com/account/api-tokens",
    builtin: true,
  },
  {
    id: "fal",
    name: "fal",
    envVar: "FAL_KEY",
    aliases: ["FAL_API_KEY", "FAL_AI_API_KEY"],
    prefixes: [],
    consoleUrl: "https://fal.ai/dashboard/keys",
    mint: "fal",
    builtin: true,
  },
  {
    // TypeSafe AI's Jev (System One). Env var from the SDK constants (typesafe_sdk.constants.API_KEY_ENV).
    // No key-management API (2026-10-06): console-only.
    id: "typesafe",
    name: "TypeSafe (Jev)",
    envVar: "TYPESAFE_API_KEY",
    aliases: ["JEV_API_KEY", "TYPESAFE_KEY"],
    prefixes: [],
    consoleUrl: "https://console.typesafe.ai/keys",
    builtin: true,
  },
];

/** Other names a built-in provider answers to on the command line (`keys new jev`). */
export const PROVIDER_ID_ALIASES: Readonly<Record<string, string>> = {
  jev: "typesafe",
};
