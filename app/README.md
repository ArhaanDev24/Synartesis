# Synartesis Desktop

Talk to any model, and watch what it changes.

The model's MCP client is pointed at the Synartesis proxy rather than at your
servers directly, so every tool call arrives with the state it replaced already
captured. Undo is not a feature this app builds. It is a function it calls.

It shares `~/.synartesis` with the command line: something the window did is
undoable from a terminal with `synartesis undo`, and something an agent did in
a terminal shows up here.

## Running it

```bash
pnpm app
```

You need a policy first — the app will not guess which of your tools are safe
to let an agent use unsupervised:

```bash
synartesis init
```

With nothing else set up it uses Ollama on `localhost:11434`, which costs
nothing and needs no account. Claude, Gemini, Mistral, OpenAI, LM Studio and
vLLM are in the picker; the hosted ones want a key, which goes to this
machine's keychain and never to a file, a log, or the journal.

## Building it

```bash
pnpm app:build   # main, preload and renderer
pnpm app:icon    # regenerate icon.icns from build/icon.html
pnpm app:pack    # an unpacked .app, for trying it
pnpm app:dist    # dmg and zip for every target
```

Everything except `better-sqlite3` is bundled into one file. That one is a
native binding and cannot be, so it is the app's single dependency and is
unpacked out of the asar archive. `tests/app-packaging.test.ts` checks those
three facts still agree with each other.

No rebuild step: better-sqlite3's prebuilds are N-API, so they load on
Electron's ABI untouched. `npmRebuild` is off for that reason — rebuilding
would replace a working binary with one built against whatever toolchain
happens to be on the machine doing the packaging.

## Signing and notarising

**This part needs your Apple Developer account, and only you can do it.** A
build with no credentials still produces a working application — it runs on the
machine that built it, and Gatekeeper refuses it anywhere else.

You need:

1. **An Apple Developer Program membership** (99 USD/year). Without one there
   is no Developer ID certificate, and an unsigned app cannot be distributed.
2. **A "Developer ID Application" certificate** in your login keychain. Create
   it at developer.apple.com under Certificates, download it, and double-click
   to install. `security find-identity -v -p codesigning` should then list it.
   electron-builder finds it on its own — there is nothing to configure.
3. **Credentials for notarisation**, in the environment. Either an App Store
   Connect API key, which is the better of the two because it can be revoked
   on its own and is not your Apple ID:

   ```
   APPLE_API_KEY=/path/to/AuthKey_XXXXXXXX.p8
   APPLE_API_KEY_ID=XXXXXXXX
   APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

   or an app-specific password from appleid.apple.com:

   ```
   APPLE_ID=you@example.com
   APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
   APPLE_TEAM_ID=XXXXXXXXXX
   ```

Then `pnpm app:dist`. `build/notarize.cjs` uploads the signed app, waits for
Apple, and staples the result. It takes a few minutes. If the variables are not
set it says so and carries on.

Put those variables in your shell profile or a secrets manager — never in this
repository. The `.p8` key file especially: it is not recoverable if lost and it
signs on your behalf.

To check a finished build on a machine that has never seen it:

```bash
spctl --assess --type execute --verbose app/release/mac-arm64/Synartesis.app
codesign --verify --deep --strict --verbose=2 app/release/mac-arm64/Synartesis.app
```

Windows and Linux targets are configured and unsigned. Windows code signing
needs its own certificate and is a separate purchase.

## What is in here

| | |
|---|---|
| `main/` | Electron's main process. `index.ts` is the window and nothing else. |
| `main/desk.ts` | Conversations, models, the running engine. No Electron. |
| `main/engine.ts` | The proxy, the journal and the gate, wired in memory. |
| `main/toolset.ts` | Synartesis offered to the model as tools. |
| `providers/` | Anthropic, Gemini, and anything OpenAI-compatible. |
| `preload/` | The bridge. A fixed list of calls; the page cannot name a channel. |
| `renderer/` | React. Draws what the engine says, decides nothing. |
| `shared/` | Types and the transcript fold, used by both sides. |
| `build/` | Icon, entitlements, notarisation hook. |
