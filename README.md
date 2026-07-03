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
  notifications:

  ```sh
  brew install alerter
  ```

  The first notification will trigger a macOS permission prompt; allow it.
  Then, in **System Settings → Notifications → alerter**, set the notification
  style to **Alerts** — the default "Banners" style auto-dismisses after a few
  seconds and hides the **Upload** button. Clicking the notification body also
  counts as confirming the upload.

- A Cloudflare R2 bucket with **public access enabled** (an `r2.dev` public URL
  or a custom domain) and an S3 API access key pair.

## Setup

One-time steps in the Cloudflare dashboard:

1. **Create a bucket**: **R2 Object Storage → Create bucket**. Any name; the
   default (automatic) location is fine.
2. **Enable public access**: open the bucket → **Settings → Public access →
   R2.dev subdomain → Allow Access**. Copy the public URL it shows (it looks
   like `https://pub-xxxxxxxx.r2.dev`) — that is your `publicBaseUrl`. (A
   custom domain connected to the bucket works too.)
3. **Create an S3 API token**: **R2 Object Storage → API → Manage API tokens →
   Create API token**. Give it **Object Read & Write** scoped to your bucket.
   Note the **Access Key ID** and **Secret Access Key** (shown once), and your
   **Account ID** (shown on the R2 overview page and in the S3 endpoint).

   Note: the setup wizard also sets a bucket **lifecycle rule** (auto-expiry),
   which needs bucket-level permission. If setup warns that the lifecycle rule
   was denied, create the token with **Admin Read & Write** instead and re-run
   setup.

Then run the wizard:

```sh
bun install
bun run dev setup
```

It prompts for each value (re-running shows your current values as defaults),
writes `~/.config/spootie/config.json` (mode 0600), applies the expiry
lifecycle rule, and verifies the whole pipeline with a small test upload that
is fetched over its public URL and then deleted.

## Configuration

The setup wizard writes `~/.config/spootie/config.json`; you can also create
or edit it by hand:

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

- `accountId` — used to build the S3 endpoint
  `https://<accountId>.r2.cloudflarestorage.com`.
- `publicBaseUrl` — the public base URL of the bucket. The share URL is
  `publicBaseUrl + "/" + key`.
- `expiryDays` — how long uploads stay before R2 auto-deletes them, enforced
  by a bucket lifecycle rule (rule ID `spootie-expiry`) that `spootie setup`
  applies. Defaults to `7` if omitted. If you change it by hand, re-run
  `spootie setup` to update the rule.

## Running

Install dependencies once:

```sh
bun install
```

Start watching (foreground process):

```sh
bun run dev watch
# or, equivalently:
bun run src/index.ts watch
```

Stop it with Ctrl+C.

### Screenshot folder detection

The watched folder is read from your macOS setting:

```sh
defaults read com.apple.screencapture location
```

If that is not set, it falls back to `~/Desktop`. Only files whose names match
the macOS screenshot pattern (e.g. `Screenshot 2026-07-03 at 20.14.30.png`) are
considered. Screen recordings are ignored.

## Offline queue

If you click **Upload** while offline (or the upload fails for any
network-level reason — DNS, connection refused/reset, timeouts, 5xx), the
upload is queued instead of lost:

- You get an "Offline — upload queued" notification.
- The queue is stored at `~/Library/Application Support/spootie/queue.json`
  (written atomically), so queued uploads survive restarting `spootie watch` —
  pending items resume on startup.
- While the daemon runs it retries in order with exponential backoff: 5s,
  doubling up to a 60s cap, resetting after a success.
- When a queued upload eventually succeeds, your clipboard is **not**
  overwritten (you may have copied something else since). Instead you get a
  notification with a **Copy URL** button; click it (or the notification body)
  to copy the URL. Dismissing it copies nothing.
- Errors that retrying cannot fix (bad credentials, access denied, missing
  bucket) are never queued — they show an error notification immediately. If a
  queued item hits such an error during a retry, it is dropped from the queue
  with an error notification. If the local file has been deleted by the time a
  retry runs, the entry is dropped silently (logged to the console).

## Manual test plan

1. **Setup**
   - `brew install alerter`
   - `bun install`
   - Run `bun run dev setup` and enter your R2 details. Expect:
     `✓ Config saved`, `✓ Lifecycle rule applied (... days)`, and
     `✓ Test upload publicly reachable: https://...` (open that URL pattern
     mentally — the test object itself is deleted right after).
   - Re-run `bun run dev setup` and press Enter through every prompt: it
     should keep all current values (the secret shows only its last 4 chars).
   - Check the file mode: `ls -l ~/.config/spootie/config.json` shows `-rw-------`.
   - In the Cloudflare dashboard, confirm the bucket has a lifecycle rule named
     `spootie-expiry` matching your `expiryDays`.

2. **Start the watcher**
   - Run `bun run dev watch`.
   - Confirm it logs `spootie: watching for screenshots in <folder>` and the
     folder matches your screenshot save location.

3. **Take a screenshot**
   - Press `Cmd+Shift+4` and capture a region (or `Cmd+Shift+3` for the whole
     screen).
   - Within a second or two a notification titled **spootie** with an
     **Upload** button should appear.

4. **Confirm the happy path**
   - Click **Upload**.
   - A second notification, "Uploaded — URL copied", should appear.
   - Paste (`Cmd+V`) into a browser or text field — you should get a URL like
     `https://pub-xxxx.r2.dev/<random>.png`.
   - Open the URL; the screenshot should load. Verify the original file is
     still present and unchanged in the screenshot folder.

5. **Confirm no-op on dismiss**
   - Take another screenshot and dismiss/ignore the notification (or let it
     time out after ~60s).
   - Nothing should be uploaded and the clipboard should be unchanged.

6. **Confirm clean failure**
   - Temporarily put an invalid `secretAccessKey` in the config and restart the
     watcher.
   - Take a screenshot and click **Upload**.
   - You should see an "Upload failed" notification and an error line on stderr;
     the process keeps running. Nothing is added to the offline queue (auth
     errors are not retryable).

7. **Offline queueing**
   - With valid config, turn off Wi-Fi.
   - Take a screenshot and click **Upload**.
   - Expect an "Offline — upload queued" notification and an entry in
     `~/Library/Application Support/spootie/queue.json`.
   - Copy some unrelated text, then turn Wi-Fi back on. Within ~60s (backoff),
     expect a "Queued upload finished" notification with a **Copy URL**
     button; your clipboard must still hold the unrelated text until you click
     it. Click it and confirm the URL is copied and the queue file is empty
     (`[]`) again.

8. **Queue survives restart**
   - Repeat step 7, but quit `spootie watch` (Ctrl+C) while still offline
     after the "queued" notification.
   - Restart `bun run dev watch` (still offline): it logs that queued
     upload(s) from a previous run are pending. Reconnect and confirm the
     upload completes with the **Copy URL** notification.

## Scope

Included so far: the core confirm-and-upload pipeline (milestone 1), the
`spootie setup` wizard with object auto-expiry (milestone 2), and the offline
queue with automatic retry (milestone 3). Not yet included:
LaunchAgent/background install, pause/resume, and `spootie last`.
