# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-11-12

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
