import type { PackageInfo } from "./lib/discovery.ts";

export type Route =
  | { name: "menu" }
  | { name: "scripts" }
  | { name: "process"; pkg: PackageInfo; script: string }
  | { name: "backup" }
  | { name: "restore" };
