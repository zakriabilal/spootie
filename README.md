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

## Prerequisites

- [Bun](https://bun.sh) (developed on 1.3) — used only to build the binary;
  the resulting `dist/spootie` runs standalone (`alerter` is vendored and
  embedded, see [Building](#building)).
- On first notification, macOS shows a permission prompt for `alerter`; allow
  it, then set **System Settings → Notifications → alerter** to **Alerts**
  style (the default "Banners" style auto-dismisses and hides the **Upload**
  button).
- A Cloudflare R2 bucket with **public access enabled** (an `r2.dev` public URL
  or a custom domain) and an S3 API access key pair.

## Building

Clone, install, and compile — no Xcode project, no code signing:

```sh
bun install
bun run build
```

This produces `dist/spootie`, a self-contained daemon binary (`alerter` and
the dashboard's HTML/JS are embedded in it — no other files need to travel
with it). On macOS it also compiles `dist/spootie-menubar`, the optional
[menu bar app](#menu-bar-app); on Linux that step is skipped with a message
(Swift isn't available there).

Everything below assumes you're running the built binary, `./dist/spootie`
(or just `spootie` if it's on your PATH). See [Development](#development) for
running from source instead.

## Setup

In the Cloudflare dashboard: create a bucket, enable **Public access** (R2.dev
subdomain) and note the public URL, then create an S3 API token (**Object
Read & Write** scoped to the bucket — or **Admin Read & Write** if you want
the setup wizard to also apply a bucket lifecycle rule) and note the Access
Key ID, Secret Access Key, and Account ID.

Then run the wizard:

```sh
./dist/spootie setup
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
./dist/spootie <setup|watch|install|uninstall|pause|resume|last|status|ui>
```

Start watching in the foreground: `./dist/spootie watch` (Ctrl+C to stop).

### Run at login (LaunchAgent)

`./dist/spootie install` writes and loads
`~/Library/LaunchAgents/com.spootie.watch.plist`, pointed directly at the
compiled binary (no Bun, no source tree needed at runtime): the watcher
starts now, runs at every login, and restarts on crash. Logs go to
`~/.config/spootie/logs/spootie.log`. Remove with `./dist/spootie
uninstall`. **Re-run `install` after every rebuild**, not just after moving
or renaming `dist/spootie` — `bun build --compile` atomically replaces the
file on disk, but a LaunchAgent already running keeps executing the old,
now-unlinked binary indefinitely until it's restarted, which is exactly what
`install` does.

### Pause / resume

`./dist/spootie pause` / `./dist/spootie resume` toggle a flag file
(`~/.config/spootie/state/paused`) that the daemon checks immediately —
applies to the LaunchAgent too, no restart needed. Queued uploads keep
retrying while paused.

### Last upload / status

- `./dist/spootie last` — prints the most recent uploaded URL to stdout
  (exits 1 if nothing has been uploaded).
- `./dist/spootie status` — LaunchAgent state, paused state, queue length,
  last upload time, and the dashboard URL.

### Dashboard

While `spootie watch` runs, it serves a local dashboard on `127.0.0.1` (never
exposed off-machine) listing uploaded/queued screenshots with per-item Copy
and Delete. Open with `./dist/spootie ui`, or get the URL from `status`.

### Menu bar app

`menubar/main.swift` is an optional, unsigned macOS menu bar client — a thin
wrapper around the same local dashboard API the web UI uses (`/api/status`,
`/api/items`, `/api/pause`). It shows a status icon (watching / paused /
daemon unreachable), lets you pause/resume and copy recent upload URLs
without opening a browser tab, and links to the full dashboard.

It requires the daemon to already be running (`spootie watch`, or the
LaunchAgent from `spootie install`) — it never starts, stops, or manages the
daemon itself, and quitting it does not stop `spootie watch`.

`bun run build` compiles it to `dist/spootie-menubar` on a Mac (see
[Building](#building)) — no separate command needed:

```sh
./dist/spootie-menubar
```

It's unsigned and built locally (an internal tool, not distributed), so
macOS Gatekeeper may warn on first launch from Finder; running it from
Terminal as above avoids that. See `menubar/README.md` for more detail.

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

`bun run dev watch` behaves identically to `./dist/spootie watch`; the
embedded-asset imports (`vendor/alerter`, the dashboard HTML/JS) resolve to
their real on-disk paths under `bun run`, so there's no separate dev-mode
code path to keep in sync. One difference: `bun run dev install` writes a
LaunchAgent that execs `bun run <repo>/src/index.ts watch` instead of a
standalone binary, since there's no `dist/spootie` to point at — re-run
`install` from `./dist/spootie` once you've built, to switch the LaunchAgent
over to the compiled binary.

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
