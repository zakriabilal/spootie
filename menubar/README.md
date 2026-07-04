# spootie menu bar app

A minimal, unsigned macOS menu bar client for the `spootie` daemon. It is a
thin UI over the same local dashboard API the web dashboard uses
(`src/server.ts`'s `/api/status`, `/api/items`, `/api/pause`) — it holds no
state of its own beyond what it reads from `~/.config/spootie/state/ui.json`
and fetches over the loopback API.

## What it does

- Shows a menu bar icon reflecting daemon state: watching (camera icon),
  paused (pause icon), or daemon unreachable (warning triangle). All icons
  are SF Symbols template images, so they adapt to light/dark menu bars.
- Opening the menu shows: a status line ("Watching" / "Paused" / "spootie
  daemon not running", plus "N queued" when the queue is non-empty), a
  Pause/Resume toggle, up to 10 most recent uploaded/queued items (clicking
  an uploaded item copies its URL to the clipboard), an "Open Dashboard" item
  that opens the full web UI in your default browser, and Quit.
- Refreshes on launch, every time the menu is opened, and a ~10s background
  timer keeps the icon (not the item list) current even while the menu is
  closed.

## What it does not do

- It does not start, stop, restart, or otherwise manage the daemon. It only
  reads `ui.json` and calls the API; if the daemon isn't running, the menu
  just shows "spootie daemon not running", the Pause/Resume toggle is
  omitted entirely, and the recent-items list shows a disabled "No recent
  uploads" line. "Open Dashboard" stays disabled only if `ui.json` itself
  couldn't be read (no port/token to open); if it was read but the status
  call failed, "Open Dashboard" remains enabled since the last-known port
  is still worth trying. "Quit" is always enabled.
- "Quit" only quits this menu bar helper — it never touches the daemon
  process.

## Requirements

- macOS 13 or later.
- The `spootie` daemon already running (`spootie watch`, or installed as a
  LaunchAgent via `spootie install`), so `~/.config/spootie/state/ui.json`
  exists and the local API is reachable.

## Building

No Xcode project, no code signing — just the Swift compiler:

```sh
swiftc -O -o spootie-menubar menubar/main.swift
./spootie-menubar
```

The binary is unsigned and built locally; there is no distributed/notarized
build. Launching it via Finder may trigger a Gatekeeper warning — running it
from Terminal (as above) avoids that. To keep it running in the background,
launch it detached, e.g. `./spootie-menubar & disown`, or wire it into your
own login item / LaunchAgent (not provided here — this only covers the
`spootie watch` daemon).
