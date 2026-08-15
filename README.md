# Momentum Hill v3 — Two-Zone Build

A browser-based momentum-platformer physics prototype with a classic 16-bit movement foundation and a Mania-inspired ability layer.

## Zones

### Physics Test Zone
An instrumented movement lab designed to expose physics rather than hide them. It contains labeled stations for:
- acceleration / braking runway
- slope and rolling behavior
- loop adhesion
- springs
- one-way platforms
- vertically moving platforms
- ring-loss / hazard behavior
- checkpoints
- dash finish

The physics telemetry overlay is always visible here and reports state, position, ground speed, X/Y velocity, surface angle, zone, and standing-platform index.

### Momentum Hill Zone
The playable showcase stage. It keeps the original tropical mock-up and expands it with:
- momentum-driven terrain
- loop traversal
- upper spring/platform reward routes
- rings, hazards, moving and one-way platforms
- Badnik-style placeholder enemies
- checkpoints
- an eight-hit wrecking-ball boss
- goal capsule

Momentum Hill is an original level inspired by 16-bit momentum-platformer design grammar. It is not a copy of Green Hill Zone's map.

## Controls
- Left / Right: Arrow keys or A / D
- Roll / crouch: Down or S
- Jump: Z, X, C, or Space
- Spin dash: hold Down while stopped, tap Jump to charge, release Down
- Drop dash: jump, press Jump again in the air, keep holding until landing
- P / Escape: pause
- R: restart current zone
- F2 / Physics button: toggle telemetry (always shown in Test Zone)
- Zones button: return to zone selector

## Physics
The engine still runs at a fixed 60 Hz using the project's Sonic 1-derived 8.8-style constants. Roll-jumps intentionally keep air steering. Spin dash and drop dash remain part of the Mania-inspired hybrid layer.

## Presentation
v3 changes the canonical gameplay viewport from widescreen to **320×224, 4:3**, with integer-friendly pixel rendering. The two zones deliberately use different visual languages: an instrumented grid laboratory and a tropical showcase.

## Files
Open `index.html` in a modern browser. No server or build step is required.

## Legal / asset note
No Sega sprites, music, maps, or ROM data are included. Graphics, geometry, sound synthesis, names, and layouts in this package are original placeholders.


## Added reference layout
- `reference-green-hill-layout.png`: the user-provided Green Hill style layout study that Momentum Hill v4 now follows much more closely in its main-zone terrain progression.
