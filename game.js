(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;

  const startCard = document.getElementById('startCard');
  const menuBtn = document.getElementById('menuBtn');
  const zoneLabel = document.getElementById('zoneLabel');
  const pauseBtn = document.getElementById('pauseBtn');
  const restartBtn = document.getElementById('restartBtn');
  const debugBtn = document.getElementById('debugBtn');
  const statusCard = document.getElementById('statusCard');

  const W = canvas.width;
  const H = canvas.height;
  const FPS = 60;
  const STEP_MS = 1000 / FPS;
  const FP = 256;
  const TAU = Math.PI * 2;

  // Sonic 1 movement constants, represented in the same 8.8-style units.
  const PHYS = Object.freeze({
    MAX_SPEED: 0x600,
    ACCEL: 0x0c,
    DECEL: 0x80,
    JUMP: 0x680,
    GRAVITY: 0x38,
    JUMP_RELEASE: -0x400,
    AIR_ACCEL: 0x18,
    AIR_DRAG_DIVISOR: 32,
    ROLL_MAX: 0xc00,
    ROLL_FRICTION: 0x06,
    ROLL_DECEL: 0x20,
    WALK_SLOPE: 0x20,
    ROLL_SLOPE: 0x50,
    ROLL_MIN: 0x80,
    WALL_STICK_MIN: 0x280,
    TERMINAL: 0xfc0,
    // Sonic Mania-inspired ability values converted from 16.16 to this
    // project's 8.8-style units.
    SPINDASH_CHARGE_STEP: 0x200,
    SPINDASH_CHARGE_MAX: 0x900,
    SPINDASH_BASE_SPEED: 0x800,
    SPINDASH_RELEASE_MAX: 0xc80,
    DROP_DASH_SPEED: 0x800,
    DROP_DASH_CAP: 0xc00,
    DROP_DASH_READY_STATE: 22
  });

  const keys = { left: false, right: false, down: false, jump: false };
  const pressed = { left: false, right: false, down: false, jump: false };

  let running = false;
  let paused = false;
  let showDebug = false;
  let lastTime = 0;
  let accumulator = 0;
  let audio = null;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const approach = (v, target, amount) => {
    if (v < target) return Math.min(target, v + amount);
    if (v > target) return Math.max(target, v - amount);
    return target;
  };
  const sign = v => (v < 0 ? -1 : v > 0 ? 1 : 0);
  const px = fp => fp / FP;
  const toFp = n => Math.round(n * FP);
  const overlapCircle = (ax, ay, ar, bx, by, br) => {
    const dx = ax - bx;
    const dy = ay - by;
    const rr = ar + br;
    return dx * dx + dy * dy <= rr * rr;
  };
  const rectCircle = (cx, cy, r, x, y, w, h) => {
    const nx = clamp(cx, x, x + w);
    const ny = clamp(cy, y, y + h);
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy <= r * r;
  };

  class Synth {
    constructor() {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.12;
      this.master.connect(this.ctx.destination);
    }
    tone(freq, duration = 0.08, type = 'square', slide = 1, volume = 0.5) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), now + duration);
      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(now);
      osc.stop(now + duration);
    }
    ring() { this.tone(1000, 0.05, 'square', 1.45, 0.45); }
    jump() { this.tone(390, 0.11, 'square', 1.9, 0.4); }
    roll() { this.tone(120, 0.12, 'sawtooth', 0.55, 0.35); }
    hit() { this.tone(120, 0.25, 'sawtooth', 0.35, 0.65); }
    enemy() { this.tone(250, 0.08, 'square', 0.45, 0.5); }
    checkpoint() {
      this.tone(660, 0.08, 'square', 1.25, 0.4);
      setTimeout(() => this.tone(880, 0.12, 'square', 1.1, 0.4), 70);
    }
    spring() { this.tone(210, 0.15, 'square', 3.2, 0.55); }
    bossHit() { this.tone(95, 0.18, 'sawtooth', 0.5, 0.7); }
    spinCharge(pitch = 1) { this.tone(145 * pitch, 0.09, 'sawtooth', 1.5, 0.4); }
    dashRelease() { this.tone(115, 0.15, 'sawtooth', 2.4, 0.55); }
    dropDashCharge() { this.tone(285, 0.12, 'square', 1.35, 0.38); }
    win() {
      [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 0.18, 'square', 1.02, 0.45), i * 120));
    }
  }

  function makeRingTools(target) {
    return {
      line(x, y, count, dx, dy = 0) {
        for (let i = 0; i < count; i += 1) target.push({ x: x + dx * i, y: y + dy * i, collected: false, phase: i * 0.35 });
      },
      arc(cx, cy, r, a0, a1, count) {
        for (let i = 0; i < count; i += 1) {
          const t = count === 1 ? 0 : i / (count - 1);
          const a = a0 + (a1 - a0) * t;
          target.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, collected: false, phase: i * 0.3 });
        }
      }
    };
  }

  function buildMomentumZone() {
    const ringTemplate = [];
    const r = makeRingTools(ringTemplate);
    r.line(160, 116, 10, 19);
    r.arc(700, 102, 62, Math.PI * 1.12, Math.PI * 1.88, 9);
    r.line(980, 102, 8, 20, -1);
    r.arc(1600, 82, 76, Math.PI * 0.15, Math.PI * 1.85, 18);
    r.line(1900, 96, 10, 18, 1);
    r.line(2287, 94, 6, 21, -2);
    r.arc(2810, 80, 62, Math.PI * 1.08, Math.PI * 1.92, 10);
    r.line(3200, 105, 12, 20);
    r.arc(3720, 82, 58, Math.PI * 1.05, Math.PI * 1.95, 9);
    r.line(4315, 86, 7, 23, -3);
    r.line(4700, 82, 9, 20, 2);
    r.arc(5350, 77, 60, Math.PI * 1.08, Math.PI * 1.92, 10);
    r.line(5660, 105, 12, 18);
    // Upper-route rewards: intentionally visible only after committing to a jump/spring line.
    r.line(2685, 53, 8, 19);
    r.line(4560, 55, 9, 19);

    return {
      id: 'momentum',
      name: 'MOMENTUM HILL ZONE',
      subtitle: 'Tropical momentum showcase · boss route',
      length: 6800,
      cameraMax: 6480,
      deathY: 258,
      spawn: { x: 84, y: 130 },
      anchors: [
        [0, 140], [260, 140], [520, 127], [760, 151], [1040, 132], [1270, 140],
        [1450, 140], [1780, 140], [1980, 126], [2200, 140], [2260, 140],
        [2410, 136], [2570, 136], [2810, 108], [3080, 140], [3370, 148],
        [3700, 118], [4050, 139], [4290, 140], [4480, 132], [4740, 121],
        [5030, 147], [5350, 117], [5660, 143], [5950, 140], [6800, 140]
      ],
      pits: [[2262, 2408], [4292, 4478]],
      platforms: [
        { x: 2280, y: 120, w: 52, h: 7, type: 'bridge' },
        { x: 2340, y: 114, w: 52, h: 7, type: 'bridge' },
        { x: 2668, y: 83, w: 58, h: 7, type: 'stone' },
        { x: 2740, y: 71, w: 58, h: 7, type: 'stone' },
        { x: 4312, y: 116, w: 54, h: 7, type: 'stone' },
        { x: 4386, y: 100, w: 54, h: 7, type: 'stone' },
        { x: 4630, y: 86, w: 62, h: 7, type: 'moving', baseY: 86, phase: 0 },
        { x: 4870, y: 102, w: 56, h: 7, type: 'stone' },
        { x: 4550, y: 74, w: 52, h: 7, type: 'bridge' },
        { x: 4612, y: 61, w: 52, h: 7, type: 'bridge' }
      ],
      springs: [
        { x: 2655, y: 125, w: 15, h: 11, power: 0xa00 },
        { x: 4525, y: 121, w: 15, h: 11, power: 0x980 },
        { x: 5585, y: 129, w: 15, h: 11, power: 0x8c0 }
      ],
      spikes: [
        { x: 1120, y: 128, w: 30, h: 12 },
        { x: 3560, y: 128, w: 36, h: 12 },
        { x: 5740, y: 128, w: 34, h: 12 }
      ],
      checkpoints: [
        { x: 3160, y: 113, active: false },
        { x: 5230, y: 106, active: false }
      ],
      rings: ringTemplate,
      enemies: [
        { kind: 'wheel', x: 620, y: 110, minX: 560, maxX: 735, dir: -1, alive: true },
        { kind: 'crab', x: 930, y: 118, minX: 875, maxX: 1030, dir: 1, alive: true, timer: 70 },
        { kind: 'bomber', x: 1220, y: 75, minX: 1160, maxX: 1340, dir: 1, alive: true, timer: 100 },
        { kind: 'ambusher', x: 1890, y: 102, dir: -1, alive: true, hidden: true, timer: 0 },
        { kind: 'wheel', x: 2090, y: 108, minX: 2010, maxX: 2200, dir: -1, alive: true },
        { kind: 'fish', x: 2335, y: 195, baseY: 195, alive: true, timer: 20 },
        { kind: 'crab', x: 2920, y: 112, minX: 2860, maxX: 3030, dir: 1, alive: true, timer: 50 },
        { kind: 'bomber', x: 3430, y: 78, minX: 3340, maxX: 3530, dir: -1, alive: true, timer: 80 },
        { kind: 'ambusher', x: 3970, y: 105, dir: -1, alive: true, hidden: true, timer: 0 },
        { kind: 'fish', x: 4370, y: 195, baseY: 195, alive: true, timer: 55 },
        { kind: 'wheel', x: 4780, y: 98, minX: 4680, maxX: 4890, dir: 1, alive: true },
        { kind: 'crab', x: 5520, y: 109, minX: 5450, maxX: 5640, dir: -1, alive: true, timer: 40 },
        { kind: 'bomber', x: 5840, y: 74, minX: 5770, maxX: 5980, dir: 1, alive: true, timer: 60 }
      ],
      loop: { cx: 1600, cy: 82, radius: 58, entryX: 1592, exitX: 1607 },
      labels: [
        { x: 78, y: 104, text: 'GO!' },
        { x: 1480, y: 30, text: 'MOMENTUM LOOP' },
        { x: 2580, y: 36, text: 'SPRING ROUTE ↑' },
        { x: 4235, y: 39, text: 'BRANCHING PATH' },
        { x: 6060, y: 105, text: 'BOSS' }
      ],
      boss: { enabled: true, triggerX: 6100, x: 6370, y: 55, minX: 6250, maxX: 6575, arenaMin: 6075, arenaMax: 6750, cameraMin: 6070, cameraMax: 6460 },
      goal: { x: 6715, y: 110, open: false }
    };
  }

  function buildTestZone() {
    const ringTemplate = [];
    const r = makeRingTools(ringTemplate);
    r.line(130, 112, 12, 18);
    r.line(610, 90, 9, 18, -2);
    r.arc(1360, 86, 74, Math.PI * 0.15, Math.PI * 1.85, 18);
    r.line(1710, 86, 8, 18);
    r.line(2050, 67, 8, 18);
    r.line(2540, 103, 14, 18);
    r.line(3030, 112, 10, 18);

    return {
      id: 'test',
      name: 'PHYSICS TEST ZONE',
      subtitle: 'Instrumented movement laboratory',
      length: 3600,
      cameraMax: 3280,
      deathY: 264,
      spawn: { x: 72, y: 130 },
      anchors: [
        [0, 140], [480, 140],                    // acceleration runway
        [640, 118], [800, 158], [960, 118],     // slope / valley sequence
        [1160, 140], [1240, 140], [1500, 140],  // loop runway
        [1660, 140], [1840, 124], [1980, 140],  // spring approach
        [2190, 140], [2250, 140],               // platform pit approach
        [2490, 140], [2700, 140], [2860, 122], [3040, 140],
        [3260, 140], [3600, 140]
      ],
      pits: [[2252, 2488]],
      platforms: [
        { x: 2275, y: 122, w: 54, h: 7, type: 'bridge' },
        { x: 2340, y: 105, w: 54, h: 7, type: 'bridge' },
        { x: 2410, y: 88, w: 54, h: 7, type: 'stone' },
        { x: 2525, y: 112, w: 58, h: 7, type: 'stone' },
        { x: 2630, y: 86, w: 64, h: 7, type: 'moving', baseY: 86, phase: 0 }
      ],
      springs: [
        { x: 1900, y: 128, w: 15, h: 11, power: 0x980 },
        { x: 1988, y: 128, w: 15, h: 11, power: 0xb00 }
      ],
      spikes: [
        { x: 2865, y: 128, w: 34, h: 12 },
        { x: 3155, y: 128, w: 34, h: 12 }
      ],
      checkpoints: [
        { x: 2130, y: 113, active: false },
        { x: 3000, y: 113, active: false }
      ],
      rings: ringTemplate,
      enemies: [
        { kind: 'wheel', x: 2780, y: 110, minX: 2730, maxX: 2825, dir: -1, alive: true },
        { kind: 'crab', x: 3090, y: 118, minX: 3040, maxX: 3140, dir: 1, alive: true, timer: 70 }
      ],
      loop: { cx: 1360, cy: 82, radius: 58, entryX: 1352, exitX: 1367 },
      labels: [
        { x: 95, y: 91, text: '01  ACCELERATION RUNWAY' },
        { x: 605, y: 68, text: '02  SLOPE / ROLL TEST' },
        { x: 1230, y: 34, text: '03  LOOP ADHESION' },
        { x: 1815, y: 74, text: '04  SPRINGS' },
        { x: 2225, y: 49, text: '05  ONE-WAY PLATFORMS' },
        { x: 2535, y: 52, text: '06  MOVING PLATFORM' },
        { x: 2820, y: 77, text: '07  RING-LOSS / HAZARD' },
        { x: 3220, y: 91, text: '08  DASH FINISH' }
      ],
      boss: { enabled: false, triggerX: Infinity, x: 0, y: 0, minX: 0, maxX: 0, arenaMin: 0, arenaMax: 0, cameraMin: 0, cameraMax: 0 },
      goal: { x: 3505, y: 111, open: true }
    };
  }

  const ZONE_BUILDERS = { momentum: buildMomentumZone, test: buildTestZone };
  let activeZoneId = 'momentum';
  let zone = buildMomentumZone();
  let anchors = zone.anchors;
  let pits = zone.pits;
  let platforms = zone.platforms;
  let springs = zone.springs;
  let spikes = zone.spikes;
  let checkpointsTemplate = zone.checkpoints;
  let ringTemplate = zone.rings;
  let enemiesTemplate = zone.enemies;
  let loop = zone.loop;

  function loadZoneData(id) {
    activeZoneId = ZONE_BUILDERS[id] ? id : 'momentum';
    zone = ZONE_BUILDERS[activeZoneId]();
    anchors = zone.anchors;
    pits = zone.pits;
    platforms = zone.platforms.map(p => ({ ...p }));
    springs = zone.springs.map(v => ({ ...v }));
    spikes = zone.spikes.map(v => ({ ...v }));
    checkpointsTemplate = zone.checkpoints.map(v => ({ ...v }));
    ringTemplate = zone.rings.map(v => ({ ...v }));
    enemiesTemplate = zone.enemies.map(v => ({ ...v }));
    loop = { ...zone.loop };
    if (zoneLabel) zoneLabel.textContent = `${zone.name} · ${zone.subtitle}`;
  }

  function isPit(x) {
    return pits.some(([a, b]) => x > a && x < b);
  }

  function groundAt(x) {
    if (x < 0 || x > zone.length || isPit(x)) return null;
    let i = 0;
    while (i < anchors.length - 2 && anchors[i + 1][0] < x) i += 1;
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[Math.min(i + 1, anchors.length - 1)];
    const t = clamp((x - x0) / Math.max(1, x1 - x0), 0, 1);
    const smooth = t * t * (3 - 2 * t);
    return y0 + (y1 - y0) * smooth;
  }

  function groundAngle(x) {
    const y0 = groundAt(x - 1);
    const y1 = groundAt(x + 1);
    if (y0 == null || y1 == null) return 0;
    return Math.atan2(y1 - y0, 2);
  }

  function freshGame() {
    return {
      frame: 0,
      time: 0,
      camera: { x: 0, y: 0 },
      rings: ringTemplate.map(r => ({ ...r })),
      looseRings: [],
      enemies: enemiesTemplate.map(e => ({ ...e })),
      projectiles: [],
      checkpoints: checkpointsTemplate.map(c => ({ ...c })),
      particles: [],
      boss: {
        active: false,
        defeated: false,
        x: zone.boss.x,
        y: zone.boss.y,
        vx: 1.15,
        hp: 8,
        invuln: 0,
        swing: 0,
        arenaLocked: false,
        escape: 0
      },
      goal: { x: zone.goal.x, y: zone.goal.y, open: zone.goal.open },
      won: false,
      player: {
        x: toFp(zone.spawn.x),
        y: toFp(zone.spawn.y),
        vx: 0,
        vy: 0,
        gsp: 0,
        angle: 0,
        radius: 10,
        onGround: true,
        rolling: false,
        jumped: false,
        airControlLocked: false,
        spindash: false,
        spinCharge: 0,
        dropDashState: 0,
        facing: 1,
        rings: 0,
        lives: 3,
        invuln: 0,
        hurt: 0,
        dead: false,
        deathTimer: 0,
        respawnX: zone.spawn.x,
        respawnY: zone.spawn.y,
        loopMode: false,
        loopProgress: 0,
        loopDirection: 1,
        loopCooldown: 0,
        standingPlatform: null,
        anim: 0
      }
    };
  }

  let game = freshGame();

  function ensureAudio() {
    if (!audio) audio = new Synth();
  }

  function setKey(name, value) {
    if (value && !keys[name]) pressed[name] = true;
    keys[name] = value;
  }

  const keyMap = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowDown: 'down', KeyS: 'down',
    Space: 'jump', KeyZ: 'jump', KeyX: 'jump', KeyC: 'jump'
  };

  window.addEventListener('keydown', event => {
    if (keyMap[event.code]) {
      event.preventDefault();
      setKey(keyMap[event.code], true);
      ensureAudio();
    }
    if (event.code === 'KeyR') resetGame();
    if (event.code === 'KeyP' || event.code === 'Escape') togglePause();
    if (event.code === 'F2') {
      event.preventDefault();
      showDebug = !showDebug;
    }
  });
  window.addEventListener('keyup', event => {
    if (keyMap[event.code]) {
      event.preventDefault();
      setKey(keyMap[event.code], false);
    }
  });
  window.addEventListener('blur', () => {
    Object.keys(keys).forEach(k => { keys[k] = false; });
  });

  document.querySelectorAll('.touch').forEach(button => {
    const name = button.dataset.key;
    const down = event => {
      event.preventDefault();
      button.classList.add('active');
      setKey(name, true);
      ensureAudio();
      canvas.focus();
    };
    const up = event => {
      event.preventDefault();
      button.classList.remove('active');
      setKey(name, false);
    };
    button.addEventListener('pointerdown', down);
    button.addEventListener('pointerup', up);
    button.addEventListener('pointercancel', up);
    button.addEventListener('pointerleave', event => {
      if (event.buttons === 0) up(event);
    });
  });

  function startZone(id) {
    ensureAudio();
    loadZoneData(id);
    game = freshGame();
    showDebug = id === 'test';
    startCard.hidden = true;
    statusCard.hidden = true;
    running = true;
    paused = false;
    pauseBtn.textContent = 'Pause';
    lastTime = performance.now();
    accumulator = 0;
    canvas.focus();
  }

  document.querySelectorAll('.zone-choice').forEach(button => {
    button.addEventListener('click', () => startZone(button.dataset.zone));
  });

  function showZoneMenu() {
    running = false;
    paused = false;
    statusCard.hidden = true;
    pauseBtn.textContent = 'Pause';
    startCard.hidden = false;
    Object.keys(keys).forEach(k => { keys[k] = false; pressed[k] = false; });
  }

  menuBtn.addEventListener('click', showZoneMenu);
  pauseBtn.addEventListener('click', togglePause);
  restartBtn.addEventListener('click', resetGame);
  debugBtn.addEventListener('click', () => { showDebug = !showDebug; canvas.focus(); });

  function togglePause() {
    if (!running) return;
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    statusCard.hidden = !paused;
    statusCard.textContent = paused ? 'PAUSED' : '';
    if (!paused) lastTime = performance.now();
  }

  function resetGame() {
    loadZoneData(activeZoneId);
    game = freshGame();
    statusCard.hidden = true;
    paused = false;
    pauseBtn.textContent = 'Pause';
    running = true;
    startCard.hidden = true;
    lastTime = performance.now();
    canvas.focus();
  }

  function playerX() { return px(game.player.x); }
  function playerY() { return px(game.player.y); }

  function platformTopAt(centerX, previousBottom, currentBottom, radius = 10) {
    // One-way top collision. Compare the player's previous feet against the
    // platform's previous top so moving platforms cannot rise through Sonic.
    let best = null;
    for (let i = 0; i < platforms.length; i += 1) {
      const platform = platforms[i];
      const overlapsX = centerX + radius > platform.x && centerX - radius < platform.x + platform.w;
      if (!overlapsX) continue;

      const previousTop = Number.isFinite(platform.prevY) ? platform.prevY : platform.y;
      const wasAboveTop = previousBottom <= previousTop + 3;
      const crossedTop = currentBottom >= platform.y;
      if (wasAboveTop && crossedTop) {
        if (!best || platform.y < best.y) best = { y: platform.y, index: i };
      }
    }
    return best;
  }

  function surfaceAt(x, feetY = -Infinity) {
    const gy = groundAt(x);
    let best = gy == null ? null : { y: gy, angle: groundAngle(x), platform: null };
    for (let i = 0; i < platforms.length; i += 1) {
      const p = platforms[i];
      if (x >= p.x && x <= p.x + p.w && feetY <= p.y + 16) {
        if (!best || p.y < best.y) best = { y: p.y, angle: 0, platform: i };
      }
    }
    return best;
  }

  function spawnParticle(x, y, type, count = 6) {
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * TAU;
      const speed = 0.4 + Math.random() * 2.2;
      game.particles.push({
        x, y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 0.7,
        life: 20 + Math.floor(Math.random() * 25),
        maxLife: 45,
        type
      });
    }
  }

  function enterLoop(direction) {
    const p = game.player;
    p.loopMode = true;
    p.loopProgress = 0;
    p.loopDirection = direction;
    p.onGround = true;
    p.rolling = true;
    p.airControlLocked = true;
    p.x = toFp(loop.cx);
    p.y = toFp(loop.cy + loop.radius - p.radius);
    if (Math.abs(p.gsp) < toFp(3.6)) p.gsp = direction * toFp(3.6);
    audio?.roll();
  }

  function updateLoop() {
    const p = game.player;
    const speed = p.gsp / FP;
    const direction = p.loopDirection;
    p.loopProgress += Math.abs(speed) / (loop.radius - p.radius);
    const theta = direction > 0
      ? Math.PI / 2 - p.loopProgress
      : Math.PI / 2 + p.loopProgress;
    const tangentAngle = direction > 0 ? theta - Math.PI / 2 : theta + Math.PI / 2;
    p.angle = tangentAngle;

    // Slope gravity in the same spirit as ground-speed slope resistance.
    const slopeForce = Math.round(Math.sin(tangentAngle) * PHYS.ROLL_SLOPE);
    p.gsp += slopeForce;
    if (keys.left && direction < 0) p.gsp = approach(p.gsp, -PHYS.ROLL_MAX, PHYS.ROLL_DECEL);
    if (keys.right && direction > 0) p.gsp = approach(p.gsp, PHYS.ROLL_MAX, PHYS.ROLL_DECEL);

    const inner = loop.radius - p.radius;
    p.x = toFp(loop.cx + Math.cos(theta) * inner);
    p.y = toFp(loop.cy + Math.sin(theta) * inner);
    p.vx = Math.round(Math.cos(tangentAngle) * p.gsp);
    p.vy = Math.round(Math.sin(tangentAngle) * p.gsp);

    const upperHalf = Math.sin(theta) < 0;
    if (upperHalf && Math.abs(p.gsp) < PHYS.WALL_STICK_MIN) {
      p.loopMode = false;
      p.onGround = false;
      p.loopCooldown = 45;
      p.vx = Math.round(Math.cos(tangentAngle) * p.gsp);
      p.vy = Math.round(Math.sin(tangentAngle) * p.gsp);
      return;
    }

    if (pressed.jump) {
      const normalX = -Math.sin(tangentAngle);
      const normalY = Math.cos(tangentAngle);
      p.loopMode = false;
      p.onGround = false;
      p.loopCooldown = 45;
      p.vx = Math.round(Math.cos(tangentAngle) * p.gsp - normalX * PHYS.JUMP);
      p.vy = Math.round(Math.sin(tangentAngle) * p.gsp - normalY * PHYS.JUMP);
      p.jumped = true;
      p.rolling = true;
      p.airControlLocked = false;
      p.dropDashState = 1;
      audio?.jump();
      return;
    }

    if (p.loopProgress >= TAU) {
      p.loopMode = false;
      p.loopCooldown = 60;
      p.onGround = true;
      p.angle = 0;
      p.x = toFp(direction > 0 ? loop.exitX : loop.entryX - 15);
      p.y = toFp(groundAt(px(p.x)) - p.radius);
      p.vy = 0;
      p.airControlLocked = false;
    }
  }

  function startSpinDash() {
    const p = game.player;
    p.spindash = true;
    p.rolling = true;
    p.gsp = 0;
    p.vx = 0;
    p.vy = 0;
    p.spinCharge = PHYS.SPINDASH_CHARGE_STEP;
    p.dropDashState = 0;
    p.anim += 1.4;
    spawnParticle(playerX() - p.facing * 5, playerY() + p.radius - 1, 'dust', 4);
    audio?.spinCharge(1);
  }

  function updateSpinDash() {
    const p = game.player;
    p.gsp = 0;
    p.vx = 0;
    p.vy = 0;
    p.rolling = true;
    p.anim += 0.7 + p.spinCharge / 1500;

    if (keys.left) p.facing = -1;
    if (keys.right) p.facing = 1;

    if (pressed.jump) {
      p.spinCharge = Math.min(PHYS.SPINDASH_CHARGE_MAX, p.spinCharge + PHYS.SPINDASH_CHARGE_STEP);
      const chargeIndex = clamp(Math.round(p.spinCharge / PHYS.SPINDASH_CHARGE_STEP), 1, 12);
      const pitch = Math.pow(2, chargeIndex / 12);
      spawnParticle(playerX() - p.facing * 7, playerY() + p.radius - 1, 'dust', 3);
      audio?.spinCharge(pitch);
    } else {
      p.spinCharge -= p.spinCharge >> 5;
    }

    if (!keys.down) {
      // Mania quantizes half the charge to 0x80 steps, then adds 0x800.
      const halfCharge = p.spinCharge >> 1;
      const quantized = Math.floor(halfCharge / 0x80) * 0x80;
      const releaseSpeed = Math.min(PHYS.SPINDASH_RELEASE_MAX, PHYS.SPINDASH_BASE_SPEED + quantized);
      p.gsp = p.facing * releaseSpeed;
      p.vx = Math.round(Math.cos(p.angle) * p.gsp);
      p.spindash = false;
      p.spinCharge = 0;
      p.rolling = true;
      p.dropDashState = 0;
      spawnParticle(playerX() - p.facing * 8, playerY() + p.radius - 1, 'dust', 9);
      audio?.dashRelease();
    }
  }

  function armDropDash() {
    const p = game.player;
    if (p.dropDashState !== 1) return;
    p.dropDashState = 2;
    p.rolling = true;
    p.anim += 1;
    audio?.dropDashCharge();
  }

  function updateDropDashCharge() {
    const p = game.player;
    if (p.dropDashState === 1 && pressed.jump) armDropDash();
    if (p.dropDashState < 2) return;

    if (!keys.jump) {
      p.dropDashState = 0;
      return;
    }

    if (p.dropDashState < PHYS.DROP_DASH_READY_STATE) {
      p.dropDashState += 1;
      if (p.dropDashState === PHYS.DROP_DASH_READY_STATE) {
        spawnParticle(playerX(), playerY(), 'spark', 7);
        audio?.dropDashCharge();
      }
    }
    p.rolling = true;
    p.anim += p.dropDashState >= PHYS.DROP_DASH_READY_STATE ? 0.7 : 0.35;
  }

  function releaseDropDash() {
    const p = game.player;
    const dir = p.facing < 0 ? -1 : 1;
    const base = PHYS.DROP_DASH_SPEED;
    const cap = PHYS.DROP_DASH_CAP;
    let speed;

    if (dir > 0) {
      if (p.vx >= 0) speed = base + (p.gsp >> 2);
      else if (Math.abs(p.angle) > 0.01) speed = base + (p.gsp >> 1);
      else speed = base;
      p.gsp = Math.min(cap, speed);
    } else {
      if (p.vx <= 0) speed = (p.gsp >> 2) - base;
      else if (Math.abs(p.angle) > 0.01) speed = (p.gsp >> 1) - base;
      else speed = -base;
      p.gsp = Math.max(-cap, speed);
    }

    p.vx = Math.round(Math.cos(p.angle) * p.gsp);
    p.vy = 0;
    p.rolling = true;
    p.dropDashState = 0;
    p.spindash = false;
    spawnParticle(playerX() - dir * 8, playerY() + p.radius - 1, 'dust', 10);
    audio?.dashRelease();
  }

  function jumpFromGround() {
    const p = game.player;
    const a = p.angle;
    const sinA = Math.sin(a);
    const cosA = Math.cos(a);
    p.vx = Math.round(Math.cos(a) * p.gsp + sinA * PHYS.JUMP);
    p.vy = Math.round(Math.sin(a) * p.gsp - cosA * PHYS.JUMP);
    p.onGround = false;
    p.jumped = true;
    // Deliberate hybrid rule: roll-jumps keep Mania-style air steering.
    p.airControlLocked = false;
    p.rolling = true;
    p.spindash = false;
    p.spinCharge = 0;
    p.dropDashState = 1;
    p.standingPlatform = null;
    audio?.jump();
  }

  function updateGroundPlayer() {
    const p = game.player;
    const x = playerX();
    const surface = surfaceAt(x, playerY() + p.radius);
    if (!surface) {
      p.onGround = false;
      p.vx = Math.round(Math.cos(p.angle) * p.gsp);
      p.vy = Math.round(Math.sin(p.angle) * p.gsp);
      return;
    }
    p.angle = surface.angle;
    p.standingPlatform = surface.platform;

    if (p.spindash) {
      updateSpinDash();
      return;
    }

    if (pressed.jump) {
      if (keys.down && Math.abs(p.gsp) < PHYS.ROLL_MIN) startSpinDash();
      else jumpFromGround();
      return;
    }

    const input = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    if (!p.rolling) {
      const slopeForce = Math.round(Math.sin(p.angle) * PHYS.WALK_SLOPE);
      if (Math.abs(p.angle) > 0.01) p.gsp += slopeForce;

      if (input !== 0) {
        p.facing = input;
        if (p.gsp === 0 || sign(p.gsp) === input) {
          p.gsp = approach(p.gsp, input * PHYS.MAX_SPEED, PHYS.ACCEL);
        } else {
          p.gsp += input * PHYS.DECEL;
          if (sign(p.gsp) === input) p.gsp = input * PHYS.ROLL_MIN;
        }
      } else {
        p.gsp = approach(p.gsp, 0, PHYS.ACCEL);
      }

      if (keys.down && Math.abs(p.gsp) >= PHYS.ROLL_MIN && input === 0) {
        p.rolling = true;
        audio?.roll();
      }
    } else {
      const slopeForce = Math.round(Math.sin(p.angle) * PHYS.ROLL_SLOPE);
      p.gsp += slopeForce;
      p.gsp = approach(p.gsp, 0, PHYS.ROLL_FRICTION);
      if (input !== 0 && sign(p.gsp) !== input) p.gsp += input * PHYS.ROLL_DECEL;
      p.gsp = clamp(p.gsp, -PHYS.ROLL_MAX, PHYS.ROLL_MAX);
      if (p.gsp === 0 || (Math.abs(p.gsp) < PHYS.ROLL_MIN && !keys.down && Math.abs(p.angle) < 0.25)) {
        p.rolling = false;
        p.airControlLocked = false;
      }
    }

    const dx = Math.cos(p.angle) * (p.gsp / FP);
    p.x += toFp(dx);
    const nx = playerX();

    if (p.loopCooldown <= 0 && Math.abs(nx - loop.entryX) < 13 && Math.abs(p.gsp) >= toFp(2.3) && p.gsp > 0) {
      enterLoop(1);
      return;
    }

    const nextSurface = surfaceAt(nx, playerY() + p.radius + 8);
    if (!nextSurface) {
      p.onGround = false;
      p.vx = Math.round(Math.cos(p.angle) * p.gsp);
      p.vy = Math.round(Math.sin(p.angle) * p.gsp);
      return;
    }

    const targetY = nextSurface.y - p.radius;
    const currentY = playerY();
    if (targetY - currentY > 14) {
      p.onGround = false;
      p.vx = Math.round(Math.cos(p.angle) * p.gsp);
      p.vy = Math.round(Math.sin(p.angle) * p.gsp);
      return;
    }
    p.y = toFp(targetY);
    p.angle = nextSurface.angle;
    p.standingPlatform = nextSurface.platform;
    p.vx = Math.round(Math.cos(p.angle) * p.gsp);
    p.vy = Math.round(Math.sin(p.angle) * p.gsp);

    // Classic-style detachment from steep surfaces if momentum is too low.
    if (Math.abs(p.angle) > Math.PI * 0.47 && Math.abs(p.gsp) < PHYS.WALL_STICK_MIN) {
      p.onGround = false;
      p.gsp = 0;
      p.vx = 0;
      p.loopCooldown = 30;
    }
  }

  function updateAirPlayer() {
    const p = game.player;
    const oldX = playerX();
    const oldY = playerY();

    updateDropDashCharge();

    if (!p.airControlLocked) {
      if (keys.left) {
        p.vx = Math.max(-PHYS.MAX_SPEED, p.vx - PHYS.AIR_ACCEL);
        p.facing = -1;
      }
      if (keys.right) {
        p.vx = Math.min(PHYS.MAX_SPEED, p.vx + PHYS.AIR_ACCEL);
        p.facing = 1;
      }
    }

    if (p.jumped && !keys.jump && p.vy < PHYS.JUMP_RELEASE) p.vy = PHYS.JUMP_RELEASE;

    if (p.vy >= PHYS.JUMP_RELEASE && p.vx !== 0) {
      const drag = Math.trunc(p.vx / PHYS.AIR_DRAG_DIVISOR);
      p.vx -= drag;
    }

    p.vy = Math.min(PHYS.TERMINAL, p.vy + PHYS.GRAVITY);
    p.x += p.vx;
    p.y += p.vy;
    const x = playerX();
    const y = playerY();

    if (x < 8) {
      p.x = toFp(8);
      p.vx = Math.max(0, p.vx);
    }
    if (game.boss.arenaLocked && x < zone.boss.arenaMin) {
      p.x = toFp(zone.boss.arenaMin);
      p.vx = Math.max(0, p.vx);
    }
    if (game.boss.arenaLocked && x > zone.boss.arenaMax) {
      p.x = toFp(zone.boss.arenaMax);
      p.vx = Math.min(0, p.vx);
    }

    if (p.vy >= 0) {
      const feetOld = oldY + p.radius;
      const feetNew = y + p.radius;
      const platform = platformTopAt(x, feetOld, feetNew, p.radius);
      const gy = groundAt(x);
      let landingY = gy;
      let platformIndex = null;
      if (platform && (landingY == null || platform.y < landingY)) {
        landingY = platform.y;
        platformIndex = platform.index;
      }
      const previousLandingY = platformIndex == null
        ? landingY
        : (Number.isFinite(platforms[platformIndex].prevY) ? platforms[platformIndex].prevY : landingY);
      if (landingY != null && feetOld <= previousLandingY + 3 && feetNew >= landingY) {
        p.y = toFp(landingY - p.radius);
        p.onGround = true;
        p.angle = platformIndex == null ? groundAngle(x) : 0;
        p.standingPlatform = platformIndex;
        p.gsp = Math.round(p.vx * Math.cos(p.angle) + p.vy * Math.sin(p.angle));
        p.vy = 0;
        p.jumped = false;
        p.airControlLocked = false;
        if (p.dropDashState >= PHYS.DROP_DASH_READY_STATE && keys.jump) releaseDropDash();
        else {
          p.dropDashState = 0;
          if (Math.abs(p.gsp) < PHYS.ROLL_MIN && !keys.down) p.rolling = false;
        }
      }
    }

    if (playerY() > zone.deathY) killPlayer('fall');
  }

  function updatePlayer() {
    const p = game.player;
    if (p.dead) {
      p.deathTimer += 1;
      p.vy += PHYS.GRAVITY;
      p.y += p.vy;
      if (p.deathTimer > 90) respawnPlayer();
      return;
    }
    if (p.invuln > 0) p.invuln -= 1;
    if (p.hurt > 0) p.hurt -= 1;
    if (p.loopCooldown > 0) p.loopCooldown -= 1;
    p.anim += Math.max(0.08, Math.abs(p.gsp) / 800);

    if (p.loopMode) updateLoop();
    else if (p.onGround) updateGroundPlayer();
    else updateAirPlayer();

    const x = playerX();
    if (zone.boss.enabled && !game.boss.active && x > zone.boss.triggerX) activateBoss();
    if (x > zone.length - 20) p.x = toFp(zone.length - 20);
  }

  function respawnPlayer() {
    const p = game.player;
    if (p.lives <= 0) {
      game = freshGame();
      statusCard.hidden = false;
      statusCard.textContent = 'GAME OVER — press Restart';
      paused = true;
      return;
    }
    p.x = toFp(p.respawnX);
    p.y = toFp(p.respawnY);
    p.vx = 0;
    p.vy = 0;
    p.gsp = 0;
    p.angle = 0;
    p.onGround = true;
    p.rolling = false;
    p.jumped = false;
    p.airControlLocked = false;
    p.spindash = false;
    p.spinCharge = 0;
    p.dropDashState = 0;
    p.dead = false;
    p.deathTimer = 0;
    p.invuln = 120;
    p.rings = 0;
    p.loopMode = false;
    p.loopCooldown = 60;
    game.camera.x = clamp(p.respawnX - 90, 0, zone.cameraMax);
  }

  function killPlayer(reason = 'hit') {
    const p = game.player;
    if (p.dead) return;
    p.dead = true;
    p.lives -= 1;
    p.deathTimer = 0;
    p.onGround = false;
    p.loopMode = false;
    p.rolling = false;
    p.spindash = false;
    p.spinCharge = 0;
    p.dropDashState = 0;
    p.vx = 0;
    p.vy = -toFp(6.2);
    audio?.hit();
    spawnParticle(playerX(), playerY(), reason === 'fall' ? 'dust' : 'spark', 12);
  }

  function hurtPlayer(sourceX) {
    const p = game.player;
    if (p.invuln > 0 || p.dead || game.won) return;
    if (p.rings <= 0) {
      killPlayer('hit');
      return;
    }
    const count = Math.min(16, p.rings);
    p.rings = 0;
    for (let i = 0; i < count; i += 1) {
      const a = (i / count) * TAU + (i % 2) * 0.15;
      const speed = 1.8 + (i % 4) * 0.45;
      game.looseRings.push({
        x: playerX(), y: playerY() - 4,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 3.2,
        life: 240,
        pickupDelay: 45,
        phase: i * 0.3
      });
    }
    p.invuln = 120;
    p.hurt = 40;
    p.onGround = false;
    p.loopMode = false;
    p.rolling = false;
    p.airControlLocked = false;
    p.spindash = false;
    p.spinCharge = 0;
    p.dropDashState = 0;
    p.vx = sourceX < playerX() ? toFp(2) : -toFp(2);
    p.vy = -toFp(4);
    audio?.hit();
  }

  function attackActive() {
    const p = game.player;
    return p.rolling || !p.onGround;
  }

  function bounceFromEnemy() {
    const p = game.player;
    p.onGround = false;
    p.rolling = true;
    p.vy = keys.jump ? -toFp(4.8) : -toFp(3.8);
    p.jumped = false;
    p.dropDashState = 0;
  }

  function updateRings() {
    const p = game.player;
    const x = playerX();
    const y = playerY();
    for (const ring of game.rings) {
      if (ring.collected) continue;
      ring.phase += 0.17;
      if (overlapCircle(x, y, p.radius, ring.x, ring.y, 6)) {
        ring.collected = true;
        p.rings += 1;
        audio?.ring();
      }
    }
    for (let i = game.looseRings.length - 1; i >= 0; i -= 1) {
      const r = game.looseRings[i];
      r.life -= 1;
      r.pickupDelay -= 1;
      r.phase += 0.2;
      r.vy += 0.16;
      r.x += r.vx;
      r.y += r.vy;
      const gy = groundAt(r.x);
      if (gy != null && r.y + 4 > gy && r.vy > 0) {
        r.y = gy - 4;
        r.vy *= -0.62;
        r.vx *= 0.92;
      }
      if (r.pickupDelay <= 0 && overlapCircle(x, y, p.radius, r.x, r.y, 5)) {
        p.rings += 1;
        audio?.ring();
        game.looseRings.splice(i, 1);
        continue;
      }
      if (r.life <= 0) game.looseRings.splice(i, 1);
    }
  }

  function updatePlatforms() {
    for (let i = 0; i < platforms.length; i += 1) {
      const platform = platforms[i];
      platform.prevY = platform.y;
      if (platform.type === 'moving') {
        platform.phase += 0.025;
        platform.y = platform.baseY + Math.sin(platform.phase) * 22;
      }
      platform.deltaY = platform.y - platform.prevY;
    }

    const p = game.player;
    if (p.onGround && p.standingPlatform != null) {
      const platform = platforms[p.standingPlatform];
      if (platform && platform.deltaY) p.y += toFp(platform.deltaY);
    }
  }

  function updateSpringsAndSpikes() {
    const p = game.player;
    const x = playerX();
    const y = playerY();
    for (const spring of springs) {
      if (rectCircle(x, y, p.radius, spring.x, spring.y, spring.w, spring.h) && p.vy >= -toFp(1)) {
        p.onGround = false;
        p.rolling = true;
        p.jumped = false;
        p.airControlLocked = false;
        p.spindash = false;
        p.spinCharge = 0;
        p.dropDashState = 0;
        p.vy = -spring.power;
        p.y = toFp(spring.y - p.radius - 2);
        audio?.spring();
      }
    }
    for (const spike of spikes) {
      if (rectCircle(x, y, p.radius - 2, spike.x, spike.y, spike.w, spike.h)) {
        hurtPlayer(spike.x + spike.w / 2);
      }
    }
  }

  function fireProjectile(x, y, vx, vy, kind = 'pellet') {
    game.projectiles.push({ x, y, vx, vy, kind, life: 240 });
  }

  function updateEnemies() {
    const p = game.player;
    const px0 = playerX();
    const py0 = playerY();
    for (const enemy of game.enemies) {
      if (!enemy.alive) continue;
      const gy = groundAt(enemy.x);
      if (enemy.kind === 'wheel') {
        enemy.x += enemy.dir * 0.75;
        if (enemy.x < enemy.minX || enemy.x > enemy.maxX) enemy.dir *= -1;
        if (gy != null) enemy.y = gy - 9;
      } else if (enemy.kind === 'crab') {
        enemy.x += enemy.dir * 0.28;
        if (enemy.x < enemy.minX || enemy.x > enemy.maxX) enemy.dir *= -1;
        if (gy != null) enemy.y = gy - 10;
        enemy.timer -= 1;
        if (enemy.timer <= 0 && Math.abs(enemy.x - px0) < 180) {
          fireProjectile(enemy.x - 4, enemy.y - 7, -1.15, -1.8, 'arc');
          fireProjectile(enemy.x + 4, enemy.y - 7, 1.15, -1.8, 'arc');
          enemy.timer = 150;
        }
      } else if (enemy.kind === 'bomber') {
        enemy.x += enemy.dir * 0.45;
        if (enemy.x < enemy.minX || enemy.x > enemy.maxX) enemy.dir *= -1;
        enemy.y += Math.sin((game.frame + enemy.x) * 0.035) * 0.18;
        enemy.timer -= 1;
        if (enemy.timer <= 0 && Math.abs(enemy.x - px0) < 190) {
          const d = Math.hypot(px0 - enemy.x, py0 - enemy.y) || 1;
          fireProjectile(enemy.x, enemy.y + 5, (px0 - enemy.x) / d * 1.55, (py0 - enemy.y) / d * 1.55, 'shot');
          enemy.timer = 170;
        }
      } else if (enemy.kind === 'ambusher') {
        if (enemy.hidden && Math.abs(px0 - enemy.x) < 105) {
          enemy.hidden = false;
          enemy.timer = 45;
          enemy.dir = px0 < enemy.x ? -1 : 1;
        }
        if (!enemy.hidden) {
          enemy.timer -= 1;
          if (enemy.timer <= 0) enemy.x += enemy.dir * 1.8;
          const ey = groundAt(enemy.x);
          if (ey != null) enemy.y = ey - 11;
        }
      } else if (enemy.kind === 'fish') {
        enemy.timer -= 1;
        if (enemy.timer <= 0) {
          enemy.timer = 150;
          enemy.vy = -5.3;
        }
        if (enemy.vy != null) {
          enemy.vy += 0.14;
          enemy.y += enemy.vy;
          if (enemy.y > enemy.baseY) {
            enemy.y = enemy.baseY;
            enemy.vy = null;
          }
        }
      }

      const visibleRadius = enemy.kind === 'bomber' ? 10 : 9;
      if (enemy.hidden) continue;
      if (overlapCircle(px0, py0, p.radius, enemy.x, enemy.y, visibleRadius)) {
        if (attackActive() && py0 < enemy.y + 8) {
          enemy.alive = false;
          bounceFromEnemy();
          spawnParticle(enemy.x, enemy.y, 'spark', 9);
          audio?.enemy();
        } else {
          hurtPlayer(enemy.x);
        }
      }
    }

    for (let i = game.projectiles.length - 1; i >= 0; i -= 1) {
      const shot = game.projectiles[i];
      shot.life -= 1;
      if (shot.kind === 'arc') shot.vy += 0.055;
      shot.x += shot.vx;
      shot.y += shot.vy;
      if (overlapCircle(px0, py0, p.radius - 1, shot.x, shot.y, 3)) {
        hurtPlayer(shot.x);
        game.projectiles.splice(i, 1);
        continue;
      }
      const gy = groundAt(shot.x);
      if (shot.life <= 0 || shot.y > 190 || (gy != null && shot.y > gy)) game.projectiles.splice(i, 1);
    }
  }

  function updateCheckpoints() {
    const p = game.player;
    const x = playerX();
    const y = playerY();
    for (const checkpoint of game.checkpoints) {
      if (!checkpoint.active && overlapCircle(x, y, p.radius + 2, checkpoint.x, checkpoint.y, 14)) {
        game.checkpoints.forEach(c => { c.active = false; });
        checkpoint.active = true;
        p.respawnX = checkpoint.x + 18;
        const gy = groundAt(p.respawnX);
        p.respawnY = (gy ?? checkpoint.y + 27) - p.radius;
        audio?.checkpoint();
        spawnParticle(checkpoint.x, checkpoint.y - 13, 'star', 12);
      }
    }
  }

  function activateBoss() {
    if (!zone.boss.enabled) return;
    game.boss.active = true;
    game.boss.arenaLocked = true;
    game.boss.x = zone.boss.x;
    game.boss.y = zone.boss.y;
    game.boss.hp = 8;
    game.boss.vx = 1.15;
    spawnParticle(zone.boss.triggerX + 20, 116, 'dust', 16);
  }

  function updateBoss() {
    if (!zone.boss.enabled) return;
    const b = game.boss;
    if (!b.active) return;
    if (b.invuln > 0) b.invuln -= 1;
    if (b.defeated) {
      b.escape += 1;
      b.y -= 0.6;
      b.x += 1.1;
      if (b.escape === 1) audio?.win();
      if (b.escape > 120) {
        b.arenaLocked = false;
        game.goal.open = true;
      }
      return;
    }

    b.x += b.vx;
    if (b.x < zone.boss.minX || b.x > zone.boss.maxX) b.vx *= -1;
    b.y = zone.boss.y + Math.sin(game.frame * 0.035) * 7;
    b.swing += 0.045;

    const p = game.player;
    const px0 = playerX();
    const py0 = playerY();
    const ballX = b.x + Math.sin(b.swing) * 66;
    const ballY = b.y + 29 + Math.cos(b.swing) * 36;

    if (overlapCircle(px0, py0, p.radius, ballX, ballY, 12)) hurtPlayer(ballX);

    if (overlapCircle(px0, py0, p.radius, b.x, b.y, 18)) {
      if (attackActive() && b.invuln <= 0 && py0 > b.y - 20) {
        b.hp -= 1;
        b.invuln = 45;
        p.vy = -toFp(5.2);
        p.onGround = false;
        p.rolling = true;
        spawnParticle(b.x, b.y, 'spark', 14);
        audio?.bossHit();
        if (b.hp <= 0) {
          b.defeated = true;
          spawnParticle(b.x, b.y, 'fire', 28);
        }
      } else if (b.invuln <= 0) {
        hurtPlayer(b.x);
      }
    }
  }

  function updateGoal() {
    if (!game.goal.open || game.won) return;
    const p = game.player;
    if (overlapCircle(playerX(), playerY(), p.radius, game.goal.x, game.goal.y, 24)) {
      game.won = true;
      p.gsp = 0;
      p.vx = 0;
      statusCard.hidden = false;
      statusCard.textContent = `${zone.name} CLEAR — ${formatTime(game.time)} · ${p.rings} rings`;
      audio?.win();
    }
  }

  function updateParticles() {
    for (let i = game.particles.length - 1; i >= 0; i -= 1) {
      const p = game.particles[i];
      p.life -= 1;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.type === 'star' ? 0.01 : 0.08;
      p.vx *= 0.98;
      if (p.life <= 0) game.particles.splice(i, 1);
    }
  }

  function updateCamera() {
    const p = game.player;
    let targetX = playerX() - 112;
    if (p.vx > toFp(4)) targetX += 24;
    if (p.vx < -toFp(4)) targetX -= 18;
    if (game.boss.arenaLocked) targetX = clamp(targetX, zone.boss.cameraMin, zone.boss.cameraMax);
    game.camera.x += (targetX - game.camera.x) * 0.09;
    game.camera.x = clamp(game.camera.x, 0, zone.cameraMax);
    const targetY = clamp(playerY() - 108, -30, 42);
    game.camera.y += (targetY - game.camera.y) * 0.06;
  }

  function update() {
    if (game.won) {
      updateParticles();
      updateCamera();
      clearPressed();
      return;
    }
    game.frame += 1;
    game.time += 1 / FPS;
    updatePlatforms();
    updatePlayer();
    updateRings();
    updateSpringsAndSpikes();
    updateEnemies();
    updateCheckpoints();
    updateBoss();
    updateGoal();
    updateParticles();
    updateCamera();
    clearPressed();
  }

  function clearPressed() {
    Object.keys(pressed).forEach(k => { pressed[k] = false; });
  }

  function worldToScreenX(x, parallax = 1) { return Math.round(x - game.camera.x * parallax); }
  function worldToScreenY(y, parallax = 1) { return Math.round(y - game.camera.y * parallax); }

  function drawBackground() {
    if (activeZoneId === 'test') {
      ctx.fillStyle = '#102a2a';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#153637';
      for (let x = -((Math.floor(game.camera.x * 0.25)) % 16); x < W; x += 16) ctx.fillRect(x, 0, 1, H);
      for (let y = 0; y < H; y += 16) ctx.fillRect(0, y, W, 1);
      ctx.fillStyle = '#1e4b48';
      ctx.fillRect(0, 96, W, 2);
      ctx.font = 'bold 8px monospace';
      ctx.fillStyle = '#5ba79e';
      ctx.fillText('MOMENTUM ENGINE // INSTRUMENTED TEST ENVIRONMENT', 8, 45);
      ctx.fillStyle = '#255b55';
      for (let x = -64; x < W + 64; x += 64) {
        const sx = Math.floor(x - (game.camera.x * 0.08) % 64);
        ctx.fillRect(sx, 71, 32, 2);
      }
      return;
    }
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#187bd0');
    sky.addColorStop(0.62, '#54c7e7');
    sky.addColorStop(1, '#c2eff2');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(255,255,255,.75)';
    for (let i = -1; i < 7; i += 1) {
      const x = ((i * 84 - game.camera.x * 0.12) % 590) - 60;
      const y = 28 + (i % 3) * 13;
      ctx.fillRect(Math.floor(x), y, 26, 5);
      ctx.fillRect(Math.floor(x + 7), y - 5, 14, 6);
    }

    ctx.fillStyle = '#3a8f83';
    ctx.beginPath();
    ctx.moveTo(0, 126);
    for (let x = 0; x <= W + 20; x += 20) {
      const wx = x + game.camera.x * 0.28;
      const y = 110 + Math.sin(wx * 0.012) * 13 + Math.sin(wx * 0.026) * 5;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.fill();

    ctx.fillStyle = '#19736d';
    ctx.beginPath();
    ctx.moveTo(0, 142);
    for (let x = 0; x <= W + 16; x += 16) {
      const wx = x + game.camera.x * 0.48;
      const y = 127 + Math.sin(wx * 0.018) * 10;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.fill();

    ctx.fillStyle = '#258eca';
    ctx.fillRect(0, 153 - game.camera.y * 0.1, W, H - 153 + game.camera.y * 0.1);
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    for (let i = 0; i < 12; i += 1) {
      const y = 157 + i * 3 - game.camera.y * 0.1;
      const offset = (game.frame * (0.15 + i * 0.01) + i * 17) % 46;
      for (let x = -46 + offset; x < W; x += 46) ctx.fillRect(Math.floor(x), Math.floor(y), 19, 1);
    }
  }

  function drawGround() {
    const start = Math.max(0, Math.floor(game.camera.x) - 4);
    const end = Math.min(zone.length, Math.ceil(game.camera.x + W) + 4);
    let segmentStart = null;
    let points = [];

    const flush = () => {
      if (points.length < 2) { points = []; segmentStart = null; return; }
      ctx.beginPath();
      ctx.moveTo(worldToScreenX(points[0][0]), worldToScreenY(points[0][1]));
      for (const [x, y] of points) ctx.lineTo(worldToScreenX(x), worldToScreenY(y));
      ctx.lineTo(worldToScreenX(points[points.length - 1][0]), H + 40);
      ctx.lineTo(worldToScreenX(points[0][0]), H + 40);
      ctx.closePath();
      ctx.fillStyle = activeZoneId === 'test' ? '#2b4a43' : '#a75f2b';
      ctx.fill();
      ctx.save();
      ctx.clip();
      for (let x = Math.floor(segmentStart / 16) * 16; x < points[points.length - 1][0] + 16; x += 16) {
        for (let y = 120; y < H + 48; y += 16) {
          const odd = ((x / 16) + (y / 16)) & 1;
          ctx.fillStyle = activeZoneId === 'test' ? (odd ? '#203b36' : '#365b51') : (odd ? '#8f4426' : '#d0833b');
          ctx.fillRect(worldToScreenX(x), worldToScreenY(y), 16, 16);
        }
      }
      ctx.restore();
      ctx.strokeStyle = activeZoneId === 'test' ? '#58b89b' : '#1f8f3a';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(worldToScreenX(points[0][0]), worldToScreenY(points[0][1]));
      for (const [x, y] of points) ctx.lineTo(worldToScreenX(x), worldToScreenY(y));
      ctx.stroke();
      ctx.strokeStyle = activeZoneId === 'test' ? '#a7f1cd' : '#73d94a';
      ctx.lineWidth = 2;
      ctx.stroke();
      points = [];
      segmentStart = null;
    };

    for (let x = start; x <= end; x += 2) {
      const y = groundAt(x);
      if (y == null) {
        flush();
      } else {
        if (segmentStart == null) segmentStart = x;
        points.push([x, y]);
      }
    }
    flush();
  }

  function drawLoop() {
    if (!loop) return;
    const sx = worldToScreenX(loop.cx);
    const sy = worldToScreenY(loop.cy);
    if (sx < -100 || sx > W + 100) return;
    ctx.strokeStyle = '#8f4426';
    ctx.lineWidth = 20;
    ctx.beginPath();
    ctx.arc(sx, sy, loop.radius, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#d0833b';
    ctx.lineWidth = 12;
    ctx.setLineDash([9, 9]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#1f8f3a';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = '#73d94a';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawZoneLabels() {
    if (!zone.labels) return;
    ctx.save();
    ctx.font = 'bold 7px monospace';
    ctx.textBaseline = 'top';
    for (const label of zone.labels) {
      const x = worldToScreenX(label.x);
      const y = worldToScreenY(label.y);
      if (x < -160 || x > W + 40) continue;
      const width = ctx.measureText(label.text).width + 8;
      ctx.fillStyle = activeZoneId === 'test' ? 'rgba(4,20,24,.78)' : 'rgba(5,32,48,.72)';
      ctx.fillRect(x - 4, y - 3, width, 12);
      ctx.fillStyle = activeZoneId === 'test' ? '#9fffd3' : '#fff6a8';
      ctx.fillText(label.text, x, y);
    }
    ctx.restore();
  }

  function drawPlatforms() {
    for (const p of platforms) {
      const x = worldToScreenX(p.x);
      const y = worldToScreenY(p.y);
      if (x > W + 20 || x + p.w < -20) continue;
      if (p.type === 'bridge') {
        ctx.fillStyle = '#7b4524';
        ctx.fillRect(x, y, p.w, p.h);
        ctx.fillStyle = '#c9873c';
        for (let i = 2; i < p.w; i += 9) ctx.fillRect(x + i, y + 1, 6, p.h - 2);
      } else {
        ctx.fillStyle = '#655e7c';
        ctx.fillRect(x, y, p.w, p.h);
        ctx.fillStyle = '#9c94b5';
        ctx.fillRect(x, y, p.w, 2);
        for (let i = 4; i < p.w; i += 12) ctx.fillRect(x + i, y + 3, 5, 2);
      }
    }
  }

  function drawDecor() {
    for (let x = Math.floor((game.camera.x - 80) / 190) * 190; x < game.camera.x + W + 100; x += 190) {
      const gy = groundAt(x);
      if (gy == null) continue;
      const sx = worldToScreenX(x);
      const sy = worldToScreenY(gy);
      ctx.fillStyle = '#714425';
      ctx.fillRect(sx - 2, sy - 30, 5, 30);
      ctx.fillStyle = '#176e3a';
      ctx.fillRect(sx - 12, sy - 34, 25, 7);
      ctx.fillRect(sx - 8, sy - 41, 17, 8);
      ctx.fillStyle = '#43b54f';
      ctx.fillRect(sx - 6, sy - 43, 13, 4);
    }
    for (let x = Math.floor((game.camera.x - 40) / 120) * 120 + 60; x < game.camera.x + W + 60; x += 120) {
      const gy = groundAt(x);
      if (gy == null) continue;
      const sx = worldToScreenX(x);
      const sy = worldToScreenY(gy);
      ctx.fillStyle = '#f8e85a';
      ctx.fillRect(sx, sy - 7, 2, 7);
      ctx.fillStyle = '#ff65ae';
      ctx.fillRect(sx - 2, sy - 9, 6, 3);
    }
  }

  function drawRings() {
    ctx.lineWidth = 2;
    for (const ring of game.rings) {
      if (ring.collected) continue;
      const x = worldToScreenX(ring.x);
      const y = worldToScreenY(ring.y);
      if (x < -10 || x > W + 10) continue;
      const squish = Math.max(1, Math.abs(Math.cos(ring.phase)) * 5);
      ctx.strokeStyle = '#ffde3b';
      ctx.beginPath();
      ctx.ellipse(x, y, squish, 6, 0, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = '#fff6a6';
      ctx.beginPath();
      ctx.ellipse(x - 1, y - 1, Math.max(1, squish - 2), 3, 0, 0, TAU);
      ctx.stroke();
    }
    for (const ring of game.looseRings) {
      const x = worldToScreenX(ring.x);
      const y = worldToScreenY(ring.y);
      const squish = Math.max(1, Math.abs(Math.cos(ring.phase)) * 4);
      ctx.strokeStyle = ring.life < 60 && (ring.life >> 2) % 2 ? '#fff' : '#ffde3b';
      ctx.beginPath();
      ctx.ellipse(x, y, squish, 5, 0, 0, TAU);
      ctx.stroke();
    }
  }

  function drawSpringsAndSpikes() {
    for (const spring of springs) {
      const x = worldToScreenX(spring.x);
      const y = worldToScreenY(spring.y);
      ctx.fillStyle = '#d82a3a';
      ctx.fillRect(x, y, spring.w, spring.h);
      ctx.fillStyle = '#fff3cc';
      ctx.fillRect(x + 2, y + 2, spring.w - 4, 3);
      ctx.fillStyle = '#f4c836';
      ctx.fillRect(x + 4, y + 6, spring.w - 8, 3);
    }
    for (const spike of spikes) {
      const x = worldToScreenX(spike.x);
      const y = worldToScreenY(spike.y);
      ctx.fillStyle = '#d9edf0';
      const count = Math.floor(spike.w / 9);
      for (let i = 0; i < count; i += 1) {
        ctx.beginPath();
        ctx.moveTo(x + i * 9, y + spike.h);
        ctx.lineTo(x + i * 9 + 4.5, y);
        ctx.lineTo(x + i * 9 + 9, y + spike.h);
        ctx.fill();
      }
    }
  }

  function drawCheckpoint(c) {
    const x = worldToScreenX(c.x);
    const y = worldToScreenY(c.y);
    ctx.fillStyle = '#d2e4e8';
    ctx.fillRect(x - 1, y - 22, 3, 31);
    ctx.fillStyle = c.active ? '#ffdf42' : '#d63448';
    ctx.beginPath();
    ctx.arc(x, y - 24, 8, 0, TAU);
    ctx.fill();
    ctx.fillStyle = c.active ? '#fff8b0' : '#7d1122';
    ctx.fillRect(x - 4, y - 27, 8, 5);
  }

  function drawEnemy(enemy) {
    if (!enemy.alive || enemy.hidden) return;
    const x = worldToScreenX(enemy.x);
    const y = worldToScreenY(enemy.y);
    if (x < -30 || x > W + 30) return;
    ctx.save();
    ctx.translate(x, y);
    if (enemy.kind === 'wheel') {
      ctx.fillStyle = '#262b3d';
      ctx.beginPath(); ctx.arc(0, 3, 7, 0, TAU); ctx.fill();
      ctx.fillStyle = '#d63a3a';
      ctx.fillRect(-6, -5, 12, 8);
      ctx.fillStyle = '#ffe25b'; ctx.fillRect(2, -3, 3, 2);
      ctx.fillStyle = '#9aa8b8'; ctx.fillRect(-9, 1, 18, 3);
    } else if (enemy.kind === 'crab') {
      ctx.fillStyle = '#d94a4a';
      ctx.fillRect(-7, -5, 14, 9);
      ctx.fillStyle = '#f2d85e'; ctx.fillRect(-4, -3, 3, 3); ctx.fillRect(2, -3, 3, 3);
      ctx.strokeStyle = '#d94a4a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-6, 2); ctx.lineTo(-11, 7); ctx.moveTo(6, 2); ctx.lineTo(11, 7); ctx.stroke();
      ctx.fillStyle = '#e85c5c'; ctx.fillRect(-12, -7, 4, 4); ctx.fillRect(8, -7, 4, 4);
    } else if (enemy.kind === 'bomber') {
      ctx.fillStyle = '#385e9a';
      ctx.fillRect(-8, -4, 16, 8);
      ctx.fillStyle = '#f6cb48'; ctx.fillRect(2, -2, 4, 3);
      ctx.fillStyle = '#d8e7ea';
      const flap = Math.sin(game.frame * 0.2) * 3;
      ctx.fillRect(-14, -7 - flap, 7, 3); ctx.fillRect(7, -7 + flap, 7, 3);
    } else if (enemy.kind === 'ambusher') {
      ctx.fillStyle = '#2f8055';
      ctx.fillRect(-7, -8, 14, 13);
      ctx.fillStyle = '#d6f05c'; ctx.fillRect(enemy.dir > 0 ? 2 : -5, -5, 3, 3);
      ctx.fillStyle = '#c9d8d8';
      ctx.beginPath(); ctx.moveTo(-7, 5); ctx.lineTo(0, 11); ctx.lineTo(7, 5); ctx.fill();
    } else if (enemy.kind === 'fish') {
      ctx.rotate(Math.sin(game.frame * 0.15) * 0.1);
      ctx.fillStyle = '#e13a42';
      ctx.beginPath(); ctx.ellipse(0, 0, 9, 6, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-15, -6); ctx.lineTo(-15, 6); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillRect(3, -3, 3, 3);
      ctx.fillStyle = '#111'; ctx.fillRect(4, -2, 1, 1);
    }
    ctx.restore();
  }

  function drawProjectiles() {
    for (const p of game.projectiles) {
      const x = worldToScreenX(p.x);
      const y = worldToScreenY(p.y);
      ctx.fillStyle = p.kind === 'arc' ? '#f6ca4e' : '#f06352';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, TAU);
      ctx.fill();
    }
  }

  function drawBoss() {
    if (!zone.boss.enabled) return;
    const b = game.boss;
    if (!b.active) return;
    const x = worldToScreenX(b.x);
    const y = worldToScreenY(b.y);
    const ballX = worldToScreenX(b.x + Math.sin(b.swing) * 66);
    const ballY = worldToScreenY(b.y + 29 + Math.cos(b.swing) * 36);
    ctx.strokeStyle = '#363646';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, y + 16); ctx.lineTo(ballX, ballY); ctx.stroke();
    ctx.fillStyle = '#252836';
    ctx.beginPath(); ctx.arc(ballX, ballY, 12, 0, TAU); ctx.fill();
    ctx.fillStyle = '#6c7182';
    ctx.beginPath(); ctx.arc(ballX - 3, ballY - 4, 3, 0, TAU); ctx.fill();

    ctx.save();
    ctx.translate(x, y);
    if (b.invuln > 0 && (b.invuln >> 2) % 2) ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#c9343e';
    ctx.beginPath(); ctx.ellipse(0, 5, 25, 15, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f0d34d'; ctx.fillRect(-19, 0, 38, 5);
    ctx.fillStyle = '#b8e2eb';
    ctx.beginPath(); ctx.ellipse(0, -5, 15, 12, 0, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = '#f1c09d';
    ctx.beginPath(); ctx.arc(0, -5, 8, 0, TAU); ctx.fill();
    ctx.fillStyle = '#6b2c2c'; ctx.fillRect(-7, -9, 14, 3);
    ctx.fillStyle = '#fff'; ctx.fillRect(-5, -6, 4, 3); ctx.fillRect(2, -6, 4, 3);
    ctx.fillStyle = '#111'; ctx.fillRect(-3, -5, 1, 1); ctx.fillRect(3, -5, 1, 1);
    ctx.restore();

    if (!b.defeated) {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(97, 12, 126, 8);
      ctx.fillStyle = '#ef4e45'; ctx.fillRect(99, 14, Math.round(122 * (b.hp / 8)), 4);
    }
  }

  function drawGoal() {
    if (!game.goal.open) return;
    const x = worldToScreenX(game.goal.x);
    const y = worldToScreenY(game.goal.y);
    ctx.fillStyle = '#70788a';
    ctx.fillRect(x - 19, y + 7, 38, 18);
    ctx.fillStyle = '#aab5c6';
    ctx.fillRect(x - 16, y + 3, 32, 8);
    ctx.fillStyle = '#45be61';
    ctx.beginPath(); ctx.arc(x, y, 20, Math.PI, TAU); ctx.fill();
    ctx.fillStyle = '#f5f2d6';
    ctx.fillRect(x - 10, y - 11, 5, 8); ctx.fillRect(x + 5, y - 11, 5, 8);
  }

  function drawPlayer() {
    const p = game.player;
    const x = worldToScreenX(playerX());
    const y = worldToScreenY(playerY());
    if (p.dead && p.deathTimer > 75 && (p.deathTimer >> 2) % 2) return;
    if (p.invuln > 0 && (p.invuln >> 2) % 2) return;
    ctx.save();
    ctx.translate(x, y);
    if (p.loopMode || p.onGround) ctx.rotate(p.angle);
    if (p.facing < 0) ctx.scale(-1, 1);

    if (p.rolling || !p.onGround) {
      ctx.rotate(p.anim * 0.35);
      ctx.fillStyle = '#0b55c7';
      ctx.beginPath(); ctx.arc(0, 0, 10, 0, TAU); ctx.fill();
      ctx.fillStyle = '#063a92';
      for (let i = 0; i < 5; i += 1) {
        const a = i * TAU / 5 + 0.3;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 6, Math.sin(a) * 6);
        ctx.lineTo(Math.cos(a + 0.24) * 13, Math.sin(a + 0.24) * 13);
        ctx.lineTo(Math.cos(a - 0.24) * 8, Math.sin(a - 0.24) * 8);
        ctx.fill();
      }
      ctx.strokeStyle = '#68a8ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(-1, -1, 6, 0.3, 2.5); ctx.stroke();
    } else {
      const stride = Math.sin(p.anim) * clamp(Math.abs(p.gsp) / PHYS.MAX_SPEED, 0, 1) * 4;
      ctx.fillStyle = '#0b55c7';
      ctx.beginPath(); ctx.ellipse(-1, -2, 8, 11, 0.1, 0, TAU); ctx.fill();
      ctx.fillStyle = '#063a92';
      ctx.beginPath(); ctx.moveTo(-7, -8); ctx.lineTo(-14, -5); ctx.lineTo(-7, -2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-7, -3); ctx.lineTo(-15, 1); ctx.lineTo(-6, 3); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-5, 2); ctx.lineTo(-12, 7); ctx.lineTo(-3, 7); ctx.fill();
      ctx.fillStyle = '#efc49f';
      ctx.beginPath(); ctx.ellipse(4, 1, 5, 7, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillRect(2, -7, 4, 5); ctx.fillRect(6, -6, 3, 4);
      ctx.fillStyle = '#111'; ctx.fillRect(5, -5, 1, 2); ctx.fillRect(8, -4, 1, 2);
      ctx.strokeStyle = '#efc49f'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-1, 5); ctx.lineTo(-4 + stride, 12); ctx.moveTo(2, 5); ctx.lineTo(5 - stride, 12); ctx.stroke();
      ctx.fillStyle = '#e3363f';
      ctx.fillRect(-9 + stride, 11, 9, 4); ctx.fillRect(1 - stride, 11, 9, 4);
      ctx.fillStyle = '#fff'; ctx.fillRect(-6 + stride, 11, 5, 2); ctx.fillRect(4 - stride, 11, 5, 2);
    }

    if (p.spindash || p.dropDashState >= 2) {
      const ready = p.spindash
        ? p.spinCharge >= PHYS.SPINDASH_CHARGE_MAX * 0.75
        : p.dropDashState >= PHYS.DROP_DASH_READY_STATE;
      ctx.strokeStyle = ready ? '#fff59a' : '#7de8ff';
      ctx.lineWidth = 1;
      const pulse = 13 + Math.sin(game.frame * 0.45) * 2;
      ctx.beginPath();
      ctx.arc(0, 0, pulse, -0.8, 0.8);
      ctx.arc(0, 0, pulse, Math.PI - 0.8, Math.PI + 0.8);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawParticles() {
    for (const p of game.particles) {
      const x = worldToScreenX(p.x);
      const y = worldToScreenY(p.y);
      const alpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      if (p.type === 'spark') ctx.fillStyle = '#ffe14f';
      else if (p.type === 'fire') ctx.fillStyle = p.life % 2 ? '#ff6b2c' : '#ffe24c';
      else if (p.type === 'star') ctx.fillStyle = '#fff25a';
      else ctx.fillStyle = '#d7c09a';
      const size = p.type === 'fire' ? 4 : 2;
      ctx.fillRect(Math.round(x), Math.round(y), size, size);
    }
    ctx.globalAlpha = 1;
  }

  function drawHUD() {
    const p = game.player;
    ctx.save();
    ctx.font = 'bold 8px monospace';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,.7)';
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#fff';
    ctx.fillText('SCORE', 8, 7);
    const bossScore = zone.boss.enabled ? (8 - game.boss.hp) * 1000 : 0;
    ctx.fillText(String(game.enemies.filter(e => !e.alive).length * 100 + bossScore).padStart(6, '0'), 47, 7);
    ctx.fillText('TIME', 8, 17);
    ctx.fillText(formatTime(game.time), 47, 17);
    ctx.fillStyle = p.rings === 0 && (game.frame >> 4) % 2 ? '#ff4d4d' : '#ffe548';
    ctx.fillText('RINGS', 8, 27);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(p.rings).padStart(3, '0'), 47, 27);
    ctx.fillText(`LIVES ${p.lives}`, 255, 7);
    ctx.fillStyle = activeZoneId === 'test' ? '#9fffd3' : '#d9f4ff';
    ctx.fillText(activeZoneId === 'test' ? 'TEST' : 'MHZ', 286, 17);
    ctx.restore();
  }

  function drawDebug() {
    if (!showDebug && activeZoneId !== 'test') return;
    const p = game.player;
    ctx.fillStyle = 'rgba(0,0,0,.72)';
    const boxY = H - 66;
    ctx.fillRect(5, boxY, 176, 61);
    ctx.font = '7px monospace';
    ctx.fillStyle = '#b8ffdb';
    const state = p.loopMode
      ? 'LOOP'
      : p.spindash
        ? `SPINDASH ${p.spinCharge.toString(16)}`
        : p.onGround
          ? (p.rolling ? 'ROLL' : 'GROUND')
          : p.dropDashState >= PHYS.DROP_DASH_READY_STATE
            ? 'AIR · DROP READY'
            : p.dropDashState >= 2
              ? `AIR · DROP ${p.dropDashState}/22`
              : 'AIR';
    const lines = [
      `state ${state}`,
      `x ${playerX().toFixed(2)} y ${playerY().toFixed(2)}`,
      `gsp ${(p.gsp / FP).toFixed(4)} (${p.gsp})`,
      `vx ${(p.vx / FP).toFixed(4)} vy ${(p.vy / FP).toFixed(4)}`,
      `angle ${(p.angle * 180 / Math.PI).toFixed(2)}°`,
      `60 Hz · 8.8-style constants`
    ];
    lines.push(`zone ${activeZoneId.toUpperCase()} · platform ${p.standingPlatform ?? '-'}`);
    lines.forEach((line, i) => ctx.fillText(line, 9, boxY + 4 + i * 8));
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds * 100) % 100);
    return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  function render() {
    drawBackground();
    drawGround();
    drawLoop();
    drawDecor();
    drawZoneLabels();
    drawPlatforms();
    drawSpringsAndSpikes();
    drawRings();
    game.checkpoints.forEach(drawCheckpoint);
    game.enemies.forEach(drawEnemy);
    drawProjectiles();
    drawGoal();
    drawBoss();
    drawParticles();
    drawPlayer();
    drawHUD();
    drawDebug();

    if (!running) {
      ctx.fillStyle = 'rgba(2,8,20,.22)';
      ctx.fillRect(0, 0, W, H);
    }
  }

  function frame(now) {
    const elapsed = Math.min(100, now - lastTime || STEP_MS);
    lastTime = now;
    if (running && !paused) {
      accumulator += elapsed;
      while (accumulator >= STEP_MS) {
        update();
        accumulator -= STEP_MS;
      }
    }
    render();
    requestAnimationFrame(frame);
  }

  window.__momentumHillStartZone = startZone;
  window.__momentumHillShowMenu = showZoneMenu;

  // Read-only state snapshot for diagnostics and automated input tests.
  window.__momentumHillSnapshot = () => {
    const p = game.player;
    return {
      zone: activeZoneId,
      running,
      paused,
      frame: game.frame,
      x: playerX(),
      y: playerY(),
      vx: p.vx,
      vy: p.vy,
      gsp: p.gsp,
      onGround: p.onGround,
      rolling: p.rolling,
      spindash: p.spindash,
      spinCharge: p.spinCharge,
      dropDashState: p.dropDashState,
      airControlLocked: p.airControlLocked,
      standingPlatform: p.standingPlatform
    };
  };

  // Lightweight self-test exposed for automated verification.
  window.__momentumHillTest = () => {
    const errors = [];
    if (PHYS.MAX_SPEED !== 0x600) errors.push('max speed');
    if (PHYS.ACCEL !== 0x0c) errors.push('acceleration');
    if (PHYS.DECEL !== 0x80) errors.push('deceleration');
    if (PHYS.JUMP !== 0x680) errors.push('jump');
    if (PHYS.GRAVITY !== 0x38) errors.push('gravity');
    const start = freshGame();
    if (Math.abs(px(start.player.x) - 84) > 0.001) errors.push('fixed-point conversion');

    // A falling player whose feet cross the first bridge top must land.
    const platformLanding = platformTopAt(2300, 116, 124, start.player.radius);
    if (!platformLanding || platformLanding.index !== 0 || platformLanding.y !== 120) errors.push('platform top collision');
    // Passing upward from below must remain possible for one-way platforms.
    const platformPassThrough = platformTopAt(2300, 126, 116, start.player.radius);
    if (platformPassThrough) errors.push('platform underside pass-through');

    const savedGame = game;
    const savedKeys = { ...keys };
    const savedPressed = { ...pressed };
    const savedPlatforms = platforms.map(platform => ({
      y: platform.y,
      phase: platform.phase,
      prevY: platform.prevY,
      deltaY: platform.deltaY
    }));
    try {
      game = freshGame();
      game.player.rolling = true;
      jumpFromGround();
      if (game.player.airControlLocked) errors.push('hybrid roll-jump air control');
      if (game.player.dropDashState !== 1) errors.push('drop dash eligibility');

      game = freshGame();
      game.player.gsp = 0;
      game.player.facing = 1;
      startSpinDash();
      if (!game.player.spindash || game.player.spinCharge !== PHYS.SPINDASH_CHARGE_STEP) errors.push('spindash start');

      game.player.onGround = true;
      game.player.gsp = toFp(2);
      game.player.vx = toFp(2);
      game.player.facing = 1;
      game.player.dropDashState = PHYS.DROP_DASH_READY_STATE;
      releaseDropDash();
      if (game.player.gsp < PHYS.DROP_DASH_SPEED || game.player.gsp > PHYS.DROP_DASH_CAP) errors.push('drop dash release');

      // Full static-platform landing, not just the crossing helper.
      game = freshGame();
      game.player.x = toFp(2300);
      game.player.y = toFp(103);
      game.player.vx = 0;
      game.player.vy = toFp(1.5);
      game.player.onGround = false;
      game.player.rolling = true;
      for (let i = 0; i < 8 && !game.player.onGround; i += 1) updateAirPlayer();
      if (!game.player.onGround || game.player.standingPlatform !== 0 || Math.abs(playerY() - 110) > 0.01) {
        errors.push('static platform landing resolution');
      }

      // A rider must follow a vertically moving platform.
      game = freshGame();
      const moving = platforms.find(v => v.type === 'moving');
      game.player.x = toFp(moving.x + moving.w / 2);
      game.player.y = toFp(moving.y - game.player.radius);
      game.player.onGround = true;
      game.player.standingPlatform = platforms.indexOf(moving);
      const riderY = playerY();
      updatePlatforms();
      if (Math.abs((playerY() - riderY) - moving.deltaY) > 0.01) errors.push('moving platform carry');
    } finally {
      game = savedGame;
      Object.assign(keys, savedKeys);
      Object.assign(pressed, savedPressed);
      platforms.forEach((platform, i) => Object.assign(platform, savedPlatforms[i]));
    }

    return { ok: errors.length === 0, errors, constants: { ...PHYS } };
  };

  render();
  requestAnimationFrame(frame);
})();
