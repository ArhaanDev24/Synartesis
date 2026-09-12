import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { engine } from "./bridge.js";
import { Cross, Fret, Logo, Mark, Pin } from "./Mark.js";
import { Copy } from "./Copy.js";
import { Markdown } from "./Markdown.js";
import { plainly } from "./plainly.js";
import { FocusPanel } from "./FocusPanel.js";
import { draftIsSaved, readDraft, saveDraft } from "./drafts.js";
import { fold, leads } from "../shared/transcript.js";
import type {
  ApprovalCard,
  CallCard,
  ChangeSummary,
  ChatMessage,
  ConversationSummary,
  FolderReport,
  SessionEvent,
  Settings,
} from "../shared/ipc.js";

/**
 * The window.
 *
 * It draws what the engine says and sends back what the person does, and it
 * decides nothing on its own. Laid out the way a chat program is laid out --
 * conversations down the left, the model chosen from inside the composer, the
 * account at the bottom -- because that is where people already look for those
 * things, and a novel arrangement of them is a cost with no return.
 *
 * Two things here are the product rather than the convention: a tool call is
 * drawn with what Synartesis made of it, so you can see a change is
 * recoverable while it is happening; and putting something back asks twice,
 * with the plan in front of you.
 */

const EMPTY: ChangeSummary = { sessionId: "", touched: 0, recoverable: 0, held: 0 };
const STEPS = ["brief", "balanced", "thorough"] as const;
const THEMES = ["light", "dark"] as const;

function split(name: string): [string, string] {
  const at = name.indexOf("__");
  return at === -1 ? ["", name] : [name.slice(0, at), name.slice(at + 2)];
}

/** Arguments, short enough to read at a glance and complete enough to judge. */
function brief(args: Record<string, unknown>): string {
  const text = JSON.stringify(args, null, 1).replace(/\n\s*/g, " ");
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}

function Call({ call }: { call: CallCard }): React.JSX.Element {
  const [server, tool] = split(call.name);
  const recorded = call.recorded;
  return (
    <div className="call" data-running={call.state === "running"}>
      <div className="call-head">
        <span className="call-name">
          {server === "" ? null : <span className="server">{server} · </span>}
          {tool}
        </span>
        <span className="call-state">{call.state === "running" ? "Running" : recorded?.status ?? (call.state === "failed" ? "Failed" : "Finished")}</span>
      </div>
      <div className="call-safety" aria-live="polite">
        {recorded === undefined ? null : (
          <>
            <span className="tag" data-kind={recorded.class}>
              {recorded.class}
            </span>
            {recorded.class === "readonly" ? null : (
              <span className="tag" data-kind={recorded.reversible ? "ok" : "bad"}>
                {recorded.reversible ? "↶ Can be put back" : "No way back recorded"}
              </span>
            )}
          </>
        )}
        {/* A call the proxy never saw. Worth showing: it means the change, if
            there was one, is not in the journal and cannot be undone. */}
        {recorded === undefined && call.state !== "running" ? (
          <span className="tag" data-kind="bad">
            not recorded
          </span>
        ) : null}
        {recorded === undefined && call.state === "running" ? (
          <span className="tag" data-kind="pending">Undo not confirmed yet</span>
        ) : null}
        <span className="capture">
          {recorded === undefined ? call.state === "running" ? "Waiting for journal evidence" : "No journal evidence for this call" : recorded.reversible ? "Prior state captured" : recorded.class === "readonly" ? "Read only · no change to restore" : "Prior state not captured"}
        </span>
      </div>
      <pre className="call-args">{brief(call.args)}</pre>
      <details className="call-details" open={call.state === "failed"}>
        <summary>Arguments{call.result === undefined ? "" : " & result"}</summary>
        <pre tabIndex={0} className="call-args" aria-label="Full tool arguments">{JSON.stringify(call.args, null, 2)}</pre>
        {/* A failure is read by a person; anything else is the tool's own
            output and is shown exactly as the tool wrote it. */}
        {call.result === undefined || call.result === "" ? null : <pre tabIndex={0} aria-label="Full tool result" className="call-result" data-failed={call.state === "failed"}>{call.state === "failed" ? plainly(call.result) : call.result}</pre>}
      </details>
    </div>
  );
}

function Ask({
  ask,
  onAnswer,
}: {
  ask: ApprovalCard;
  onAnswer: (yes: boolean) => Promise<void>;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const answer = (yes: boolean): void => {
    setPending(true);
    setError("");
    onAnswer(yes).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPending(false);
    });
  };
  return (
    <section className="ask" aria-label={`Approval for ${ask.server}.${ask.tool}`}>
      <span className="approval-label">Decision needed · call held</span>
      <h2>
        Allow {ask.server} · {ask.tool}?
      </h2>
      <p>{plainly(ask.reason)}</p>
      <pre className="call-args">{brief(ask.args)}</pre>
      <details className="call-details"><summary>Full arguments</summary><pre tabIndex={0} className="call-args">{JSON.stringify(ask.args, null, 2)}</pre></details>
      <p className="approval-note">Nothing happens until you decide. Approval does not make this undoable.</p>
      {error === "" ? null : <p role="alert">{error}</p>}
      <div className="ask-row">
        <button className="act" disabled={pending} onClick={() => { answer(false); }}>Deny call</button>
        <button
          className="act"
          data-weight="heavy"
          disabled={pending}
          onClick={() => {
            answer(true);
          }}
        >
          {pending ? "Sending decision…" : "Allow this call"}
        </button>
      </div>
    </section>
  );
}

interface Sheet {
  readonly title: string;
  readonly body: string;
  /** When present, the sheet is asking rather than telling. */
  readonly confirm?: { readonly label: string; readonly go: () => void };
}

/** Their picture if Google gave us one, and an initial if it did not. */
function Face({ name, picture }: { name: string; picture?: string }): React.JSX.Element {
  if (picture !== undefined) {
    return <img className="face" src={picture} alt="" referrerPolicy="no-referrer" />;
  }
  return <span className="face">{name.trim().slice(0, 1).toUpperCase()}</span>;
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | undefined>(undefined);
  const [list, setList] = useState<readonly ConversationSummary[]>([]);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [summary, setSummary] = useState<ChangeSummary>(EMPTY);
  const [asks, setAsks] = useState<ApprovalCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(true);
  const [historyAt, setHistoryAt] = useState<number | undefined>(undefined);
  const scratch = useRef("");
  const input = useRef<HTMLTextAreaElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const sending = useRef(false);
  const [activity, setActivity] = useState<"checking" | "planning" | "undoing" | undefined>(undefined);
  const [sheet, setSheet] = useState<Sheet | undefined>(undefined);
  const [folder, setFolder] = useState<FolderReport | undefined>(undefined);
  const [keys, setKeys] = useState(false);
  const sheetTrigger = useRef<HTMLElement | null>(null);
  const [missing, setMissing] = useState<string | undefined>(undefined);
  const [key, setKey] = useState("");
  /** Which model's key field is open, if any. */
  const [keying, setKeying] = useState<string | undefined>(undefined);
  /** Which popover is open, if any. */
  const [pane, setPane] = useState<"models" | "account" | undefined>(undefined);

  const bottom = useRef<HTMLDivElement | null>(null);
  // Held in a ref as well so the event listener, which is installed once, can
  // tell whether an event belongs to the conversation currently on screen.
  const openRef = useRef<string | undefined>(undefined);
  openRef.current = openId;
  const history = useMemo(() => messages.filter((message) => message.role === "you").map((message) => message.text), [messages]);

  const editDraft = useCallback((text: string) => {
    setDraft(text);
    if (openRef.current !== undefined) setSaved(saveDraft(openRef.current, text));
  }, []);

  const chosen = useMemo(
    () => settings?.models.find((model) => model.id === settings.chosen),
    [settings],
  );

  const complain = useCallback((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    setMessages((was) => [
      ...was,
      { id: `note-${String(Date.now())}`, role: "note", text, calls: [] },
    ]);
  }, []);

  /** Settings that came back from something that also closes its popover. */
  const took = useCallback((next: Settings) => {
    setSettings(next);
    setPane(undefined);
  }, []);

  /**
   * One event, folded into whatever is on screen.
   *
   * By the same function the engine uses on its own copy, so what a reopened
   * conversation shows is what was on screen while it was happening.
   */
  const apply = useCallback((event: SessionEvent) => {
    if (event.kind === "approval") {
      setAsks((was) => [...was, event.request]);
      return;
    }
    if (event.kind === "approval-resolved") {
      setAsks((was) => was.filter((one) => one.actionId !== event.actionId));
      return;
    }
    if (event.kind === "turn-done") {
      setSummary(event.summary);
      return;
    }
    setMessages((was) => fold(was, event));
  }, []);

  useEffect(() => {
    // On the root element, where the stylesheet looks for it. Light is the
    // default and needs no attribute, so it is removed rather than set.
    const theme = settings?.theme;
    if (theme === "dark") {
      document.documentElement.dataset["theme"] = "dark";
    } else {
      delete document.documentElement.dataset["theme"];
    }
  }, [settings?.theme]);

  useEffect(() => {
    const stopListening = engine.onEvent((id, event) => {
      if (id === openRef.current) {
        apply(event);
      }
    });
    const stopWatchingManifest = engine.onNoManifest(setMissing);
    return () => {
      stopListening();
      stopWatchingManifest();
    };
  }, [apply]);

  const show = useCallback(
    (opened: {
      id: string;
      title: string;
      messages: readonly ChatMessage[];
      summary: ChangeSummary;
    }) => {
      setOpenId(opened.id);
      openRef.current = opened.id;
      setTitle(opened.title);
      setMessages([...opened.messages]);
      setSummary(opened.summary);
      setAsks([]);
      setDraft(readDraft(opened.id));
      setSaved(draftIsSaved(opened.id));
      setHistoryAt(undefined);
      following.current = true;
      setAway(false);
      input.current?.focus();
    },
    [],
  );

  const refreshList = useCallback(() => {
    engine.conversations().then((found) => {
      setList(found);
      // A conversation is named after the first thing said in it, so its name
      // arrives one turn after it opens.
      const mine = found.find((one) => one.id === openRef.current);
      if (mine !== undefined) {
        setTitle(mine.title);
      }
    }, complain);
  }, [complain]);

  const begin = useCallback(() => {
    engine.start().then((opened) => {
      show(opened);
      refreshList();
    }, complain);
  }, [complain, refreshList, show]);

  useEffect(() => {
    if (missing !== undefined) {
      return;
    }
    engine.settings().then(setSettings, complain);
    engine.conversations().then((found) => {
      setList(found);
      const first = found[0];
      if (first === undefined) {
        begin();
      } else {
        engine.open(first.id).then(show, complain);
      }
    }, complain);
  }, [begin, complain, missing, show]);

  useEffect(() => {
    // Instant while text is streaming. A smooth scroll restarted on every
    // chunk is a scroll that never finishes, and it lands as a judder.
    if (following.current) bottom.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [messages, asks, busy]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (text === "" || openId === undefined || busy || sending.current || activity !== undefined) {
      return;
    }
    sending.current = true;
    editDraft("");
    setHistoryAt(undefined);
    following.current = true;
    setAway(false);
    setMessages((was) => [
      ...was,
      { id: `you-${String(was.length)}`, role: "you", text, calls: [] },
    ]);
    setBusy(true);
    engine
      .send(openId, text)
      .catch((error: unknown) => {
        complain(error);
        // A rejected send should not cost the prompt, or overwrite a new draft.
        if (readDraft(openId) === "" && openRef.current === openId) editDraft(text);
      })
      .finally(() => {
        sending.current = false;
        setBusy(false);
        refreshList();
      });
    input.current?.focus();
  }, [activity, busy, complain, draft, editDraft, openId, refreshList]);

  const answer = useCallback(
    (actionId: string, yes: boolean) => {
      const request = yes
        ? engine.approve(actionId)
        : engine.deny(actionId, "you said no in the window");
      return request.then(() => {
        setAsks((was) => was.filter((one) => one.actionId !== actionId));
        input.current?.focus();
      });
    },
    [],
  );

  /**
   * Putting it back, asked twice.
   *
   * The first sheet is the plan -- what would actually happen, read from the
   * journal, not a guess. The second is the question, because an undo changes
   * somebody's files as surely as the thing it is undoing did, and a person
   * who has read the plan should still get to stop.
   */
  const putBack = useCallback(() => {
    if (openId === undefined || busy || activity !== undefined) {
      return;
    }
    sheetTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : input.current;
    setActivity("planning");
    engine.previewUndo(openId).then((plan) => {
      setSheet({
        title: "1 / 2 · Review the undo plan",
        body: plan,
        confirm: {
          label: "Continue to confirmation",
          go: () => {
            setSheet({
              title: "2 / 2 · Put these changes back?",
              body:
                "This changes files again, now, and this second change is not itself recorded " +
                "for undo. If anybody has edited something since, it stops there rather than " +
                "writing over them.",
              confirm: {
                label: "Put it back",
                go: () => {
                  setSheet(undefined);
                  setActivity("undoing");
                  engine.undo(openId).then((report) => {
                    setSheet({ title: "Undo report", body: report });
                    engine.open(openId).then(show, complain);
                  }, complain).finally(() => { setActivity(undefined); });
                },
              },
            });
          },
        },
      });
    }, complain).finally(() => { setActivity(undefined); });
  }, [activity, busy, complain, openId, show]);

  const check = useCallback(() => {
    if (openId === undefined || busy || activity !== undefined) {
      return;
    }
    sheetTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : input.current;
    setActivity("checking");
    engine.verify(openId).then((found) => {
      setSheet({ title: "How things stand now", body: found });
    }, complain).finally(() => { setActivity(undefined); });
  }, [activity, busy, complain, openId]);

  const shortcuts = useCallback(() => {
    sheetTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : input.current;
    setSheet({ title: "Make yourself at home", body: "Enter                 Send message\nShift + Enter         New line\n⌘ / Ctrl + L          Focus the composer\n⌘ / Ctrl + Shift + O  New chat\nAlt + ↑ / ↓           Browse your prompts in this chat\n⌘ / Ctrl + /          This shortcut guide\nEscape                Close a popover or sheet\nTab / Shift + Tab     Move between controls\n\nDrafts stay on this device, separately for each chat.\nPrompt history keeps your current draft while you browse.\nCopy preserves the original Markdown. Links copy their address;\nimages never load from model output." });
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || sheet !== undefined || pane !== undefined || event.isComposing) return;
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === "l") { event.preventDefault(); input.current?.focus(); }
        if (event.key === "/") { event.preventDefault(); shortcuts(); }
        if (event.shiftKey && event.key.toLowerCase() === "o" && !busy && activity === undefined) { event.preventDefault(); begin(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); };
  }, [activity, begin, busy, pane, sheet, shortcuts]);

  if (missing !== undefined) {
    return (
      <div className="app" style={{ gridTemplateColumns: "1fr" }}>
        <div className="scroll">
          <div className="empty">
            <Logo size={190} framed />
            <h2>No policy yet</h2>
            <p>
              Synartesis will not guess which of your tools are safe to let an agent use
              unsupervised. Write that down once, in a terminal:
            </p>
            <p>
              <code>synartesis init</code>
            </p>
            <p className="note">It will look for {missing}. Reopen this window afterwards.</p>
          </div>
        </div>
      </div>
    );
  }

  const account = settings?.account;

  return (
    <div className="app">
      <aside className="rail" aria-label="Conversations" inert={sheet !== undefined}>
        <div className="rail-top">
          {/* It turns while a turn is running, which is the only place in the
              window that says "still working" without taking up a row. */}
          <Mark working={busy} />
          <p className="wordmark">Synartesis</p>
        </div>
        <Fret />
        <button className="rail-new" onClick={begin} disabled={busy || activity !== undefined} aria-keyshortcuts="Meta+Shift+O Control+Shift+O">
          <span>＋ New chat</span><span aria-hidden="true">⌘ ⇧ O</span>
        </button>
        <div className="rail-list" aria-label="Chat history">
          {list.map((one) => (
            <div className="rail-row" key={one.id} data-pinned={one.pinned}>
              <button
                className="rail-item"
                aria-current={one.id === openId}
                disabled={busy || activity !== undefined}
                title={one.title}
                onClick={() => {
                  engine.open(one.id).then(show, complain);
                }}
              >
                {one.pinned ? (
                  <span className="rail-pinned" aria-label="Pinned">
                    <Pin filled />
                  </span>
                ) : null}
                {one.title}
              </button>
              <button
                className="rail-act"
                data-act="pin"
                aria-label={one.pinned ? `Unpin ${one.title}` : `Pin ${one.title}`}
                title={one.pinned ? "Unpin" : "Pin to the top"}
                disabled={busy || activity !== undefined}
                onClick={() => {
                  engine.setPinned(one.id, !one.pinned).then(setList, complain);
                }}
              >
                <Pin filled={one.pinned} />
              </button>
              <button
                className="rail-act"
                data-act="delete"
                aria-label={`Delete ${one.title}`}
                title="Delete this chat"
                disabled={busy || activity !== undefined}
                onClick={() => {
                  sheetTrigger.current =
                    document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setSheet({
                    title: `Delete “${one.title}”?`,
                    body:
                      "This forgets the conversation — the messages, and its place in this " +
                      "list.\n\nWhat it changed stays in the journal. Everything it did is " +
                      "still recorded and still reversible from a terminal:\n\n  synartesis " +
                      `undo ${one.sessionId.slice(0, 8)}\n\nDeleting a chat is tidying, not ` +
                      "erasing. Nothing on your disk changes either way.",
                    confirm: {
                      label: "Delete the chat",
                      go: () => {
                        setSheet(undefined);
                        engine.forget(one.id).then((left) => {
                          setList(left);
                          if (one.id !== openId) {
                            return;
                          }
                          const next = left[0];
                          if (next === undefined) {
                            begin();
                          } else {
                            engine.open(next.id).then(show, complain);
                          }
                        }, complain);
                      },
                    },
                  });
                }}
              >
                <Cross />
              </button>
            </div>
          ))}
        </div>

        <div className="rail-foot">
          <button
            className="account"
            aria-haspopup="dialog"
            aria-expanded={pane === "account"}
            aria-controls="account-options"
            onClick={() => {
              setPane(pane === "account" ? undefined : "account");
            }}
          >
            {account === undefined ? (
              <span className="face" />
            ) : (
              <Face
                name={account.name}
                {...(account.picture === undefined ? {} : { picture: account.picture })}
              />
            )}
            <span className="account-who">
              <b>{account?.name ?? "Not signed in"}</b>
              <span className="account-sub">{account?.email ?? "Appearance and account"}</span>
            </span>
          </button>

          {pane === "account" ? (
            <>
              <div
                className="scrim"
                onClick={() => {
                  setPane(undefined);
                }}
              />
              <FocusPanel className="pop" at="account" id="account-options" label="Appearance and account" onClose={() => { setPane(undefined); }}>
                <p className="pop-label">Appearance</p>
                <div className="steps" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                  {THEMES.map((theme) => (
                    <button
                      key={theme}
                      aria-pressed={(settings?.theme ?? "light") === theme}
                      onClick={() => {
                        engine.setTheme(theme).then(setSettings, complain);
                      }}
                    >
                      {theme}
                    </button>
                  ))}
                </div>

                <p className="pop-label">Account</p>
                {account === undefined ? (
                  <>
                    <button
                      className="pop-row"
                      disabled={settings?.canSignIn !== true}
                      onClick={() => {
                        engine.signIn().then(took, complain);
                      }}
                    >
                      <span className="pop-name">Sign in with Google</span>
                    </button>
                    <p className="pop-note">
                      {settings?.canSignIn === true
                        ? "Optional. It only makes the journal record who approved a call, by name, instead of “you”. Nothing is sent anywhere and nothing syncs."
                        : "This build has no Google client id, so signing in is unavailable. Everything else works unchanged."}
                    </p>
                  </>
                ) : (
                  <>
                    <button
                      className="pop-row"
                      onClick={() => {
                        engine.signOut().then(took, complain);
                      }}
                    >
                      <span className="pop-name">Sign out</span>
                    </button>
                    <p className="pop-note">
                      Approvals are recorded in the journal as {account.email}. That is all
                      signing in does.
                    </p>
                  </>
                )}
              </FocusPanel>
            </>
          ) : null}
        </div>
      </aside>

      <main className="main" inert={sheet !== undefined}>
        <header className="topbar">
          <h1>{title === "" ? "New chat" : title}</h1>
          <div className="ledger">
            <div className="ledger-facts" role="status" aria-label="Change ledger">
            <span className="ledger-label">{activity === "undoing" ? "Undo in progress" : busy ? "Recorded before this turn" : "Change ledger"}</span>
            <span className="ledger-count">
              <b>{summary.touched}</b> changed · <b>{summary.recoverable}</b> can be put back
              {summary.held > 0 ? (
                <>
                  {" · "}
                  <span className="warn">{summary.held} held / refused</span>
                </>
              ) : null}
            </span>
            </div>
            <button
              className="act"
              title="What has happened to the files in a folder"
              onClick={() => {
                sheetTrigger.current =
                  document.activeElement instanceof HTMLElement ? document.activeElement : null;
                engine.chooseFolder().then((picked) => {
                  if (picked === undefined) {
                    return;
                  }
                  engine.folder(picked).then(setFolder, complain);
                }, complain);
              }}
            >
              Files…
            </button>
            <button className="act" onClick={check} disabled={summary.touched === 0 || busy || activity !== undefined} title="Read current state and check for changes">
              {activity === "checking" ? "Checking…" : "Check"}
            </button>
            <button
              className="act"
              data-weight="heavy"
              onClick={putBack}
              disabled={summary.touched === 0 || busy || activity !== undefined}
              title="Review the real undo plan before confirming"
            >
              {activity === "planning" ? "Planning…" : activity === "undoing" ? "Restoring…" : "↶ Put it back"}
            </button>
          </div>
        </header>

        {busy ? (
          <div className="turn-status" role="status">
            {/* The same mark as the rail, turning, beside the words -- in the
                middle of the window rather than in a corner, because the
                corner is not where anybody is looking during a turn. */}
            <Mark working size={15} />
            {asks.length > 0
              ? `${String(asks.length)} call held · waiting for your decision`
              : "Working · each tool card shows whether its change can be put back"}
          </div>
        ) : null}
        <div className="scroll" data-streaming={busy} tabIndex={0} role="region" aria-label="Conversation transcript" onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          setAway(!following.current);
        }}>
          <div className="thread">
            {messages.length === 0 ? (
              <div className="empty">
                <Logo size={144} framed />
                <span className="eyebrow">A little room to change your mind</span>
                <h2>Make a change.<br />Keep a way back.</h2>
                <p>
                  Ask for what you need. Each tool card shows whether its change can be put back. Calls that need approval wait for you.
                </p>
                <div className="starters">
                  {["What files can you work with?", "What did you change?", "Show me what can be put back."].map((prompt) => <button key={prompt} onClick={() => { editDraft(prompt); setHistoryAt(undefined); input.current?.focus(); }}>{prompt}<span aria-hidden="true">↗</span></button>)}
                </div>
                <p className="note">You review the real plan before an undo. Then you confirm.</p>
              </div>
            ) : null}

            {messages.map((message, at) => (
              <div className="turn" key={message.id} data-role={message.role}>
                {/* Said once per speaker, not once per fragment: a reply that
                    spoke, called a tool and spoke again is three messages here
                    and one turn to the person reading it. */}
                {leads(messages, at) ? (
                  <span className="who">
                    {message.role === "you"
                      ? "You"
                      : message.role === "model"
                        ? "Model"
                        : "Synartesis"}
                  </span>
                ) : null}
                {message.calls.map((call) => (
                  <Call key={call.id} call={call} />
                ))}
                {message.text === "" && message.calls.length > 0 ? null : (
                  <div
                    className={
                      busy && at === messages.length - 1 && message.role === "model"
                        ? "said writing"
                        : "said"
                    }
                  >
                    {message.role === "model" ? <Markdown text={message.text} /> : message.text}
                  </div>
                )}
                {message.text === "" ? null : <div className="message-actions"><Copy text={message.text} title={message.role === "you" ? "Copy your message" : "Copy message"} /></div>}
              </div>
            ))}

            {asks.map((ask) => (
              <Ask
                key={ask.actionId}
                ask={ask}
                onAnswer={(yes) => {
                  return answer(ask.actionId, yes);
                }}
              />
            ))}
            <div ref={bottom} />
          </div>
        </div>

        <div className="composer">
          {away ? <button className="latest" onClick={() => {
            following.current = true; setAway(false); bottom.current?.scrollIntoView({ behavior: "auto" });
          }}>↓ Latest message</button> : null}
          <Fret />
          <div className="box">
            <textarea
              ref={input}
              aria-label="Message"
              aria-describedby="composer-help"
              aria-keyshortcuts="Meta+L Control+L Alt+ArrowUp Alt+ArrowDown"
              value={draft}
              disabled={openId === undefined}
              rows={1}
              placeholder="Say what you want done"
              onChange={(event) => {
                editDraft(event.target.value);
                setHistoryAt(undefined);
              }}
              onKeyDown={(event) => {
                // Enter sends, shift-enter breaks the line. The other way round
                // costs a keystroke on every message and surprises everybody.
                if (event.nativeEvent.isComposing) return;
                if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && history.length > 0) {
                  event.preventDefault();
                  if (historyAt === undefined && event.key === "ArrowDown") return;
                  if (historyAt === undefined) scratch.current = draft;
                  const next = event.key === "ArrowUp" ? Math.max(0, (historyAt ?? history.length) - 1) : (historyAt ?? history.length) + 1;
                  if (next >= history.length) { editDraft(scratch.current); setHistoryAt(undefined); }
                  else { editDraft(history[next] ?? ""); setHistoryAt(next); }
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
                  event.preventDefault();
                  send();
                }
              }}
            />
            <div className="box-row">
              {/* The model lives here, beside the thing it is about to do,
                  rather than in a panel somewhere else. */}
              <button
                className="picker"
                aria-label="Choose model and thinking effort"
                aria-haspopup="dialog"
                aria-expanded={pane === "models"}
                aria-controls="model-options"
                disabled={busy || activity !== undefined}
                onClick={() => {
                  setPane(pane === "models" ? undefined : "models");
                }}
              >
                {chosen?.name ?? "No model"}
                {chosen?.thinks === true ? ` · ${settings?.reasoning ?? ""}` : ""}
                <span className="chev">⌄</span>
              </button>
              <span className="hint" role="status">{busy ? "Working…" : historyAt === undefined ? draft === "" ? "" : saved ? "Draft saved on this device" : "Draft kept in this window" : `History ${String(historyAt + 1)} / ${String(history.length)}`}</span>
              {busy ? (
                <button
                  className="round"
                  aria-label="Stop"
                  onClick={() => {
                    if (openId !== undefined) engine.stop(openId).catch(complain);
                  }}
                >
                  ■
                </button>
              ) : (
                <button
                  className="round"
                  aria-label="Send"
                  onClick={send}
                  disabled={draft.trim() === "" || openId === undefined || activity !== undefined}
                >
                  ↑
                </button>
              )}
            </div>
          </div>
          <div className="composer-help" id="composer-help"><span>Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line</span><button onClick={shortcuts} aria-keyshortcuts="Meta+/ Control+/">Keyboard shortcuts <kbd>⌘ /</kbd></button></div>

          {pane === "models" ? (
            <>
              <div
                className="scrim"
                onClick={() => {
                  setPane(undefined);
                }}
              />
              <FocusPanel className="pop" at="models" id="model-options" label="Model and thinking effort" onClose={() => { setPane(undefined); setKey(""); setKeying(undefined); }}>
                <p className="pop-label">Model</p>
                {(settings?.models ?? []).map((model) => (
                  <button
                    key={model.id}
                    className="pop-row"
                    aria-current={model.id === settings?.chosen}
                    onClick={() => {
                      engine.chooseModel(model.id).then(setSettings, complain);
                    }}
                  >
                    <span className="pop-name">
                      {model.name}
                      {model.needsKey ? (
                        <em data-ready={model.hasKey}>{model.hasKey ? "key saved" : "needs a key"}</em>
                      ) : null}
                    </span>
                    <span className="pop-note">{model.note}</span>
                  </button>
                ))}
                {/* Setting a key up is not choosing a model, and squeezing it
                    in here made both cramped. It gets a sheet. */}
                <button
                  className="pop-row pop-more"
                  onClick={() => {
                    sheetTrigger.current =
                      document.activeElement instanceof HTMLElement ? document.activeElement : null;
                    setPane(undefined);
                    setKeys(true);
                  }}
                >
                  <span className="pop-name">API keys…</span>
                </button>

                <p className="pop-label">Thinking</p>
                <div className="steps" data-inert={chosen?.thinks === false}>
                  {STEPS.map((step) => (
                    <button
                      key={step}
                      aria-pressed={settings?.reasoning === step}
                      disabled={chosen?.thinks === false}
                      onClick={() => {
                        engine.setReasoning(step).then(setSettings, complain);
                      }}
                    >
                      {step}
                    </button>
                  ))}
                </div>
                {chosen?.thinks === false ? (
                  <p className="pop-note">
                    {chosen.name} has no thinking control, so this does nothing.
                  </p>
                ) : null}

              </FocusPanel>
            </>
          ) : null}
        </div>
      </main>

      {!keys ? null : (
        <div className="sheet">
          <FocusPanel
            className="sheet-card wide"
            id="api-keys"
            label="API keys"
            returnTo={sheetTrigger.current}
            onClose={() => {
              setKeys(false);
              setKey("");
              setKeying(undefined);
            }}
          >
            <h2>API keys</h2>
            <p className="pop-note">
              {settings?.canKeepSecrets === true
                ? "Kept in this machine's keychain. Never written to the journal, a log, or this window — not even to show you a masked version."
                : "This machine has no keychain available, so a key cannot be stored safely here. The local models need none."}
            </p>

            <div className="keys">
              {(settings?.models ?? [])
                .filter((model) => model.needsKey)
                .map((model) => (
                  <div className="key-row" key={model.id} data-ready={model.hasKey}>
                    <div className="key-who">
                      <b>{model.name}</b>
                      <span>{model.note}</span>
                      {model.keyUrl === undefined ? null : (
                        <button
                          className="key-link"
                          onClick={() => {
                            if (model.keyUrl !== undefined) {
                              engine.openKeyPage(model.keyUrl).catch(complain);
                            }
                          }}
                        >
                          Get a key ↗
                        </button>
                      )}
                    </div>

                    <div className="key-do">
                      {model.hasKey ? (
                        <>
                          <span className="key-state">Saved ✓</span>
                          <button
                            className="act"
                            onClick={() => {
                              engine.forgetKey(model.id).then(setSettings, complain);
                            }}
                          >
                            Remove
                          </button>
                        </>
                      ) : keying === model.id ? (
                        <>
                          <input
                            type="password"
                            autoFocus
                            aria-label={`API key for ${model.name}`}
                            autoComplete="off"
                            value={key}
                            placeholder="Paste the key"
                            onChange={(event) => {
                              setKey(event.target.value);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && key !== "") {
                                engine.saveKey(model.id, key).then((next) => {
                                  setKey("");
                                  setKeying(undefined);
                                  setSettings(next);
                                }, complain);
                              }
                            }}
                          />
                          <button
                            className="act"
                            data-weight="heavy"
                            disabled={key === ""}
                            onClick={() => {
                              engine.saveKey(model.id, key).then((next) => {
                                setKey("");
                                setKeying(undefined);
                                setSettings(next);
                              }, complain);
                            }}
                          >
                            Save
                          </button>
                        </>
                      ) : (
                        <button
                          className="act"
                          disabled={settings?.canKeepSecrets !== true}
                          onClick={() => {
                            setKey("");
                            setKeying(model.id);
                          }}
                        >
                          Add key
                        </button>
                      )}
                    </div>
                  </div>
                ))}
            </div>

            <p className="pop-note">
              The models that run on this machine — Ollama, LM Studio, vLLM — need no key at all.
            </p>
            <div className="sheet-row">
              <button
                className="act"
                onClick={() => {
                  setKeys(false);
                  setKey("");
                  setKeying(undefined);
                }}
              >
                Done
              </button>
            </div>
          </FocusPanel>
        </div>
      )}

      {folder === undefined ? null : (
        <div className="sheet">
          <FocusPanel
            className="sheet-card wide"
            id="folder-report"
            label={`Files changed under ${folder.folder}`}
            returnTo={sheetTrigger.current}
            onClose={() => {
              setFolder(undefined);
            }}
          >
            <h2>What has happened here</h2>
            <p className="pop-note">
              {folder.folder}
              <br />
              Read from the journal, not from the disk — this is what was done, not what is true
              now. Reads are left out; only changes are listed.
            </p>
            {folder.files.length === 0 ? (
              <p className="pop-note">No agent has changed anything in this folder.</p>
            ) : (
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Files changed">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">File</th>
                      <th scope="col">Changed</th>
                      <th scope="col">Can be put back</th>
                      <th scope="col">Put back</th>
                      <th scope="col">Held</th>
                      <th scope="col">Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {folder.files.map((file) => (
                      <tr key={file.path} data-risk={file.changes > file.recoverable}>
                        <td title={file.path}>{file.path.split("/").pop()}</td>
                        <td>{file.changes}</td>
                        <td>{file.recoverable}</td>
                        <td>{file.undone}</td>
                        <td>{file.held === 0 ? "" : file.held}</td>
                        <td className="whenever">{file.lastTool}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="pop-note">
              A row where “changed” is more than “can be put back” has a change the journal
              cannot reverse. Undo runs by conversation, not by file — open the chat that did it.
            </p>
            <div className="sheet-row">
              <button
                className="act"
                onClick={() => {
                  engine.folder(folder.folder).then(setFolder, complain);
                }}
              >
                Refresh
              </button>
              <button
                className="act"
                onClick={() => {
                  setFolder(undefined);
                }}
              >
                Close
              </button>
            </div>
          </FocusPanel>
        </div>
      )}

      {sheet === undefined ? null : (
        <div className="sheet">
          <FocusPanel className="sheet-card" id="recovery-sheet" label={sheet.title} returnTo={sheetTrigger.current} onClose={() => { setSheet(undefined); }}>
            <h2>{sheet.title}</h2>
            <pre tabIndex={0} aria-label="Plan or report details">{sheet.body}</pre>
            <div className="sheet-row">
              <button
                className="act"
                onClick={() => {
                  setSheet(undefined);
                }}
              >
                {sheet.confirm === undefined ? "Close" : "Cancel"}
              </button>
              {sheet.confirm === undefined ? null : (
                <button className="act" data-weight="heavy" onClick={sheet.confirm.go}>
                  {sheet.confirm.label}
                </button>
              )}
            </div>
          </FocusPanel>
        </div>
      )}
    </div>
  );
}
