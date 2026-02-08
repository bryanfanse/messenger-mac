const {
    app,
    BrowserWindow,
    shell,
    Menu,
    session,
    dialog,
    net,
    screen,
} = require("electron");
const path = require("path");
const fs = require("fs");

const CURRENT_VERSION = app.getVersion();
const GITHUB_REPO =
    process.env.MESSENGER_GITHUB_REPO || "bryanfanse/messenger-mac";
const DEBUG_COOKIES = process.env.DEBUG_COOKIES === "1";
const STARTUP_METRICS_ENABLED = process.env.STARTUP_METRICS !== "0";
const COOKIE_PERSIST_SECONDS = 365 * 24 * 60 * 60;
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);
const INTERNAL_HOST_RULES = [
    (hostname) =>
        hostname === "messenger.com" || hostname.endsWith(".messenger.com"),
    (hostname) =>
        hostname === "facebook.com" || hostname.endsWith(".facebook.com"),
    (hostname) => hostname === "m.me",
];
const IPC_CHANNELS = {
    setSidebarVisible: "messenger-app:set-sidebar-visible",
    createNewMessage: "messenger-app:create-new-message",
    switchConversation: "messenger-app:switch-conversation",
    showReconnectBanner: "messenger-app:show-reconnect-banner",
    clearReconnectBanner: "messenger-app:clear-reconnect-banner",
    attachNetworkWatcher: "messenger-app:attach-network-watcher",
};

// Set app data path explicitly
app.setPath("userData", path.join(app.getPath("appData"), "MessengerApp"));

let mainWindow;

// Settings file path
const settingsPath = path.join(app.getPath("userData"), "settings.json");
const windowStatePath = path.join(app.getPath("userData"), "window-state.json");
const SETTINGS_SAVE_DEBOUNCE_MS = 150;
const WINDOW_SHOW_FALLBACK_MS = 1400;
const COOKIE_FLUSH_INTERVAL_MS = 250;
let settingsSaveTimer = null;
let pendingSettingsWrite = null;
const startupEpochHr = process.hrtime.bigint();
const startupLogPath = path.join(app.getPath("userData"), "startup-metrics.log");

function getElapsedMs(startHr) {
    return Number(process.hrtime.bigint() - startHr) / 1e6;
}

function writeStartupMetric(event, details = {}) {
    if (!STARTUP_METRICS_ENABLED) return;
    const payload = {
        at: new Date().toISOString(),
        event,
        sinceLaunchMs: Number(getElapsedMs(startupEpochHr).toFixed(1)),
        ...details,
    };
    fs.appendFile(startupLogPath, JSON.stringify(payload) + "\n", () => {});
}

// Generate unique install ID
function generateInstallId() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
}

// Load settings
function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        }
    } catch (e) {}
    return {
        sidebarVisible: true,
        hasSeenWelcome: false,
        installId: generateInstallId(),
        lastPingDate: null,
    };
}

// Save settings
function saveSettings(settings) {
    pendingSettingsWrite = JSON.stringify(settings, null, 2);
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(() => {
        const payload = pendingSettingsWrite;
        pendingSettingsWrite = null;
        fs.writeFile(settingsPath, payload, () => {});
    }, SETTINGS_SAVE_DEBOUNCE_MS);
}

function flushPendingSettingsWrite() {
    if (!pendingSettingsWrite) return;
    const payload = pendingSettingsWrite;
    pendingSettingsWrite = null;
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    try {
        fs.writeFileSync(settingsPath, payload);
    } catch (e) {}
}

function loadWindowState() {
    const defaults = {
        width: 1200,
        height: 800,
        minWidth: 400,
        minHeight: 600,
    };

    try {
        if (fs.existsSync(windowStatePath)) {
            const parsed = JSON.parse(fs.readFileSync(windowStatePath, "utf8"));
            return { ...defaults, ...parsed };
        }
    } catch (e) {}

    return defaults;
}

function saveWindowState(window) {
    if (!window || window.isDestroyed()) return;

    try {
        const isMaximized = window.isMaximized();
        const isFullScreen = window.isFullScreen();
        const bounds =
            isMaximized || isFullScreen
                ? window.getNormalBounds()
                : window.getBounds();

        fs.writeFileSync(
            windowStatePath,
            JSON.stringify(
                {
                    ...bounds,
                    isMaximized,
                    isFullScreen,
                },
                null,
                2,
            ),
        );
    } catch (e) {}
}

function rectanglesIntersect(a, b) {
    const overlapX = a.x < b.x + b.width && a.x + a.width > b.x;
    const overlapY = a.y < b.y + b.height && a.y + a.height > b.y;
    return overlapX && overlapY;
}

function sanitizeWindowState(state) {
    const minWidth = Number.isFinite(state.minWidth) ? state.minWidth : 400;
    const minHeight = Number.isFinite(state.minHeight) ? state.minHeight : 600;
    const displays = screen.getAllDisplays();
    const workAreas = displays.map((display) => display.workArea);

    const maxWidth = Math.max(...workAreas.map((area) => area.width), minWidth);
    const maxHeight = Math.max(
        ...workAreas.map((area) => area.height),
        minHeight,
    );

    const width = Math.max(minWidth, Math.min(state.width || 1200, maxWidth));
    const height = Math.max(
        minHeight,
        Math.min(state.height || 800, maxHeight),
    );

    const sanitized = {
        ...state,
        width,
        height,
        minWidth,
        minHeight,
    };

    if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) {
        sanitized.x = undefined;
        sanitized.y = undefined;
        return sanitized;
    }

    const windowRect = {
        x: state.x,
        y: state.y,
        width,
        height,
    };
    const isVisibleOnAnyDisplay = workAreas.some((area) =>
        rectanglesIntersect(windowRect, area),
    );

    if (!isVisibleOnAnyDisplay) {
        sanitized.x = undefined;
        sanitized.y = undefined;
    }

    return sanitized;
}

function sendRendererCommand(channel, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
}

let settings = loadSettings();

// Check for updates and track usage
function checkForUpdates(silent = false) {
    const request = net.request({
        method: "GET",
        url: `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    });

    request.setHeader("User-Agent", `MessengerApp/${CURRENT_VERSION}`);

    request.on("response", (response) => {
        let data = "";
        response.on("data", (chunk) => {
            data += chunk;
        });
        response.on("end", () => {
            try {
                const release = JSON.parse(data);
                const latestVersion = release.tag_name.replace("v", "");

                if (latestVersion !== CURRENT_VERSION) {
                    dialog
                        .showMessageBox(mainWindow, {
                            type: "info",
                            title: "Update Available",
                            message: `A new version (v${latestVersion}) is available!`,
                            detail: `You have v${CURRENT_VERSION}. Would you like to download the update?`,
                            buttons: ["Download", "Later"],
                            defaultId: 0,
                        })
                        .then(({ response }) => {
                            if (response === 0) {
                                shell.openExternal(release.html_url);
                            }
                        });
                } else if (!silent) {
                    dialog.showMessageBox(mainWindow, {
                        type: "info",
                        title: "No Updates",
                        message: "You're up to date!",
                        detail: `Version ${CURRENT_VERSION} is the latest.`,
                    });
                }
            } catch (e) {}
        });
    });

    request.on("error", () => {});
    request.end();

    // Track unique daily active users (per-day counter for history)
    const today = new Date().toISOString().split("T")[0];
    if (settings.lastPingDate !== today) {
        if (!settings.installId) {
            settings.installId = generateInstallId();
        }
        settings.lastPingDate = today;
        saveSettings(settings);

        // Ping daily counter (e.g., daily-2025-12-26)
        const dailyPing = net.request({
            method: "GET",
            url: `https://api.counterapi.dev/v1/messenger-mac/daily-${today}/up`,
        });
        dailyPing.on("error", () => {});
        dailyPing.end();

        // Also ping total unique users (first time only)
        if (!settings.countedAsUser) {
            settings.countedAsUser = true;
            saveSettings(settings);
            const totalPing = net.request({
                method: "GET",
                url: "https://api.counterapi.dev/v1/messenger-mac/total-users/up",
            });
            totalPing.on("error", () => {});
            totalPing.end();
        }
    }
}

// Show welcome window on first launch
function showWelcomeWindow() {
    const welcomeWindow = new BrowserWindow({
        width: 560,
        height: 620,
        resizable: false,
        minimizable: false,
        maximizable: false,
        alwaysOnTop: true,
        titleBarStyle: "hiddenInset",
        backgroundColor: "#0b1020",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
        },
    });

    const welcomeHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        :root {
          --bg-top: #0f4ea8;
          --bg-bottom: #0b1430;
          --text-main: #f3f8ff;
          --text-dim: #c5d8ff;
          --card: rgba(255, 255, 255, 0.14);
          --card-border: rgba(255, 255, 255, 0.25);
          --chip-bg: rgba(255, 255, 255, 0.18);
          --chip-border: rgba(255, 255, 255, 0.3);
          --btn-bg: #ffffff;
          --btn-text: #0a2f75;
          --btn-hover: #eaf2ff;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: "Avenir Next", "SF Pro Display", "Segoe UI", sans-serif;
          background:
            radial-gradient(circle at 85% 12%, rgba(94, 173, 255, 0.3) 0%, transparent 40%),
            radial-gradient(circle at 10% 80%, rgba(34, 211, 238, 0.22) 0%, transparent 45%),
            linear-gradient(150deg, var(--bg-top) 0%, var(--bg-bottom) 78%);
          color: var(--text-main);
          padding: 34px 30px 28px;
          -webkit-app-region: drag;
          user-select: none;
          min-height: 100vh;
          overflow: hidden;
        }
        .glow {
          position: absolute;
          width: 240px;
          height: 240px;
          border-radius: 999px;
          filter: blur(38px);
          opacity: 0.45;
          pointer-events: none;
        }
        .g1 { top: -90px; right: -90px; background: #38bdf8; animation: drift1 10s ease-in-out infinite; }
        .g2 { bottom: -110px; left: -70px; background: #60a5fa; animation: drift2 12s ease-in-out infinite; }
        h1 {
          font-size: 30px;
          line-height: 1.1;
          margin-bottom: 10px;
          letter-spacing: 0.2px;
          position: relative;
          z-index: 1;
          animation: fadeUp 500ms ease-out both;
        }
        .subtitle {
          color: var(--text-dim);
          margin-bottom: 22px;
          font-size: 14px;
          max-width: 450px;
          line-height: 1.45;
          position: relative;
          z-index: 1;
          animation: fadeUp 620ms ease-out both;
        }
        .section {
          background: var(--card);
          border: 1px solid var(--card-border);
          border-radius: 16px;
          padding: 16px;
          margin-bottom: 12px;
          backdrop-filter: blur(8px);
          position: relative;
          z-index: 1;
          animation: fadeUp 760ms ease-out both;
        }
        .section-title {
          font-weight: 600;
          margin-bottom: 10px;
          font-size: 13px;
          text-transform: uppercase;
          letter-spacing: 0.7px;
          color: #dce9ff;
        }
        .shortcut {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 0;
          font-size: 13px;
          gap: 12px;
        }
        .shortcut span:first-child {
          color: #f4f8ff;
        }
        .key {
          background: var(--chip-bg);
          border: 1px solid var(--chip-border);
          padding: 4px 10px;
          border-radius: 999px;
          font-family: "SF Mono", Menlo, Monaco, monospace;
          font-size: 11px;
          letter-spacing: 0.4px;
          color: #eef5ff;
        }
        .feature {
          display: grid;
          grid-template-columns: 22px 1fr;
          align-items: start;
          gap: 10px;
          padding: 7px 0;
          font-size: 13px;
          color: #ebf3ff;
        }
        .feature-icon { font-size: 16px; line-height: 1.2; }
        .actions {
          display: flex;
          justify-content: center;
          gap: 10px;
          margin-top: 16px;
          position: relative;
          z-index: 1;
          animation: fadeUp 880ms ease-out both;
        }
        button {
          -webkit-app-region: no-drag;
          background: var(--btn-bg);
          color: var(--btn-text);
          border: none;
          padding: 11px 26px;
          border-radius: 999px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 140ms ease, background 140ms ease;
        }
        button:hover { background: var(--btn-hover); transform: translateY(-1px); }
        .ghost {
          background: transparent;
          border: 1px solid rgba(255, 255, 255, 0.45);
          color: #f0f6ff;
        }
        .ghost:hover {
          background: rgba(255, 255, 255, 0.1);
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes drift1 {
          0%, 100% { transform: translate(0, 0); }
          50% { transform: translate(-10px, 12px); }
        }
        @keyframes drift2 {
          0%, 100% { transform: translate(0, 0); }
          50% { transform: translate(12px, -8px); }
        }
      </style>
    </head>
    <body>
      <div class="glow g1"></div>
      <div class="glow g2"></div>

      <h1>Messenger for Mac</h1>
      <p class="subtitle">A cleaner desktop home for your chats. Your shortcuts and sidebar preference are remembered automatically.</p>

      <div class="section">
        <div class="section-title">Keyboard Shortcuts</div>
        <div class="shortcut"><span>New Message</span><span class="key">Cmd + N</span></div>
        <div class="shortcut"><span>Switch Conversations</span><span class="key">Cmd + 1-9</span></div>
        <div class="shortcut"><span>Toggle Sidebar</span><span class="key">Cmd + Shift + S</span></div>
      </div>

      <div class="section">
        <div class="section-title">Built-In Comfort</div>
        <div class="feature"><span class="feature-icon">•</span><span>Power-saving mode automatically applies in the background.</span></div>
        <div class="feature"><span class="feature-icon">•</span><span>Login stays persistent so you can reopen without extra steps.</span></div>
        <div class="feature"><span class="feature-icon">•</span><span>Sidebar visibility is kept between restarts.</span></div>
      </div>

      <div class="actions">
        <button class="ghost" onclick="window.open('https://github.com/bryanfanse/messenger-mac/releases', '_blank')">Release Notes</button>
        <button onclick="window.close()">Get Started</button>
      </div>
    </body>
    </html>
  `;

    welcomeWindow.loadURL(
        "data:text/html;charset=utf-8," + encodeURIComponent(welcomeHTML),
    );

    welcomeWindow.on("closed", () => {
        settings.hasSeenWelcome = true;
        saveSettings(settings);
    });
}

function createWindow() {
    const createWindowStartedHr = process.hrtime.bigint();
    writeStartupMetric("create_window_started");
    const savedWindowState = sanitizeWindowState(loadWindowState());

    mainWindow = new BrowserWindow({
        width: savedWindowState.width,
        height: savedWindowState.height,
        x: Number.isFinite(savedWindowState.x) ? savedWindowState.x : undefined,
        y: Number.isFinite(savedWindowState.y) ? savedWindowState.y : undefined,
        minWidth: savedWindowState.minWidth,
        minHeight: savedWindowState.minHeight,
        show: false,
        backgroundColor: "#0b1020",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false,
        },
    });

    let hasShownMainWindow = false;
    const showMainWindow = (reason) => {
        if (hasShownMainWindow || !mainWindow || mainWindow.isDestroyed()) return;
        hasShownMainWindow = true;
        mainWindow.show();
        writeStartupMetric("window_shown", {
            reason,
            createWindowMs: Number(getElapsedMs(createWindowStartedHr).toFixed(1)),
        });
        if (savedWindowState.isMaximized) {
            mainWindow.maximize();
        }
        if (savedWindowState.isFullScreen) {
            mainWindow.setFullScreen(true);
        }
    };

    mainWindow.once("ready-to-show", () => showMainWindow("ready-to-show"));
    const windowShowFallbackTimer = setTimeout(
        () => showMainWindow("fallback-timeout"),
        WINDOW_SHOW_FALLBACK_MS,
    );

    let windowStateSaveTimer;
    let cookieFlushTimer = null;
    const pendingPersistentCookies = new Map();
    let isFlushingCookies = false;

    const flushPersistentCookies = () => {
        if (isFlushingCookies || pendingPersistentCookies.size === 0) return;
        isFlushingCookies = true;
        const cookiesToPersist = Array.from(pendingPersistentCookies.values());
        pendingPersistentCookies.clear();

        Promise.all(
            cookiesToPersist.map((cookieToPersist) =>
                session.defaultSession.cookies.set(cookieToPersist).catch((err) => {
                    if (DEBUG_COOKIES) {
                        log(`Cookie error: ${err}`);
                    }
                }),
            ),
        ).finally(() => {
            isFlushingCookies = false;
            if (pendingPersistentCookies.size > 0) {
                flushPersistentCookies();
            }
        });
    };

    const schedulePersistentCookieFlush = () => {
        if (cookieFlushTimer) return;
        cookieFlushTimer = setTimeout(() => {
            cookieFlushTimer = null;
            flushPersistentCookies();
        }, COOKIE_FLUSH_INTERVAL_MS);
    };

    const scheduleWindowStateSave = () => {
        clearTimeout(windowStateSaveTimer);
        windowStateSaveTimer = setTimeout(
            () => saveWindowState(mainWindow),
            250,
        );
    };
    mainWindow.on("resize", scheduleWindowStateSave);
    mainWindow.on("move", scheduleWindowStateSave);
    mainWindow.on("maximize", scheduleWindowStateSave);
    mainWindow.on("unmaximize", scheduleWindowStateSave);
    mainWindow.on("enter-full-screen", scheduleWindowStateSave);
    mainWindow.on("leave-full-screen", scheduleWindowStateSave);

    // Track cookies recently persisted to avoid repeated writes on the same value.
    const cookiePersistenceCache = new Map();
    const cookieCacheTtlMs = 10 * 60 * 1000;

    const logFile = path.join(app.getPath("userData"), "cookies.log");
    const log = (msg) => {
        if (!DEBUG_COOKIES) return;
        const line = `${new Date().toISOString()} - ${msg}\n`;
        fs.appendFile(logFile, line, () => {});
    };

    // Convert session cookies to persistent cookies
    session.defaultSession.cookies.on(
        "changed",
        (event, cookie, cause, removed) => {
            const isFacebookDomain =
                cookie.domain.includes("facebook.com") ||
                cookie.domain.includes("messenger.com");
            if (DEBUG_COOKIES) {
                log(
                    `Cookie: ${cookie.name} | domain: ${cookie.domain} | session: ${cookie.session} | removed: ${removed}`,
                );
            }

            if (!removed && cookie.session && isFacebookDomain) {
                const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
                const now = Date.now();
                const existing = cookiePersistenceCache.get(key);
                if (
                    existing &&
                    existing.value === cookie.value &&
                    now - existing.updatedAt < cookieCacheTtlMs
                ) {
                    return;
                }

                // Make session cookie persistent (expire in 1 year)
                const persistentCookie = {
                    url: `https://${cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain}${cookie.path}`,
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path,
                    secure: cookie.secure,
                    httpOnly: cookie.httpOnly,
                    sameSite: cookie.sameSite || "no_restriction",
                    expirationDate:
                        Math.floor(now / 1000) + COOKIE_PERSIST_SECONDS,
                };

                cookiePersistenceCache.set(key, {
                    value: cookie.value,
                    updatedAt: now,
                });
                if (cookiePersistenceCache.size > 500) {
                    const cutoff = now - cookieCacheTtlMs;
                    for (const [
                        cacheKey,
                        state,
                    ] of cookiePersistenceCache.entries()) {
                        if (state.updatedAt < cutoff) {
                            cookiePersistenceCache.delete(cacheKey);
                        }
                    }
                }

                if (DEBUG_COOKIES) {
                    log(`Converting to persistent: ${cookie.name}`);
                }

                pendingPersistentCookies.set(key, persistentCookie);
                schedulePersistentCookieFlush();
            }
        },
    );

    // Load Facebook Messenger
    mainWindow.loadURL("https://www.messenger.com");

    // Give user clear feedback while pages/resources are loading.
    mainWindow.webContents.once("did-start-loading", () => {
        writeStartupMetric("first_did_start_loading", {
            createWindowMs: Number(getElapsedMs(createWindowStartedHr).toFixed(1)),
        });
    });
    mainWindow.webContents.on("did-start-loading", () => {
        mainWindow.setProgressBar(0.25);
    });
    mainWindow.webContents.on("did-stop-loading", () => {
        mainWindow.setProgressBar(-1);
    });
    mainWindow.webContents.on(
        "did-fail-load",
        (event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
            if (!isMainFrame || errorCode === -3) return;
            sendRendererCommand(
                IPC_CHANNELS.showReconnectBanner,
                `Connection issue: ${errorDescription} (${errorCode}).`,
            );
        },
    );

    // Apply sidebar state when page finishes loading
    mainWindow.webContents.once("did-finish-load", () => {
        writeStartupMetric("first_did_finish_load", {
            createWindowMs: Number(getElapsedMs(createWindowStartedHr).toFixed(1)),
        });
    });
    mainWindow.webContents.on("did-finish-load", () => {
        sendRendererCommand(IPC_CHANNELS.attachNetworkWatcher);
        sendRendererCommand(IPC_CHANNELS.clearReconnectBanner);
        setTimeout(() => applySidebarState(), 1000);
    });

    // Power saving: throttle when window is hidden/minimized/unfocused
    mainWindow.on("blur", () => {
        mainWindow.webContents.setBackgroundThrottling(true);
    });

    mainWindow.on("focus", () => {
        mainWindow.webContents.setBackgroundThrottling(false);
    });

    mainWindow.on("minimize", () => {
        mainWindow.webContents.setBackgroundThrottling(true);
    });

    mainWindow.on("restore", () => {
        mainWindow.webContents.setBackgroundThrottling(false);
    });

    // Check if URL is a Messenger/Facebook redirect link and extract real URL
    function getExternalUrl(url) {
        try {
            const parsed = new URL(url);
            // Handle l.messenger.com and l.facebook.com redirect links
            if (
                parsed.hostname === "l.messenger.com" ||
                parsed.hostname === "l.facebook.com"
            ) {
                const realUrl = parsed.searchParams.get("u");
                if (realUrl) {
                    const redirectUrl = new URL(realUrl);
                    if (ALLOWED_EXTERNAL_PROTOCOLS.has(redirectUrl.protocol)) {
                        return redirectUrl.toString();
                    }
                }
            }
        } catch (e) {}
        return null;
    }

    // Check if URL should stay in app
    function isInternalUrl(url) {
        try {
            const parsed = new URL(url);
            if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false;
            if (
                parsed.hostname === "l.messenger.com" ||
                parsed.hostname === "l.facebook.com"
            )
                return false;
            return INTERNAL_HOST_RULES.some((rule) => rule(parsed.hostname));
        } catch (e) {
            return false;
        }
    }

    function openExternalSafe(url) {
        try {
            const parsed = new URL(url);
            if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return;
            shell.openExternal(parsed.toString());
        } catch (e) {}
    }

    // Handle external links - open in default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        const externalUrl = getExternalUrl(url);
        if (externalUrl) {
            openExternalSafe(externalUrl);
            return { action: "deny" };
        }
        if (!isInternalUrl(url)) {
            openExternalSafe(url);
            return { action: "deny" };
        }
        return { action: "allow" };
    });

    // Handle navigation to external sites
    mainWindow.webContents.on("will-navigate", (event, url) => {
        const externalUrl = getExternalUrl(url);
        if (externalUrl) {
            event.preventDefault();
            openExternalSafe(externalUrl);
            return;
        }
        if (!isInternalUrl(url)) {
            event.preventDefault();
            openExternalSafe(url);
        }
    });

    mainWindow.on("closed", () => {
        clearTimeout(windowShowFallbackTimer);
        clearTimeout(windowStateSaveTimer);
        clearTimeout(cookieFlushTimer);
        flushPersistentCookies();
        saveWindowState(mainWindow);
        mainWindow = null;
    });
}

// Toggle left sidebar visibility
function toggleLeftSidebar() {
    if (!mainWindow) return;
    settings.sidebarVisible = !settings.sidebarVisible;
    saveSettings(settings);
    applySidebarState();
}

// Apply sidebar visibility state
function applySidebarState() {
    if (!mainWindow) return;
    const visible = settings.sidebarVisible === true;
    sendRendererCommand(IPC_CHANNELS.setSidebarVisible, visible);
}

// Create new message
function createNewMessage() {
    if (!mainWindow) return;
    sendRendererCommand(IPC_CHANNELS.createNewMessage);
}

// Switch to nth conversation
function switchToConversation(n) {
    if (!mainWindow) return;
    sendRendererCommand(IPC_CHANNELS.switchConversation, n);
}

// Create application menu
function createMenu() {
    const template = [
        {
            label: app.name,
            submenu: [
                { role: "about" },
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
            ],
        },
        {
            label: "Edit",
            submenu: [
                { role: "undo" },
                { role: "redo" },
                { type: "separator" },
                { role: "cut" },
                { role: "copy" },
                { role: "paste" },
                { role: "selectAll" },
            ],
        },
        {
            label: "View",
            submenu: [
                { role: "reload" },
                { role: "forceReload" },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" },
                { type: "separator" },
                { role: "toggleDevTools", accelerator: "CmdOrCtrl+Option+I" },
            ],
        },
        {
            label: "Conversations",
            submenu: [
                {
                    label: "New Message",
                    accelerator: "CmdOrCtrl+N",
                    click: () => createNewMessage(),
                },
                { type: "separator" },
                {
                    label: "Conversation 1",
                    accelerator: "CmdOrCtrl+1",
                    click: () => switchToConversation(0),
                },
                {
                    label: "Conversation 2",
                    accelerator: "CmdOrCtrl+2",
                    click: () => switchToConversation(1),
                },
                {
                    label: "Conversation 3",
                    accelerator: "CmdOrCtrl+3",
                    click: () => switchToConversation(2),
                },
                {
                    label: "Conversation 4",
                    accelerator: "CmdOrCtrl+4",
                    click: () => switchToConversation(3),
                },
                {
                    label: "Conversation 5",
                    accelerator: "CmdOrCtrl+5",
                    click: () => switchToConversation(4),
                },
                {
                    label: "Conversation 6",
                    accelerator: "CmdOrCtrl+6",
                    click: () => switchToConversation(5),
                },
                {
                    label: "Conversation 7",
                    accelerator: "CmdOrCtrl+7",
                    click: () => switchToConversation(6),
                },
                {
                    label: "Conversation 8",
                    accelerator: "CmdOrCtrl+8",
                    click: () => switchToConversation(7),
                },
                {
                    label: "Conversation 9",
                    accelerator: "CmdOrCtrl+9",
                    click: () => switchToConversation(8),
                },
            ],
        },
        {
            label: "Window",
            submenu: [
                { role: "minimize" },
                { role: "zoom" },
                { type: "separator" },
                {
                    label: "Toggle Sidebar",
                    accelerator: "CmdOrCtrl+Shift+S",
                    click: () => toggleLeftSidebar(),
                },
                { type: "separator" },
                { role: "front" },
            ],
        },
        {
            label: "Help",
            submenu: [
                {
                    label: "Keyboard Shortcuts",
                    click: () => showWelcomeWindow(),
                },
                { type: "separator" },
                {
                    label: "Check for Updates...",
                    click: () => checkForUpdates(false),
                },
            ],
        },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
    writeStartupMetric("app_when_ready");
    createMenu();
    createWindow();

    // Show welcome window on first launch
    if (!settings.hasSeenWelcome) {
        setTimeout(() => showWelcomeWindow(), 1500);
    }

    // Check for updates silently on startup
    setTimeout(() => checkForUpdates(true), 5000);

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

// Flush cookies before quitting
app.on("before-quit", async () => {
    flushPendingSettingsWrite();
    await session.defaultSession.cookies.flushStore();
});
