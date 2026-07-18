import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { T } from "../theme.ts";
import { ListPicker } from "../components/ListPicker.tsx";
import { Footer } from "../components/Footer.tsx";
import { fmtBytes, msg } from "../lib/pgtools.ts";
import type { Route } from "../routes.ts";
import {
  loadLocalConn,
  saveLocalConn,
  parseLocalConn,
  localPgConn,
  describeLocal,
  listLocalDatabases,
  createLocalDatabase,
  dropLocalDatabase,
  type LocalConn,
  type LocalDbInfo,
} from "../lib/pglocal.ts";

interface Props {
  go: (route: Route) => void;
  back: () => void;
}

type Phase = "connect" | "list" | "create" | "editconn" | "dbmenu" | "dropconfirm" | "working" | "error";

export function LocalDb({ go, back }: Props) {
  const [local, setLocal] = useState<LocalConn>(() => loadLocalConn());
  const [phase, setPhase] = useState<Phase>("connect");
  const [dbs, setDbs] = useState<LocalDbInfo[]>([]);
  const [selected, setSelected] = useState<LocalDbInfo | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [dropText, setDropText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [working, setWorking] = useState("");

  const refresh = (conn = local) => {
    setPhase("connect");
    listLocalDatabases(localPgConn(conn))
      .then((found) => {
        setDbs(found);
        setPhase("list");
      })
      .catch((err) => {
        setErrorText(`Couldn't reach ${describeLocal(conn)}\n${msg(err)}`);
        setPhase("error");
      });
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doCreate = (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    setWorking(`Creating "${name}"...`);
    setPhase("working");
    createLocalDatabase(localPgConn(local), name)
      .then(() => refresh())
      .catch((err) => {
        setErrorText(msg(err));
        setPhase("error");
      });
  };

  const doDrop = (name: string) => {
    setWorking(`Dropping "${name}"...`);
    setPhase("working");
    dropLocalDatabase(localPgConn(local), name)
      .then(() => refresh())
      .catch((err) => {
        setErrorText(msg(err));
        setPhase("error");
      });
  };

  const saveConn = (raw: string) => {
    const trimmed = raw.trim();
    let next = local;
    if (trimmed) {
      try {
        next = parseLocalConn(trimmed);
      } catch {
        setErrorText(`Not a valid postgres URL: ${trimmed}`);
        setPhase("error");
        return;
      }
    }
    setLocal(next);
    saveLocalConn(next);
    refresh(next);
  };

  useKeyboard((key) => {
    if (key.name === "return" && phase === "error") {
      // error while connecting → let them edit the connection
      setUrlInput("");
      setPhase("editconn");
      return;
    }
    if (phase === "list") {
      if (key.name === "c") {
        setNameInput("");
        setPhase("create");
      } else if (key.name === "e") {
        setUrlInput("");
        setPhase("editconn");
      } else if (key.name === "r") {
        refresh();
      } else if (key.name === "escape") {
        back();
      }
      return;
    }
    if (key.name === "escape") {
      switch (phase) {
        case "create":
        case "editconn":
          setPhase("list");
          break;
        case "dbmenu":
          setPhase("list");
          break;
        case "dropconfirm":
          setDropText("");
          setPhase("dbmenu");
          break;
        case "error":
          back();
          break;
        default:
          back();
      }
    }
  });

  return (
    <box style={{ flexGrow: 1, flexDirection: "column" }}>
      <box
        title=" local postgres "
        style={{
          border: true,
          borderStyle: "rounded",
          borderColor: phase === "error" ? T.red : T.border,
          titleColor: T.green,
          margin: 1,
          marginTop: 0,
          padding: 1,
          flexGrow: 1,
          flexDirection: "column",
          backgroundColor: T.panel,
        }}
      >
        {phase === "connect" && <text fg={T.dim}>{`Connecting to ${describeLocal(local)}...`}</text>}
        {phase === "working" && <text fg={T.yellow}>{working}</text>}

        {phase === "list" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>{`${describeLocal(local)} · ${dbs.length} database${dbs.length === 1 ? "" : "s"}`}</text>
            <ListPicker
              vimKeys
              visible={13}
              emptyText="No databases — press c to create one"
              items={dbs.map((d) => ({
                id: d.name,
                icon: "⛁",
                title: d.name,
                subtitle: `${d.owner} · ${d.encoding}`,
                badge: fmtBytes(d.sizeBytes),
                badgeColor: T.dim,
              }))}
              onSelect={(item) => {
                const db = dbs.find((d) => d.name === item.id) ?? null;
                setSelected(db);
                setPhase("dbmenu");
              }}
            />
          </box>
        )}

        {phase === "dbmenu" && selected && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.fg}>{`${selected.name}  `}<span fg={T.dim}>{`${fmtBytes(selected.sizeBytes)} · ${selected.owner}`}</span></text>
            <ListPicker
              vimKeys
              items={[
                { id: "backup", icon: "⛁", title: "Back up to a zip", subtitle: "pg_dump → zip in the current folder", badge: "safe", badgeColor: T.green },
                { id: "restore", icon: "↺", title: "Restore a backup/file into it", subtitle: "overwrites this database", badge: "destructive", badgeColor: T.red },
                { id: "drop", icon: "✕", title: "Drop database", subtitle: "delete it permanently", badge: "destructive", badgeColor: T.red },
              ]}
              onSelect={(item) => {
                if (!selected) return;
                const url = localPgConn(local, selected.name).url;
                if (item.id === "backup") go({ name: "backup", presetUrl: url, presetLabel: selected.name });
                else if (item.id === "restore") go({ name: "restore", preset: { url, mode: "overwrite", label: selected.name } });
                else {
                  setDropText("");
                  setPhase("dropconfirm");
                }
              }}
            />
          </box>
        )}

        {phase === "create" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>Name for the new database:</text>
            <box style={{ border: true, borderStyle: "single", borderColor: nameInput.trim() ? T.green : T.border, height: 3, width: 50, paddingLeft: 1 }}>
              <input placeholder="my_local_db" focused onInput={setNameInput} onSubmit={(v) => doCreate(typeof v === "string" ? v : "")} />
            </box>
            <text fg={T.dim}>press enter to create</text>
          </box>
        )}

        {phase === "editconn" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.dim}>Local Postgres connection URL:</text>
            <text fg={T.dim}>{`current: ${describeLocal(local)}`}</text>
            <box style={{ border: true, borderStyle: "single", borderColor: T.border, height: 3, paddingLeft: 1 }}>
              <input placeholder={`postgres://${local.user}:****@${local.host}:${local.port}`} focused onInput={setUrlInput} onSubmit={(v) => saveConn(typeof v === "string" ? v : "")} />
            </box>
            <text fg={T.dim}>enter with a URL to save · empty enter keeps current · saved to ~/.destedtui/config.json</text>
          </box>
        )}

        {phase === "dropconfirm" && selected && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.red}>{`⚠ Permanently drop "${selected.name}" (${fmtBytes(selected.sizeBytes)}).`}</text>
            <text fg={T.dim}>Type the database name to confirm:</text>
            <box style={{ border: true, borderStyle: "single", borderColor: dropText === selected.name ? T.green : T.border, height: 3, width: 50, paddingLeft: 1 }}>
              <input placeholder={selected.name} focused onInput={setDropText} onSubmit={(v) => v === selected.name && doDrop(selected.name)} />
            </box>
            <text fg={dropText === selected.name ? T.green : T.dim}>
              {dropText === selected.name ? "✓ press enter to drop" : "names don't match yet"}
            </text>
          </box>
        )}

        {phase === "error" && (
          <box style={{ flexDirection: "column", gap: 1 }}>
            <text fg={T.red}>{errorText.slice(0, 500)}</text>
            <text fg={T.dim}>press enter to edit the connection · esc to go back</text>
          </box>
        )}
      </box>
      <Footer
        hints={
          phase === "list"
            ? [
                ["↑↓", "select"],
                ["enter", "actions"],
                ["c", "create"],
                ["e", "connection"],
                ["r", "refresh"],
                ["esc", "back"],
              ]
            : phase === "create" || phase === "editconn"
              ? [
                  ["type", "value"],
                  ["enter", "save"],
                  ["esc", "back"],
                ]
              : phase === "dropconfirm"
                ? [
                    ["type name", "confirm"],
                    ["enter", "drop"],
                    ["esc", "back"],
                  ]
                : phase === "error"
                  ? [["enter", "edit conn"], ["esc", "back"]]
                  : [
                      ["↑↓", "select"],
                      ["enter", "choose"],
                      ["esc", "back"],
                    ]
        }
      />
    </box>
  );
}
