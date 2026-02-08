# Messenger for Mac

Owner/Maintainer: `Bryan Phan`

A lightweight desktop wrapper for Facebook Messenger built with Electron.

Meta discontinued the old desktop app. This project keeps Messenger in a dedicated app window with persistent login, native notifications, and keyboard shortcuts.

## Highlights

- Standalone app (no browser tab required)
- Persistent login sessions
- Native notifications
- External links open in your default browser
- Power-saving background throttling
- Keyboard shortcuts for quick navigation
- Auto-update check on startup

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd + N` | New message |
| `Cmd + 1-9` | Switch to conversation 1-9 |
| `Cmd + Shift + S` | Toggle sidebar visibility |

## Download

- macOS builds are published in GitHub Releases.
- Open the latest release and download the `.dmg`:
  `https://github.com/bryanfanse/messenger-mac/releases/latest`

## Run Locally

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
git clone https://github.com/bryanfanse/messenger-mac.git
cd messenger-mac
npm install
npm start
```

## Build

### macOS

```bash
npm run build:mac
```

### Windows 11 (x64)

```bash
# Full Windows artifacts (nsis + zip)
npm run build:win

# Fast packaging test (no installer)
npm run build:win:dir
```

Notes for Windows build from macOS:

- `electron-builder` may require Wine/Mono for NSIS steps.
- If installer creation fails on macOS, `build:win:dir` should still verify packaging and produce `dist/win-unpacked/`.

## Startup Performance Metrics

Startup timing logs are enabled by default and written to:

- `~/Library/Application Support/MessengerApp/startup-metrics.log`

Logged milestones include:

- `app_when_ready`
- `create_window_started`
- `window_shown` (with reason)
- `first_did_start_loading`
- `first_did_finish_load`

Disable metrics:

```bash
STARTUP_METRICS=0 npm start
```

## Project Scripts

```bash
npm start
npm run build
npm run build:mac
npm run build:win
npm run build:win:dir
npm run build:all
```

## FAQ

### Is this an official Meta app?

No. This is an unofficial wrapper around `messenger.com`.

### Does voice/video calling work?

It should work the same as Messenger Web, since the app loads `https://www.messenger.com`.

### Where is chat content stored?

Message content is served by Meta/Facebook infrastructure. The app stores local settings/cache/session data for the desktop wrapper.

## Tech Stack

- Electron
- JavaScript (Node.js)

## License

MIT

## Disclaimer

This project is independent and not affiliated with Meta/Facebook.
