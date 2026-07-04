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

- [Bun](https://bun.sh) (developed on 1.3).
- [`alerter`](https://github.com/vjeantet/alerter) for actionable
  notifications: `brew install alerter`. The first notification triggers a
  macOS permission prompt; allow it, then set **System Settings →
  Notifications → alerter** to **Alerts** style (the default "Banners" style
  auto-dismisses and hides the **Upload** button).
- A Cloudflare R2 bucket with **public access enabled** (an `r2.dev` public URL
  or a custom domain) and an S3 API access key pair.

## Setup

In the Cloudflare dashboard: create a bucket, enable **Public access** (R2.dev
subdomain) and note the public URL, then create an S3 API token (**Object
Read & Write** scoped to the bucket — or **Admin Read & Write** if you want
the setup wizard to also apply a bucket lifecycle rule) and note the Access
Key ID, Secret Access Key, and Account ID.

Then run the wizard:

```sh
bun install
bun run dev setup
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

Start watching in the foreground: `bun run dev watch` (Ctrl+C to stop).

### Run at login (LaunchAgent)

`bun run dev install` writes and loads
`~/Library/LaunchAgents/com.spootie.watch.plist`: the watcher starts now,
runs at every login, and restarts on crash. Logs go to
`~/.config/spootie/logs/spootie.log`. Remove with `bun run dev uninstall`.
Re-run `install` if you move the repo or update Bun.

### Pause / resume

`bun run dev pause` / `bun run dev resume` toggle a flag file
(`~/.config/spootie/state/paused`) that the daemon checks immediately —
applies to the LaunchAgent too, no restart needed. Queued uploads keep
retrying while paused.

### Last upload / status

- `bun run dev last` — prints the most recent uploaded URL to stdout (exits 1
  if nothing has been uploaded).
- `bun run dev status` — LaunchAgent state, paused state, queue length, last
  upload time, and the dashboard URL.

### Dashboard

While `spootie watch` runs, it serves a local dashboard on `127.0.0.1` (never
exposed off-machine) listing uploaded/queued screenshots with per-item Copy
and Delete. Open with `bun run dev ui`, or get the URL from `status`.

### Screenshot folder detection

Read from `defaults read com.apple.screencapture location`, falling back to
`~/Desktop`. Only files matching the macOS screenshot naming pattern are
considered; screen recordings are ignored.

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
