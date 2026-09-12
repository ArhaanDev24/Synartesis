import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { engine } from "./bridge.js";
import { Fret, Logo, Mark } from "./Mark.js";
import { fold, leads } from "../shared/transcript.js";
import type {
  ApprovalCard,
  CallCard,
  ChangeSummary,
  ChatMessage,
  ConversationSummary,
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
        {call.state === "running" ? <span className="tag">running</span> : null}
        {recorded === undefined ? null : (
          <>
            <span className="tag" data-kind={recorded.class}>
              {recorded.class}
            </span>
            {recorded.class === "readonly" ? null : (
              <span className="tag" data-kind={recorded.reversible ? "ok" : "bad"}>
                {recorded.reversible ? "can be put back" : "no way back recorded"}
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
      </div>
      <pre className="call-args">{brief(call.args)}</pre>
      {call.result === undefined || call.result === "" ? null : (
        <pre className="call-result" data-failed={call.state === "failed"}>
          {call.result.length > 1200 ? `${call.result.slice(0, 1199)}…` : call.result}
        </pre>
      )}
    </div>
  );
}

function Ask({
  ask,
  onAnswer,
}: {
  ask: ApprovalCard;
  onAnswer: (yes: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="ask">
      <h2>
        {ask.server} · {ask.tool} is waiting for you
      </h2>
      <p>{ask.reason}</p>
      <pre className="call-args">{brief(ask.args)}</pre>
      <div className="ask-row">
        <button
          className="act"
          data-weight="heavy"
          onClick={() => {
            onAnswer(true);
          }}
        >
          Allow it
        </button>
        <button
          className="act"
          onClick={() => {
            onAnswer(false);
          }}
        >
          No
        </button>
      </div>
    </div>
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
  const [sheet, setSheet] = useState<Sheet | undefined>(undefined);
  const [missing, setMissing] = useState<string | undefined>(undefined);
  const [key, setKey] = useState("");
  /** Which popover is open, if any. */
  const [pane, setPane] = useState<"models" | "account" | undefined>(undefined);

  const bottom = useRef<HTMLDivElement | null>(null);
  // Held in a ref as well so the event listener, which is installed once, can
  // tell whether an event belongs to the conversation currently on screen.
  const openRef = useRef<string | undefined>(undefined);
  openRef.current = openId;

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
    bottom.current?.scrollIntoView({ behavior: busy ? "auto" : "smooth", block: "end" });
  }, [messages, asks, busy]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (text === "" || openId === undefined || busy) {
      return;
    }
    setDraft("");
    setMessages((was) => [
      ...was,
      { id: `you-${String(was.length)}`, role: "you", text, calls: [] },
    ]);
    setBusy(true);
    engine
      .send(openId, text)
      .catch(complain)
      .finally(() => {
        setBusy(false);
        refreshList();
      });
  }, [busy, complain, draft, openId, refreshList]);

  const answer = useCallback(
    (actionId: string, yes: boolean) => {
      const request = yes
        ? engine.approve(actionId)
        : engine.deny(actionId, "you said no in the window");
      request.catch(complain);
      setAsks((was) => was.filter((one) => one.actionId !== actionId));
    },
    [complain],
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
    if (openId === undefined) {
      return;
    }
    engine.previewUndo(openId).then((plan) => {
      setSheet({
        title: "This is what putting it back would do",
        body: plan,
        confirm: {
          label: "Go on",
          go: () => {
            setSheet({
              title: "Sure?",
              body:
                "This changes files again, now, and this second change is not itself recorded " +
                "for undo. If anybody has edited something since, it stops there rather than " +
                "writing over them.",
              confirm: {
                label: "Put it back",
                go: () => {
                  setSheet(undefined);
                  engine.undo(openId).then((report) => {
                    setSheet({ title: "Done", body: report });
                  }, complain);
                },
              },
            });
          },
        },
      });
    }, complain);
  }, [complain, openId]);

  const check = useCallback(() => {
    if (openId === undefined) {
      return;
    }
    engine.verify(openId).then((found) => {
      setSheet({ title: "How things stand now", body: found });
    }, complain);
  }, [complain, openId]);

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
      <aside className="rail">
        <div className="rail-top">
          {/* It turns while a turn is running, which is the only place in the
              window that says "still working" without taking up a row. */}
          <Mark working={busy} />
          <p className="wordmark">Synartesis</p>
        </div>
        <Fret />
        <button className="rail-new" onClick={begin} disabled={busy}>
          New chat
        </button>
        <div className="rail-list">
          {list.map((one) => (
            <button
              key={one.id}
              className="rail-item"
              aria-current={one.id === openId}
              disabled={busy}
              onClick={() => {
                engine.open(one.id).then(show, complain);
              }}
            >
              {one.title}
            </button>
          ))}
        </div>

        <div className="rail-foot">
          <button
            className="account"
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
              <div className="pop" data-at="account">
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
              </div>
            </>
          ) : null}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{title === "" ? "New chat" : title}</h1>
          <div className="ledger">
            <span className="ledger-count">
              <b>{summary.touched}</b> changed · <b>{summary.recoverable}</b> can be put back
              {summary.held > 0 ? (
                <>
                  {" · "}
                  <span className="warn">{summary.held} held</span>
                </>
              ) : null}
            </span>
            <button className="act" onClick={check} disabled={summary.touched === 0}>
              Check
            </button>
            <button
              className="act"
              data-weight="heavy"
              onClick={putBack}
              disabled={summary.touched === 0}
            >
              Put it back
            </button>
          </div>
        </header>

        <div className="scroll" data-streaming={busy}>
          <div className="thread">
            {messages.length === 0 ? (
              <div className="empty">
                <Logo size={200} framed />
                <h2>Ready when you are.</h2>
                <p>
                  Whatever the model touches is recorded with the state it replaced, so you can
                  put it back. Anything that cannot be undone waits for you first.
                </p>
                <p className="note">
                  Try “what did you change?” or “put that back” — it has the same tools you do.
                </p>
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
                    {message.text}
                  </div>
                )}
              </div>
            ))}

            {asks.map((ask) => (
              <Ask
                key={ask.actionId}
                ask={ask}
                onAnswer={(yes) => {
                  answer(ask.actionId, yes);
                }}
              />
            ))}
            <div ref={bottom} />
          </div>
        </div>

        <div className="composer">
          <Fret />
          <div className="box">
            <textarea
              value={draft}
              rows={1}
              placeholder="Say what you want done"
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                // Enter sends, shift-enter breaks the line. The other way round
                // costs a keystroke on every message and surprises everybody.
                if (event.key === "Enter" && !event.shiftKey) {
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
                onClick={() => {
                  setPane(pane === "models" ? undefined : "models");
                }}
              >
                {chosen?.name ?? "No model"}
                {chosen?.thinks === true ? ` · ${settings?.reasoning ?? ""}` : ""}
                <span className="chev">⌄</span>
              </button>
              <span className="hint">{busy ? "Working…" : ""}</span>
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
                  disabled={draft.trim() === ""}
                >
                  ↑
                </button>
              )}
            </div>
          </div>

          {pane === "models" ? (
            <>
              <div
                className="scrim"
                onClick={() => {
                  setPane(undefined);
                }}
              />
              <div className="pop" data-at="models">
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
                      {model.needsKey && !model.hasKey ? <em> needs a key</em> : null}
                    </span>
                    <span className="pop-note">{model.note}</span>
                  </button>
                ))}

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

                {chosen !== undefined && chosen.needsKey && !chosen.hasKey ? (
                  <>
                    <p className="pop-label">API key</p>
                    <input
                      type="password"
                      value={key}
                      placeholder="Paste it and press Enter"
                      onChange={(event) => {
                        setKey(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && key !== "") {
                          engine.saveKey(chosen.id, key).then((next) => {
                            setKey("");
                            setSettings(next);
                          }, complain);
                        }
                      }}
                    />
                    <p className="pop-note">
                      {settings?.canKeepSecrets === true
                        ? "Kept in this machine's keychain. Never written to the journal or a log."
                        : "This machine has no keychain available, so a key cannot be stored safely."}
                    </p>
                  </>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </main>

      {sheet === undefined ? null : (
        <div className="sheet">
          <div className="sheet-card">
            <h2>{sheet.title}</h2>
            <pre>{sheet.body}</pre>
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
          </div>
        </div>
      )}
    </div>
  );
}
