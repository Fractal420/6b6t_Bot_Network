# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2026-11-12

[Full diff since `fa250697`](https://github.com/Fractal420/6b6t_Bot_Network/compare/fa2506971cdf347f336ac30a1a67aaff9e29d40a...HEAD)

### Added
- **Base Hunting Suite** (by [@logvex-sg](https://github.com/logvex-sg))
  - Autonomous exploration (grid / spiral / adaptive routes)
  - Elytra flight + durability management
  - Mending support
  - Ender chest deposit/withdraw with reserves
  - Stash detection & prioritization
  - Crash-safe per-server persistence
  - CLI (`bh …`), Discord (`!bh …`), dashboard & API surfaces
- **Kit Bot** (by [@logvex-sg](https://github.com/logvex-sg))
  - Chat-triggered kits (`!kit` by default)
  - Uses normal toss (no packet forging)
  - Guards: cooldown, rate limit, proximity, blacklist, stock checks
  - Surfaces: CLI, Discord, dashboard, RPC
  - Per-server config

### Changed
- README and documentation updates

### Fixed
- Added `.openhands/` to `.gitignore`

