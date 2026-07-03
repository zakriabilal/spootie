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

  The first actionable notification will prompt for notification permission;
  allow it.

- A Cloudflare R2 bucket with **public access enabled** (an `r2.dev` public URL
  or a custom domain) and an S3 API access key pair.

## Configuration

Create `~/.config/spootie/config.json`:

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
- `expiryDays` — reserved for a later milestone (object lifecycle). Currently
  unused by the upload path; defaults to `7` if omitted.

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

## Manual test plan

1. **Setup**
   - `brew install alerter`
   - Create `~/.config/spootie/config.json` with valid R2 credentials for a
     public bucket.
   - `bun install`

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
     the process keeps running.

## Scope

This is milestone 1: the core confirm-and-upload pipeline, happy path. Not yet
included: setup wizard, object expiry/lifecycle rules, offline queueing,
LaunchAgent/background install, pause/resume, and `spootie last`.
