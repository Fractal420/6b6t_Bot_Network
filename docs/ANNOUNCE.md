# Announce (timed chat messages)

The Announce module sends **fixed chat messages on a timer** while the bot is in-game. It is a lightweight side job: safe to leave on alongside mapping or other passive work.

Inspired by simple announcement bots used on anarchy servers (e.g. timed adverts or rules).

---

## What it does

- Runs one interval timer per configured message.
- When the timer fires, if the bot has an entity (in-world), it sends `bot.chat(message)`.
- Stops cleanly when the feature is toggled off or the bot leaves.
- Default list comes from `Settings/announcements.json`; a profile can override with its own list.

It does **not** read chat, reply to players, or coordinate with Hunt/Map beyond sharing the same process.

---

## Quick start

1. Edit `Settings/announcements.json` (or the Announce tab in the dashboard):

```json
[
  { "message": "Example advert — join our Discord", "intervalMs": 300000 },
  { "message": "Another line every 10 minutes", "intervalMs": 600000 }
]
```

2. Enable **Announcements** for the profile (Fleet / profile features, or the Announce module).
3. Keep the bot online; messages fire only while `bot.entity` exists.

Disable the feature flag or clear the list to stop.

---

## Config

| Source | Role |
|--------|------|
| `Settings/announcements.json` | Global default list: `{ message, intervalMs }[]`. |
| Profile `announcementMessages` | Optional per-account override. |
| Feature flag `announcements` | On/off for that bot. |

Rules:

- Empty `message` or `intervalMs ≤ 0` → entry is skipped.
- Intervals are independent (each message has its own timer).
- No built-in anti-spam beyond the interval you set — choose values that fit the server’s rules.

---

## Design notes

- Implemented as a side job in `src/fleet/sideJobs.ts` (`startAnnouncements`).
- Does not take movement/inventory leases; anti-AFK is a separate side job that **does** pause while Map/Hunt own controls.
- Failures on `chat` are logged and ignored so one bad tick does not kill the timers.

Use the dashboard **Announce** tab to edit the default list without hand-editing JSON when the control server is running.
