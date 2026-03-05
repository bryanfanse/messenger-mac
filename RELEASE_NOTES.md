# Release Notes

## v1.4.0 (TBD)

### Security & Privacy Improvements

- **Enhanced Security** - Removed debug cookie logging that could expose authentication tokens
- **Privacy Controls** - Added opt-in consent for anonymous usage analytics with Privacy Settings menu
- **Reduced Cookie Persistence** - Session cookies now expire after 90 days instead of 1 year
- **Stronger IPC Validation** - Enhanced input validation for inter-process communication
- **Metrics Privacy** - Startup metrics now disabled by default (opt-in via STARTUP_METRICS=1)

---

## v1.3.0 (2025-12-27)

### New Features

- **Native Title Bar** - Standard macOS title bar for better window management
- **External Links** - Shared/forwarded links now open in your default browser instead of inside the app

### Bug Fixes

- Fixed issue where forwarded links (via l.messenger.com) were opening inside Electron

---

## v1.2.0 (2025-12-26)

### New Features

- **Auto-Update Check** - Automatically checks for new versions on startup
- **Keyboard Shortcuts** - Cmd+N for new message, Cmd+1-9 for conversations
- **Toggle Sidebar** - Cmd+Shift+S to show/hide sidebar
- **Welcome Screen** - First-launch guide showing features and shortcuts
- **Power Saving** - Background throttling to reduce CPU/battery usage

---

## v1.1.0 (2025-12-25)

### New Features

- Persistent login sessions
- Native macOS notifications

---

## v1.0.0 (2025-12-24)

- Initial release
- Basic Messenger wrapper for macOS
