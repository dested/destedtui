// `destedtui --install-shell` on Linux: a marked block in ~/.zshrc.local that
// sources shell/destedtui.zsh. Not ~/.zshrc, which is a symlink into the
// machine-setup repo; that zshrc sources ~/.zshrc.local. Re-running replaces
// the block in place; --uninstall removes it. (Windows: shell/install.ps1.)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const BEGIN = "# >>> destedtui >>>";
const END = "# <<< destedtui <<<";

export function installZsh(uninstall: boolean): number {
  const rc = join(process.env.HOME || homedir(), ".zshrc.local");
  const integration = resolve(import.meta.dir, "..", "..", "shell", "destedtui.zsh");
  const existing = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  const re = new RegExp(`${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\n?`);
  const stripped = existing.replace(re, "");
  const had = stripped !== existing;

  console.log(`destedtui shell integration\n  file: ${rc}`);
  if (uninstall) {
    if (!had) console.log("  nothing installed, nothing to remove");
    else {
      writeFileSync(rc, stripped);
      console.log("  removed - open a new shell");
    }
    return 0;
  }

  const block = [
    BEGIN,
    "# Project picker: `proj` (alias `pj`) opens it, enter cds this shell there.",
    "# Also auto-launches when an interactive shell starts in the projects root.",
    "# Managed by: destedtui --install-shell   (remove: destedtui --install-shell --uninstall)",
    `[[ -r '${integration}' ]] && source '${integration}'`,
    END,
    "",
  ].join("\n");
  const body = stripped.length > 0 && !stripped.endsWith("\n") ? `${stripped}\n` : stripped;
  writeFileSync(rc, had ? existing.replace(re, block) : body + block);
  console.log(`  ${had ? "block updated" : "block added"}\n  sources: ${integration}`);
  console.log(`  root:    ${process.env.DESTEDTUI_PROJECTS_ROOT || "/w/code"}`);
  console.log("  open a new shell in the projects root, or type proj");
  return 0;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
