# spootie

A tiny Mac-only daemon that watches for new macOS screenshots and, on your
confirmation, uploads them to a public Cloudflare R2 bucket and copies the
share URL to your clipboard.

Nothing is uploaded automatically. New screenshots appear in a local
dashboard as **pending**; only clicking **Upload** there triggers the upload.
The local file is never modified.

## How it works

1. The daemon watches your macOS screenshot folder.
2. A new screenshot shows a notification and appears in the dashboard's
   pending list.
3. Click **Upload** in the dashboard (or **Discard** to skip it).
4. The file is uploaded to R2 under a long random key, the public URL is
   copied to your clipboard, and R2 auto-deletes it after `expiryDays`
   (default 7).

If an upload fails for a network reason, it's queued at
`~/.config/spootie/state/queue.json` and retried with backoff until it
succeeds.

## Requirements

- [Bun](https://bun.sh) — the only install; the build produces a standalone
  binary.
- A Cloudflare R2 bucket with **public access** enabled (an `r2.dev` URL or
  custom domain) and an S3 API token (**Object Read & Write**, or **Admin
  Read & Write** if you want setup to manage the expiry lifecycle rule too).

## Install

```sh
git clone <repo> && cd spootie
bun install
bun run build       # compiles and installs ~/.local/bin/spootie
spootie setup       # configuration wizard
spootie install     # LaunchAgent: run at every login
```

If `~/.local/bin` isn't on your `PATH`, the build prints the line to add to
your shell profile.

`spootie setup` prompts for your R2 credentials, writes
`~/.config/spootie/config.json`, applies the expiry lifecycle rule, and
verifies everything with a test upload.

**Updating:** `git pull && bun install && bun run build` — the build
reinstalls the binary and restarts an installed LaunchAgent automatically.

## Commands

```sh
spootie <setup|watch|install|uninstall|pause|resume|last|status|ui>
```

- `watch` — run the watcher in the foreground (Ctrl+C to stop)
- `install` / `uninstall` — add/remove the LaunchAgent
  (`~/Library/LaunchAgents/com.spootie.watch.plist`, logs in
  `~/.config/spootie/logs/`)
- `pause` / `resume` — toggle watching without restarting the daemon
- `ui` — open the dashboard in your browser
- `last` — print the most recent uploaded URL
- `status` — full health report: config, R2 auth, lifecycle rule,
  LaunchAgent, daemon, queue, and upload history

## Dashboard

While the daemon runs, it serves a dashboard on `127.0.0.1` (never exposed
off-machine): pending screenshots with Upload/Discard, uploaded items with
thumbnails, per-item Copy and Delete, and a drop zone for uploading any
file. Open it with `spootie ui`.

## Configuration

`~/.config/spootie/config.json` (written by `spootie setup`):

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

Re-run `spootie setup` after editing by hand (it re-applies the lifecycle
rule and re-verifies).

## Notes on screenshot detection

The watched folder comes from `defaults read com.apple.screencapture
location` (falling back to `~/Desktop`). Files are confirmed as genuine,
fresh screen captures via the standard filename pattern or Spotlight's
`kMDItemIsScreenCapture` metadata — so localized systems and custom
screenshot names work too. Since every upload is manually confirmed, a
detection edge case at worst means one extra pending item, never an
auto-upload.

## Development

Every command runs straight from source:

```sh
bun run dev <command>     # e.g. bun run dev watch
```

```sh
bun run type-check    # tsc --noEmit
bun run lint          # oxlint .
bun run format        # oxfmt (rewrites files in place)
```

### Dashboard UI

The dashboard is a small Preact app under `src/dashboard/` (`app.tsx`, `tile.tsx`,
`icons.tsx`, `api.ts`, `format.ts`, `styles.css`). `bun run dashboard:build`
bundles it with Bun into a single self-contained `dist/dashboard.html`, which
the daemon embeds and serves at `/`.

`bun run dev` builds it once, rebuilds on change, and runs the daemon — the
server reads the file per request, so editing a component and reloading the
browser shows the change. `bun run build` bundles it before compiling the
binary, so `dist/dashboard.html` is always current in a release.
