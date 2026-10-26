# FRACTAL420 Cyberpunk Neon Theme

Dark void · electric purple · toxic neon green — matched to the FRACTAL420 logo.

## Drop-in install

Replace (or merge) the files in your existing `src/web/` folder:

| File | Action |
|------|--------|
| `index.html` | Replace (branding + meta + fonts; all IDs/classes preserved) |
| `app.css` | Replace entirely (full visual rewrite) |
| `logo.jpg` | Add (logo asset used in header + favicon) |
| `manifest.webmanifest` | Replace (PWA colors + name) |
| `app.js`, `survey.js`, `sw.js` | Unchanged — leave as-is |

No JS changes required. All existing class names, IDs, and data attributes that `app.js` depends on are intact.

## Palette

- Background: `#050508` / `#0a0a10`
- Purple: `#7B2CBF` → `#9D4EDD` → `#C77DFF`
- Neon green: `#39FF14` / `#00FF9F`
- Borders & glows use purple energy; interactive accents use neon green

## Features

- Mobile-first sticky header, safe-area insets, 44px+ touch targets
- Side drawer modules menu (unchanged behavior)
- Glass / frosted panels with purple borders
- Grain overlay (respects `prefers-reduced-motion`)
- Status pills & toggles in purple–green hierarchy
- Orbitron + JetBrains Mono typography
- High-contrast focus rings (neon green)

## Optional

If you want micro-interactions later, you can add a lightweight `theme.js` for pulse effects; the CSS already includes a soft glow pulse on online phase status.
