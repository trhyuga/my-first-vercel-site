# /games/

Sandbox folder for game prototypes. **Not linked from the top index.html on purpose** — these are work-in-progress experiments, not user-facing.

## Layout

Each game lives in its own subfolder so pure-static deploys (Vercel) serve them at `/games/<name>/`:

- `tactics-grid/` — first prototype: turn-based grid tactics with projectile + melee combat.

## Conventions

- Single-file HTML where reasonable (CSS + JS inline). Easier to iterate / no build step.
- Mobile-first (portrait). Aspect-aware grid sizing, large tap targets.
- No backend. State lives in memory; reload = new game (until we add IndexedDB save slots).
- Common-helpers code can move to `/games/_shared/` once the second game appears and we
  can see what's actually shared.
