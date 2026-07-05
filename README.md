# spootie

A tiny Mac-only daemon that watches for new macOS screenshots and, on your
confirmation, uploads them to a public Cloudflare R2 bucket and copies the
share URL to your clipboard.

Nothing is uploaded automatically: every screenshot shows a notification with
an **Upload** button, and only a click triggers the upload. The local
screenshot file is never modified.

## How it works

1. Watches your macOS screenshot folder for new screenshot files.
2. When one appears (and has finished writing), shows a notification with an
   **Upload** button.
3. If you click **Upload**, the file is uploaded to R2 under a long, random,
   unguessable key (keeping the original extension).
4. The resulting public URL is copied to your clipboard and a
   "Uploaded — URL copied" notification is shown.

## Requirements

- [Bun](https://bun.sh) (developed on 1.3) — the only thing you need to
  install. It builds the binary; the result runs standalone (`alerter` is
  vendored and embedded).
- On first notification, macOS shows a permission prompt for `alerter`; allow
  it, then set **System Settings → Notifications → alerter** to **Alerts**
  style (the default "Banners" style auto-dismisses and hides the **Upload**
  button).
- A Cloudflare R2 bucket with **public access enabled** (an `r2.dev` public URL
  or a custom domain) and an S3 API access key pair.

## Getting started

Clone, install, build, configure, and start the daemon — no Xcode project, no
code signing:

```sh
git clone <repo> && cd spootie
bun install
bun run build
spootie setup
spootie install
```

`bun run build` compiles a self-contained binary (`alerter` and the
dashboard's HTML/JS are embedded — no other files travel with it) and installs
it to `~/.local/bin/spootie`. If `~/.local/bin` isn't on your `PATH`, the build
prints the one line to add to your shell profile; add it and open a new
terminal so `spootie` resolves. See [Development](#development) to run straight
from source instead.

`spootie setup` runs the configuration wizard (below). `spootie install` writes
and loads the LaunchAgent so the watcher runs at every login.

### Updating

```sh
git pull
bun install
bun run build
```

`bun run build` reinstalls the binary and, on macOS, automatically refreshes an
already-installed LaunchAgent so the running daemon restarts on the new build —
no `spootie install` needed after an update.

## Setup

In the Cloudflare dashboard: create a bucket, enable **Public access** (R2.dev
subdomain) and note the public URL, then create an S3 API token (**Object
Read & Write** scoped to the bucket — or **Admin Read & Write** if you want
the setup wizard to also apply a bucket lifecycle rule) and note the Access
Key ID, Secret Access Key, and Account ID.

Then run the wizard:

```sh
spootie setup
```

It prompts for each value (re-running shows current values as defaults),
writes `~/.config/spootie/config.json` (mode 0600), applies the expiry
lifecycle rule, and verifies the pipeline with a test upload.

## Configuration

`~/.config/spootie/config.json`:

```json
{
    "accountId": "your-cloudflare-account-id",
    "accessKeyId": "your-r2-access-key-id",
    "secretAccessKey": "your-r2-secret-access-key",
    "bucket": "your-bucket-name",
    "publicBaseUrl": "https://pub-xxxx.r2.dev",
    "expiryDays": 7
}
```

- `expiryDays` — how long uploads stay before R2 auto-deletes them, enforced
  by a bucket lifecycle rule (`spootie-expiry`). Defaults to `7`. Re-run
  `spootie setup` after changing it by hand.

## Running

```sh
spootie <setup|watch|install|uninstall|pause|resume|last|status|ui>
```

Start watching in the foreground: `spootie watch` (Ctrl+C to stop).

### Run at login (LaunchAgent)

`spootie install` writes and loads
`~/Library/LaunchAgents/com.spootie.watch.plist`, pointed at the installed
binary `~/.local/bin/spootie` (no Bun, no source tree needed at runtime): the
watcher starts now, runs at every login, and restarts on crash. Logs go to
`~/.config/spootie/logs/spootie.log`. Remove with `spootie uninstall`.

You don't need to re-run `install` after a rebuild: `bun run build` reinstalls
the binary in place and refreshes the LaunchAgent for you, and because the
agent points at the stable `~/.local/bin/spootie` path rather than a throwaway
inode, the restarted daemon runs the fresh build.

### Pause / resume

`spootie pause` / `spootie resume` toggle a flag file
(`~/.config/spootie/state/paused`) that the daemon checks immediately —
applies to the LaunchAgent too, no restart needed. Queued uploads keep
retrying while paused.

### Last upload / status

- `spootie last` — prints the most recent uploaded URL to stdout (exits 1 if
  nothing has been uploaded).
- `spootie status` — a health report across setup, R2 auth, the expiry
  lifecycle rule, the LaunchAgent, the running daemon, the offline queue and
  upload counts. Every R2 check is time-bounded, so it prints promptly (and
  exits 0) even fully offline; a failing check is reported, not fatal:

    ```
    Config
      ✓ config      /Users/you/.config/spootie/config.json

    R2
      ✓ auth        credentials valid
      ✓ lifecycle   expiry rule: 7 days
      - exposed     42 object(s) live in bucket (whole bucket)

    Daemon & queue
      ✓ launchagent installed and loaded
      ✓ daemon      running — http://127.0.0.1:53219/?token=…
      - paused      no
      - queue       0 pending upload(s)

    History
      - last upload 2026-07-05T12:00:00.000Z (https://files.example.com/…)
      - uploads     42 recorded
    ```

    With no config it prints `✗ config  not configured — run spootie setup`,
    skips the R2 checks, and still reports the local daemon/queue/history state.

### Dashboard

While `spootie watch` runs, it serves a local dashboard on `127.0.0.1` (never
exposed off-machine) listing uploaded/queued screenshots with per-item Copy
and Delete. Open with `spootie ui`, or get the URL from `status`.

### Screenshot folder detection

Read from `defaults read com.apple.screencapture location`, falling back to
`~/Desktop`. Candidate files are any non-hidden image (`.png`, `.jpg`,
`.jpeg`, `.heic`, `.tiff`, `.gif`); screen recordings (`.mov`) are ignored by
extension. Each candidate is confirmed as a genuine screen capture: the
legacy US-English `Screenshot ....png` filename pattern is checked first
(zero cost, accepted immediately on a match), and only names that don't
match fall through to Spotlight's `kMDItemIsScreenCapture` metadata (polled
briefly, since Spotlight can tag the file a moment after it's finished
writing), so detection also works on localized macOS systems and with custom
screenshot names set via `defaults write com.apple.screencapture name
"..."`. Because a copied-in or synced file can carry that same Spotlight tag,
the Spotlight path additionally requires the file's birthtime to be within
about 2 minutes of now — genuinely fresh captures pass, old screenshots
copied into the folder don't. Uploads are always manually confirmed, so a
missed edge case here is at most an extra confirmation prompt, never an
auto-upload. One limitation: detection for non-default-named screenshots
(localized systems, custom `screencapture name`) depends on Spotlight
indexing being active — if it's disabled or backlogged, the Spotlight poll
can time out and the screenshot is silently ignored (logged, but not
uploaded).

## Development

Every command above also runs straight from source, without building first —
useful while iterating:

```sh
bun run dev <setup|watch|install|uninstall|pause|resume|last|status|ui>
```

`bun run dev watch` behaves identically to the installed `spootie watch`; the
embedded-asset imports (`vendor/alerter`, the dashboard HTML/JS) resolve to
their real on-disk paths under `bun run`, so there's no separate dev-mode
code path to keep in sync. One difference: `bun run dev install` writes a
LaunchAgent that execs `bun run <repo>/src/index.ts watch` instead of the
installed binary, since it isn't pointed at `~/.local/bin/spootie` — run
`bun run build` once to install the compiled binary and switch the
LaunchAgent over to it.

Linting and formatting use [Oxc](https://oxc.rs):

```sh
bun run type-check    # tsc --noEmit
bun run lint          # oxlint .
bun run format        # oxfmt (rewrites files in place)
bun run format:check  # oxfmt --check . (CI-friendly, no writes)
```

Formatting is configured for 4-space indentation in `.oxfmtrc.json`; lint rules
live in `.oxlintrc.json`.

## Offline queue

If **Upload** is clicked while offline (or the upload fails for any
network-level reason), it's queued instead of lost:

- Stored at `~/.config/spootie/state/queue.json`, survives restarts.
- Retries with exponential backoff (5s doubling up to 60s, resetting on
  success).
- On success, your clipboard isn't silently overwritten — you get a
  notification with a **Copy URL** button instead.
- Non-retryable errors (bad credentials, access denied, missing bucket) are
  never queued; they fail immediately with an error notification. A local
  file deleted before its retry runs is dropped silently.

## Scope

The full MVP: the core confirm-and-upload pipeline, the `spootie setup`
wizard with object auto-expiry, the offline queue with automatic retry, and
the LaunchAgent daemon with pause/resume, `last` and `status`.
