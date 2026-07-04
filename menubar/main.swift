// spootie-menubar: a thin macOS menu bar client for the spootie daemon's
// local dashboard API (see src/server.ts). It never touches the filesystem
// beyond reading ~/.config/spootie/state/ui.json, never runs the daemon
// itself, and never force-unwraps: every failure path (missing ui.json,
// unreachable daemon, malformed JSON) degrades to an "unreachable" state
// instead of crashing.
//
// Build: swiftc -O -o spootie-menubar menubar/main.swift
// Requires macOS 13+, no Xcode project, unsigned.

import AppKit
import Foundation

// MARK: - API models (mirrors src/server.ts's UiInfo / UiItem / status shape)

private struct UiInfo: Decodable {
    let port: Int
    let pid: Int
    let token: String
}

private struct StatusResponse: Decodable {
    let paused: Bool
    let queueLength: Int
}

private struct UiItem: Decodable {
    let id: String
    let kind: String
    let fileName: String
    let date: String
    let url: String?
}

private struct ItemsResponse: Decodable {
    let items: [UiItem]
}

private struct PauseRequestBody: Encodable {
    let paused: Bool
}

private struct PauseResponse: Decodable {
    let ok: Bool
    let paused: Bool
}

// MARK: - ui.json

/// Reads ~/.config/spootie/state/ui.json, written by the running daemon
/// (mode 0600, owner-only). Returns nil if the daemon isn't running, the
/// file is missing, or it can't be parsed — never throws.
private func readUiInfo() -> UiInfo? {
    let path = NSHomeDirectory() + "/.config/spootie/state/ui.json"
    guard let data = FileManager.default.contents(atPath: path) else { return nil }
    return try? JSONDecoder().decode(UiInfo.self, from: data)
}

// MARK: - Networking

/// Short-timeout session: the menu must never hang waiting on a dead daemon.
private let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 2
    config.timeoutIntervalForResource = 2
    return URLSession(configuration: config)
}()

/// Runs a request and blocks the calling thread until it completes, the
/// session's own ~2s timeout fires, or the outer 3s safety margin elapses.
/// Never throws; nil means "treat the daemon as unreachable" to every caller.
/// Callers are expected to invoke this off the main thread; the brief,
/// intentional main-thread block (from menuWillOpen's synchronous refresh)
/// happens at the group.wait in refresh(), not here.
private func fetchSync<T: Decodable>(_ request: URLRequest, as type: T.Type) -> T? {
    let semaphore = DispatchSemaphore(value: 0)
    var result: T?
    let task = session.dataTask(with: request) { data, response, error in
        defer { semaphore.signal() }
        guard error == nil,
              let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode),
              let data = data
        else { return }
        result = try? JSONDecoder().decode(T.self, from: data)
    }
    task.resume()
    _ = semaphore.wait(timeout: .now() + 3)
    return result
}

/// Builds http://127.0.0.1:<port><path>?token=<token>, matching uiUrl() /
/// the API routes in src/server.ts. Returns nil only if URLComponents
/// somehow fails to assemble a URL (defensive; should not happen for a
/// fixed loopback host).
private func apiURL(_ info: UiInfo, path: String) -> URL? {
    var components = URLComponents()
    components.scheme = "http"
    components.host = "127.0.0.1"
    components.port = info.port
    components.path = path
    components.queryItems = [URLQueryItem(name: "token", value: info.token)]
    return components.url
}

private func fetchStatus(_ info: UiInfo) -> StatusResponse? {
    guard let url = apiURL(info, path: "/api/status") else { return nil }
    return fetchSync(URLRequest(url: url), as: StatusResponse.self)
}

private func fetchItems(_ info: UiInfo) -> ItemsResponse? {
    guard let url = apiURL(info, path: "/api/items") else { return nil }
    return fetchSync(URLRequest(url: url), as: ItemsResponse.self)
}

/// Posts the new paused state. URLSession sends no Origin header on plain
/// requests like this, which src/server.ts's isAllowedOrigin() treats as
/// same-origin (origin === null), so no extra header is needed here.
private func postPause(_ info: UiInfo, paused: Bool) -> Bool {
    guard let url = apiURL(info, path: "/api/pause") else { return false }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    guard let body = try? JSONEncoder().encode(PauseRequestBody(paused: paused)) else {
        return false
    }
    request.httpBody = body
    return fetchSync(request, as: PauseResponse.self)?.ok ?? false
}

// MARK: - App state

/// Snapshot of daemon state used to render the icon and menu. `uiInfo` is
/// kept even when unreachable so a transient failure doesn't forget the port
/// the daemon last advertised (a fresh readUiInfo() happens on every refresh
/// anyway, so this is mostly for "Open Dashboard" staying enabled sensibly).
private struct Snapshot {
    let reachable: Bool
    let paused: Bool
    let queueLength: Int
    let items: [UiItem]
    let uiInfo: UiInfo?

    static let unreachable = Snapshot(reachable: false, paused: false, queueLength: 0, items: [], uiInfo: nil)
}

final class MenuBarController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let menu = NSMenu()
    private var iconTimer: Timer?
    private var snapshot = Snapshot.unreachable

    func applicationDidFinishLaunching(_ notification: Notification) {
        // No Dock icon, no app switcher entry — this is a menu-bar-only utility.
        NSApp.setActivationPolicy(.accessory)

        menu.delegate = self
        // AppKit's default autoenablesItems would otherwise ignore every
        // isEnabled assignment below (and silently keep nil-action items
        // enabled), so every item's enabled state below is now explicit.
        menu.autoenablesItems = false
        statusItem.menu = menu
        updateIcon()

        refresh(rebuildMenu: true)

        // Scheduled with .common so it keeps ticking while the menu is open
        // and tracking the mouse (default-mode timers pause during tracking).
        let timer = Timer(timeInterval: 10, repeats: true) { [weak self] _ in
            self?.refreshIconOnly()
        }
        RunLoop.main.add(timer, forMode: .common)
        iconTimer = timer
    }

    // MARK: NSMenuDelegate

    /// Refreshes status + items every time the user opens the menu, so it
    /// never shows more than a few seconds of staleness. This briefly blocks
    /// the main thread (menu tracking is already synchronous UI work), capped
    /// by the ~2-3s network timeouts above.
    func menuWillOpen(_ menu: NSMenu) {
        refresh(rebuildMenu: true)
    }

    // MARK: Refresh

    private func refresh(rebuildMenu: Bool) {
        guard let info = readUiInfo() else {
            snapshot = Snapshot.unreachable
            applySnapshot(rebuildMenu: rebuildMenu)
            return
        }

        let group = DispatchGroup()
        var status: StatusResponse?
        var items: ItemsResponse?

        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            status = fetchStatus(info)
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            items = fetchItems(info)
            group.leave()
        }
        _ = group.wait(timeout: .now() + 3)

        if let status = status {
            snapshot = Snapshot(
                reachable: true,
                paused: status.paused,
                queueLength: status.queueLength,
                items: items?.items ?? [],
                uiInfo: info
            )
        } else {
            snapshot = Snapshot(reachable: false, paused: false, queueLength: 0, items: [], uiInfo: info)
        }
        applySnapshot(rebuildMenu: rebuildMenu)
    }

    /// Lightweight periodic refresh for the icon only: a single /api/status
    /// call off the main thread, never touches the (possibly open) menu's
    /// item list.
    private func refreshIconOnly() {
        guard let info = readUiInfo() else {
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.snapshot = Snapshot(
                    reachable: false, paused: false, queueLength: 0,
                    items: self.snapshot.items, uiInfo: nil
                )
                self.updateIcon()
            }
            return
        }
        DispatchQueue.global(qos: .utility).async {
            let status = fetchStatus(info)
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                if let status = status {
                    self.snapshot = Snapshot(
                        reachable: true,
                        paused: status.paused,
                        queueLength: status.queueLength,
                        items: self.snapshot.items,
                        uiInfo: info
                    )
                } else {
                    self.snapshot = Snapshot(
                        reachable: false, paused: false, queueLength: 0,
                        items: self.snapshot.items, uiInfo: info
                    )
                }
                self.updateIcon()
            }
        }
    }

    private func applySnapshot(rebuildMenu: Bool) {
        updateIcon()
        if rebuildMenu {
            rebuildMenuItems()
        }
    }

    // MARK: Icon

    private func updateIcon() {
        guard let button = statusItem.button else { return }
        button.image = icon(for: snapshot)
    }

    /// SF Symbols, marked as template images so they adapt to light/dark menu
    /// bars automatically.
    private func icon(for snapshot: Snapshot) -> NSImage? {
        let symbolName: String
        let description: String
        if !snapshot.reachable {
            symbolName = "exclamationmark.triangle"
            description = "spootie daemon not running"
        } else if snapshot.paused {
            symbolName = "pause.circle"
            description = "spootie paused"
        } else {
            symbolName = "camera.on.rectangle"
            description = "spootie watching"
        }
        let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: description)
        image?.isTemplate = true
        return image
    }

    // MARK: Menu building

    private func rebuildMenuItems() {
        menu.removeAllItems()

        let statusTitle: String
        if !snapshot.reachable {
            statusTitle = "spootie daemon not running"
        } else if snapshot.paused {
            statusTitle = "Paused"
        } else {
            statusTitle = "Watching"
        }
        let statusLine = NSMenuItem(
            title: snapshot.queueLength > 0 ? "\(statusTitle) — \(snapshot.queueLength) queued" : statusTitle,
            action: nil,
            keyEquivalent: ""
        )
        statusLine.isEnabled = false
        menu.addItem(statusLine)

        if snapshot.reachable {
            let toggle = NSMenuItem(
                title: snapshot.paused ? "Resume" : "Pause",
                action: #selector(togglePause),
                keyEquivalent: ""
            )
            toggle.target = self
            toggle.isEnabled = true
            menu.addItem(toggle)
        }

        menu.addItem(NSMenuItem.separator())

        let recent = snapshot.items.prefix(10)
        if recent.isEmpty {
            let empty = NSMenuItem(title: "No recent uploads", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for item in recent {
                let isUploaded = item.kind == "uploaded"
                let title = isUploaded ? item.fileName : "\(item.fileName) — queued"
                let menuItem = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                // Only bind an action + representedObject when there is an
                // actual URL to copy; queued items (and any uploaded item
                // that unexpectedly lacks a URL) stay disabled instead of
                // wiring up a copy action with nothing to copy.
                if isUploaded, let urlString = item.url {
                    menuItem.action = #selector(copyItemURL(_:))
                    menuItem.target = self
                    menuItem.representedObject = urlString
                    menuItem.isEnabled = true
                } else {
                    menuItem.isEnabled = false
                }
                menu.addItem(menuItem)
            }
        }

        menu.addItem(NSMenuItem.separator())

        let openDashboardItem = NSMenuItem(title: "Open Dashboard", action: #selector(openDashboard), keyEquivalent: "")
        openDashboardItem.target = self
        openDashboardItem.isEnabled = snapshot.uiInfo != nil
        menu.addItem(openDashboardItem)

        menu.addItem(NSMenuItem.separator())

        // Quits this menu bar helper only; never touches the daemon process.
        let quit = NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        quit.isEnabled = true
        menu.addItem(quit)
    }

    // MARK: Actions

    @objc private func togglePause() {
        guard let info = snapshot.uiInfo else { return }
        let newPaused = !snapshot.paused
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            _ = postPause(info, paused: newPaused)
            DispatchQueue.main.async {
                self?.refresh(rebuildMenu: true)
            }
        }
    }

    @objc private func copyItemURL(_ sender: NSMenuItem) {
        guard let urlString = sender.representedObject as? String else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(urlString, forType: .string)
    }

    @objc private func openDashboard() {
        guard let info = snapshot.uiInfo, let url = apiURL(info, path: "/") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }
}

// MARK: - Entry point

let app = NSApplication.shared
let delegate = MenuBarController()
app.delegate = delegate
app.run()
