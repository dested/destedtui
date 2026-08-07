import type { PackageInfo } from "./lib/discovery.ts";
import type { RestoreMode } from "./lib/restore.ts";
import type { ReviewScope } from "./lib/review.ts";

export type Route =
  | { name: "menu" }
  | { name: "scripts" }
  | { name: "process"; pkg: PackageInfo; script: string }
  | { name: "backup"; presetUrl?: string; presetLabel?: string }
  | { name: "restore"; preset?: { url: string; mode: RestoreMode; label: string } }
  | { name: "localdb" }
  | { name: "pull" }
  | { name: "startup" }
  | { name: "term" }
  | { name: "projects" }
  | { name: "review"; scope?: ReviewScope; autoStart?: boolean };
