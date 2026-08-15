# Physics source ledger

This project does not claim pixel-perfect engine emulation. It combines documented Sonic 1 movement constants with selected Sonic Mania ability behavior, while using original course geometry, artwork, synthesized sound, and naming.

## Primary implementation references

- Sonic the Hedgehog 1 disassembly by the Sonic Retro community:
  https://github.com/sonicretro/s1disasm
- Sonic object implementation (`_incObj/01 Sonic.asm`):
  https://github.com/sonicretro/s1disasm/blob/AS/_incObj/01%20Sonic.asm
- Sonic Retro Physics Guide — Running:
  https://info.sonicretro.org/SPG:Running
- Sonic Mania decompilation, `Player.c`:
  https://github.com/RSDKModding/Sonic-Mania-Decompilation/blob/master/SonicMania/Objects/Global/Player.c

## Sonic 1 values mirrored in `game.js`

| Rule | Engine value | Decimal subpixels/frame |
|---|---:|---:|
| Maximum running speed | `0x600` | 1536 |
| Ground acceleration / friction | `0x0C` | 12 |
| Reversal deceleration | `0x80` | 128 |
| Jump impulse | `0x680` | 1664 |
| Gravity | `0x38` | 56 |
| Released-jump upward cap | `-0x400` | -1024 |
| Air steering acceleration | `0x18` | 24 |
| Air-drag divisor | `0x20` | 32 |
| Rolling maximum speed | `0xC00` | 3072 |
| Rolling passive friction | `0x06` | 6 |
| Rolling reversal resistance | `0x20` | 32 |
| Walking slope factor | `0x20` | 32 |
| Rolling slope factor | `0x50` | 80 |
| Minimum rolling speed | `0x80` | 128 |
| Wall/ceiling attachment threshold | `0x280` | 640 |

The internal values are represented in 8.8-style fixed-point units and stepped at 60 updates per second.

## Deliberate roll-jump change

Sonic 1 normally locks horizontal air control after a jump initiated from a roll. This build deliberately removes that lock, retaining normal airborne acceleration while curled. It is therefore a hybrid control model rather than a pure Sonic 1 recreation.

## Mania-inspired spin dash

The Mania state adds `0x20000` charge per fresh Jump press, caps charge at `0x90000`, decays charge by `charge >> 5` on frames without a fresh press, and releases at a base `0x80000` plus quantized half-charge. In this build those values are converted from 16.16 to 8.8-style units:

- Charge step: `0x200`
- Charge cap: `0x900`
- Release base: `0x800`
- Maximum normal release in this implementation: `0xC80`

## Mania-inspired drop dash

The Mania implementation requires an additional airborne Jump press, charges while Jump remains held, and switches to the drop-dash state when the jump-ability counter reaches 22. On landing, normal Sonic receives a base `0x80000` release with existing ground momentum partially blended in and capped at `0xC0000`. Converted values used here:

- Ready state: `22`
- Base release: `0x800`
- Release cap: `0xC00`

## Deliberate non-identical parts

The original games use tile collision masks, multiple floor and wall sensors, specific object collision routines, camera logic, animation timing, and numerous edge-case states. This browser build uses analytic terrain curves, circular player collision, one-way rectangle platforms, and a custom loop solver. Behavior near seams, corners, moving-object edges, and loops therefore cannot honestly be called one-to-one.

## v3 design note
Version 3 adds a 320x224 4:3 presentation, a separate instrumented Physics Test Zone, and additional momentum-dependent route ideas in Momentum Hill. These are project-level design decisions rather than claims of reproducing original level data. Momentum Hill deliberately does not include Green Hill Zone's copyrighted map, art, music, or ROM assets.
