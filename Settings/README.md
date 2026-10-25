# Settings

All bot configuration lives here.

| Path | Purpose |
|------|---------|
| `settings.json` | Global settings (server host, control API, reconnect, map defaults, Discord, …) |
| `announcements.json` | Default timed chat announcements |
| `Profiles/<LabelOrUsername>.json` | **One file per account profile** — credentials, features, and per-bot overrides |

On first run, values are migrated from a legacy `.env` / `accounts.json` if those files exist.

Edit via the dashboard **Settings** panel, the CLI, or by editing these JSON files directly (then restart or reload settings).
