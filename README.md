# Momentum Hill — Classic / Mania Physics Hybrid

A self-contained HTML5 Canvas platformer with a fixed 60 Hz update loop, 8.8-style subpixel values, documented Sonic 1 ground physics, and a deliberately modernized Sonic Mania-inspired ability layer.

## Run

Open `index.html` in a modern browser. No build step or internet connection is required.

For local hosting:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Controls

- Left/right: Arrow keys or A/D
- Roll: Down or S while moving
- Jump: Z, X, C, or Space
- Spin dash: while nearly stationary, hold Down, tap Jump repeatedly, then release Down
- Drop dash: jump, release Jump, then press and hold Jump again until landing
- Pause: P or Escape
- Restart: R
- Physics overlay: F2
- Mobile: on-screen direction and Jump controls

## Implemented systems

- Fixed 60 Hz deterministic game update
- Ground speed separated from X/Y velocity
- `0x600` maximum running speed
- `0x0C` ground acceleration/friction
- `0x80` reversal deceleration
- `0x680` jump impulse
- `0x38` gravity
- Variable jump-height cutoff at `-0x400`
- Double ground acceleration for air steering
- Modernized roll-jump air steering instead of Sonic 1's roll-jump lock
- Air drag based on velocity divided by 32
- Rolling max speed, passive friction, reversal resistance, and stronger slope factor
- Mania-inspired spin-dash charging, decay, quantized release speed, sound, and dust
- Mania-inspired drop-dash second-press arming, 22-state charge threshold, momentum blending, and `0xC00` cap
- Momentum-sensitive loop traversal and low-speed detachment
- Rings, ring loss, damage invulnerability, lives, pits, spikes, springs
- Starpost-style checkpoints
- Five original enemy archetypes inspired by classic Badnik behaviors
- Eight-hit wrecking-ball boss encounter
- Correct one-way top collision for bridge, stone, and moving platforms
- Moving-platform vertical carry
- Keyboard and touch controls

## Accuracy boundary

The core running, rolling, jumping, gravity, and slope values are based on the Sonic 1 disassembly and Sonic Retro physics documentation. The spin dash and drop dash are adapted from the Sonic Mania decompilation, with its 16.16 values converted to this project's 8.8-style system. The collision geometry and loop implementation remain browser-native approximations rather than emulation of the original engines' tile masks and sensor code.

The course, art, sound, names, and layout are original placeholders. No Sega sprites, music, level maps, or ROM data are included.
