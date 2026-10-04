import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { SPINNER_FRAMES, T } from "../theme.ts";
import { Footer } from "../components/Footer.tsx";
import { ActionBar, btn } from "../components/ActionBar.tsx";
import { fit, pad } from "../lib/text.ts";
import { readVault } from "../lib/keys/vault.ts";
import { fetchUsage, DEFAULT_DAYS } from "../lib/keys/usage/index.ts";
import { isStale, readUsageCache, STALE_MS, type UsageCache } from "../lib/keys/usage/cache.ts";
import { cachedDrydock, ddMark, deployedFolders } from "../lib/keys/deployed.ts";
import { ago, buildView, money, sparkline, units, type KeyLine, type Money, type UsageLine } from "../lib/keys/usage/view.ts";

const ACCENT = T.orange;

interface Props {
  /** Back to the key list (u / esc). */
  close: () => void;
}

const NUM_W = 10;
const SPARK_W = 10;
const PROV_W = 13;
const USED_W = 10;
const DETAIL_ROWS = 4;

function cells(m: Money | null, u: (Money & { unit: string }) | null): { d24: string; today: string; win: string; spark: string } {
  if (m) return { d24: money(m.d24), today: money(m.today), win: money(m.window), spark: sparkline(m.series) };
  if (u) return { d24: units(u.d24, u.unit), today: units(u.today, u.unit), win: units(u.window, u.unit), spark: sparkline(u.series) };
  return { d24: "", today: "", win: "", spark: "" };
}

/** Owner label with [dd] on every project deployed on Drydock. */
function ownerLabel(l: UsageLine, deployed: ReturnType<typeof deployedFolders>): string {
  if (l.kind === "project") return `${l.label}${ddMark(deployed, l.label)}`;
  if (l.kind === "shared") return `⚠ shared × ${l.projects.length}: ${l.projects.map((p) => `${p}${ddMark(deployed, p)}`).join(", ")}`;
  return l.label;
}

function labelColor(l: UsageLine): string {
  if (l.kind === "shared") return T.red;
  if (l.kind === "project") return T.fg;
  return T.dim;
}

/**
 * The Usage view of the Keys screen: spend per owner (project, shared group,
 * unmatched key, account), hottest first. Reads the 15-minute cache on mount and
 * refetches in the background when it's stale; `r` refetches now.
 */
export function KeysUsage({ close }: Props) {
  const [cache, setCache] = useState<UsageCache | null>(() => readUsageCache());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [top, setTop] = useState(0);
  const [frame, setFrame] = useState(0);
  const inflight = useRef(false);
  const { width, height } = useTerminalDimensions();

  const refresh = () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    fetchUsage(DEFAULT_DAYS)
      .then(setCache)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        inflight.current = false;
        setBusy(false);
      });
  };

  useEffect(() => {
    if (isStale(readUsageCache(), DEFAULT_DAYS)) refresh();
    const t = setInterval(refresh, STALE_MS);
    const spin = setInterval(() => setFrame((f) => f + 1), 120);
    return () => {
      clearInterval(t);
      clearInterval(spin);
    };
  }, []);

  const deployed = useMemo(() => {
    try {
      return deployedFolders(cachedDrydock(readVault()));
    } catch {
      return deployedFolders(null);
    }
  }, []);
  const view = useMemo(() => {
    if (!cache) return null;
    try {
      return buildView(cache, readVault());
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [cache]);
  const lines = view && typeof view !== "string" ? view.lines : [];
  const sel = Math.min(selected, Math.max(0, lines.length - 1));
  const current = lines[sel] ?? null;

  // --- geometry ---------------------------------------------------------------
  const inner = Math.max(60, width - 6);
  const labelW = Math.max(16, inner - 2 - 3 * NUM_W - 2 - SPARK_W - PROV_W - USED_W);
  // header 3 + panel border 2 + summary + column header + detail block + status + margins/footer 2
  const visRows = Math.max(3, height - 11 - DETAIL_ROWS); // + the action bar
  const topRow = Math.min(Math.max(Math.min(top, Math.max(0, lines.length - visRows)), sel - visRows + 1), sel);
  useEffect(() => {
    if (topRow !== top) setTop(topRow);
  }, [topRow, top]);

  useKeyboard((key) => {
    if (key.ctrl) return;
    if (key.name === "escape" || key.sequence === "u" || key.sequence === "q") return close();
    if (key.name === "up") return setSelected((s) => Math.max(0, Math.min(s, lines.length - 1) - 1));
    if (key.name === "down") return setSelected((s) => Math.min(lines.length - 1, s + 1));
    if (key.name === "pageup") return setSelected((s) => Math.max(0, s - visRows));
    if (key.name === "pagedown") return setSelected((s) => Math.min(lines.length - 1, s + visRows));
    if (key.sequence === "r") return refresh();
  });

  const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";
  const days = view && typeof view !== "string" ? view.days : DEFAULT_DAYS;
  const header = `  ${pad("owner", labelW)}${"24h≈".padStart(NUM_W)}${"today".padStart(NUM_W)}${`${days}d`.padStart(NUM_W)}  ${pad(`last ${days}d`, SPARK_W)}${pad("providers", PROV_W)}${pad("used", USED_W)}`;

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" keys · usage "
        style={{
          flexGrow: 1,
          flexDirection: "column",
          border: true,
          borderStyle: "rounded",
          borderColor: error ? T.red : T.border,
          titleColor: ACCENT,
          margin: 1,
          marginTop: 0,
          padding: 1,
          paddingTop: 0,
          paddingBottom: 0,
          backgroundColor: T.panel,
        }}
      >
        <UsageSummary width={inner} view={view} />
        <text fg={T.dim}>{pad(header, inner)}</text>
        <box style={{ flexDirection: "column", height: visRows, width: inner, flexShrink: 0, backgroundColor: T.panel }}>
          {typeof view === "string" ? (
            <text fg={T.red}>{pad(`✗ ${view}`, inner)}</text>
          ) : !view ? (
            <text fg={T.dim}>{pad(busy ? "fetching usage from every provider…" : "no usage cached yet — ↻ refresh fetches it", inner)}</text>
          ) : lines.length === 0 ? (
            <text fg={T.dim}>{pad(`nothing reported in the last ${days} days`, inner)}</text>
          ) : (
            lines.slice(topRow, topRow + visRows).map((l, i) => {
              const idx = topRow + i;
              const isSel = idx === sel;
              const c = cells(l.usd, l.units);
              const hot = (l.usd?.d24 ?? 0) >= 1;
              return (
                <box
                  key={l.key}
                  style={{ flexDirection: "row", height: 1, width: inner, backgroundColor: isSel ? T.selectionBg : T.panel }}
                  onMouseOver={() => setSelected(idx)}
                >
                  <text>
                    <span fg={isSel ? ACCENT : T.dim}>{isSel ? "❯ " : "  "}</span>
                    <span fg={labelColor(l)}>{pad(ownerLabel(l, deployed), labelW)}</span>
                    <span fg={hot ? T.yellow : c.d24 === "$0" || !c.d24 ? T.dim : T.fg}>{c.d24.padStart(NUM_W)}</span>
                    <span fg={T.fg}>{c.today.padStart(NUM_W)}</span>
                    <span fg={T.fg}>{c.win.padStart(NUM_W)}</span>
                    <span>{"  "}</span>
                    <span fg={T.cyan}>{pad(c.spark, SPARK_W)}</span>
                    <span fg={T.dim}>{pad(l.providers.join("+"), PROV_W)}</span>
                    <span fg={T.dim}>{pad(ago(l.lastUsedAt), USED_W)}</span>
                  </text>
                </box>
              );
            })
          )}
        </box>
        <Detail line={current} width={inner} />
        <ActionBar width={inner} items={[btn(busy ? `${spin} fetching…` : "↻ refresh now", T.cyan, refresh)]} trailing={[btn("← back to keys", T.dim, close)]} />
        <text fg={busy ? T.yellow : error ? T.red : T.dim}>
          {pad(
            busy
              ? `${spin} fetching usage…`
              : error
                ? `✗ ${error}`
                : view && typeof view !== "string"
                  ? `fetched ${ago(view.fetchedAt)} · refreshes every 15 min · 24h is estimated from UTC day buckets · no secrets in usage.json`
                  : "",
            inner,
          )}
        </text>
      </box>
      <Footer
        hints={[
          ["click", "anything"],
          ["↑↓", "select"],
          ["esc", "back"],
        ]}
      />
    </box>
  );
}

function UsageSummary({ width, view }: { width: number; view: ReturnType<typeof buildView> | string | null }) {
  if (!view || typeof view === "string") return <text fg={T.dim}>{pad("", width)}</text>;
  const shared = view.lines.filter((l) => l.kind === "shared" && (l.usd?.window ?? l.units?.window ?? 0) > 0).length;
  const left = `${money(view.total.d24)} last 24h · ${money(view.total.window)} in ${view.days}d`;
  const warn = shared ? ` · ⚠ ${shared} shared key${shared === 1 ? "" : "s"} spending` : "";
  const status = view.providers
    .filter((p) => p.status !== "no-api")
    .map((p) => `${p.id} ${p.status === "ok" ? (p.scope === "per-key" ? "✓" : "acct") : p.status === "needs-admin" ? "needs admin" : "✗"}`)
    .join(" · ");
  const right = fit(status, Math.max(0, width - left.length - warn.length - 2));
  return (
    <box style={{ flexDirection: "row", height: 1, width }}>
      <text>
        <span fg={T.fg}>{left}</span>
        <span fg={T.red}>{warn}</span>
        <span>{" ".repeat(Math.max(1, width - left.length - warn.length - right.length))}</span>
        <span fg={T.dim}>{right}</span>
      </text>
    </box>
  );
}

/** The selected owner's keys, one per line — where a shared group's money actually comes from. */
function Detail({ line, width }: { line: UsageLine | null; width: number }) {
  const rows: { text: string; color: string }[] = [];
  if (line) {
    const what =
      line.kind === "shared"
        ? `one key live in ${line.projects.length} projects — usage can't be split between them; give each its own key (keys new … --replace)`
        : line.kind === "unmatched"
          ? "a key the vault doesn't know (deleted, ephemeral, or made in a console and never added)"
          : line.kind === "account"
            ? "usage the provider credits to no API key (web app, console, playground)"
            : `${line.projects[0] ?? ""}'s own key${line.keys.length === 1 ? "" : "s"}`;
    rows.push({ text: what, color: line.kind === "shared" ? T.red : T.dim });
    for (const k of line.keys.slice(0, DETAIL_ROWS - 1)) rows.push({ text: keyText(k), color: T.dim });
    if (line.keys.length > DETAIL_ROWS - 1) rows[rows.length - 1] = { text: `… and ${line.keys.length - (DETAIL_ROWS - 2)} more keys`, color: T.dim };
  }
  while (rows.length < DETAIL_ROWS) rows.push({ text: "", color: T.dim });
  return (
    <box style={{ flexDirection: "column", height: DETAIL_ROWS, width, flexShrink: 0, backgroundColor: T.panel }}>
      {rows.map((r, i) => (
        <text key={`d${i}`} fg={r.color}>
          {pad(i === 0 ? r.text : `  ${r.text}`, width)}
        </text>
      ))}
    </box>
  );
}

function keyText(k: KeyLine): string {
  const c = cells(k.usd, k.units);
  const id = k.vaultKeyIds[0] ?? (k.remoteKeyId ? `remote ${k.remoteKeyId.slice(0, 10)}` : "no key");
  const name = k.name ? ` "${k.name}"` : "";
  const how = k.matchedBy ? ` · matched by ${k.matchedBy}` : k.remoteKeyId ? " · not in vault" : "";
  const extra = [k.allocated && k.usd ? "allocated" : "", k.weekToDate ? "week-to-date" : ""].filter(Boolean).join(", ");
  return `${k.providerId} ${id}${name}: 24h ${c.d24 || "—"} · today ${c.today || "—"} · window ${c.win || "—"}${how}${extra ? ` · ${extra}` : ""}`;
}
