/* toio.js — WebBluetooth communication for toio Core Cube
   Supports multiple simultaneous cube connections via ToioManager.

   KEY DESIGN: Every command method WAITS for completion before resolving.
   ─────────────────────────────────────────────────────────────────────
   • move(l, r, durationMs) — awaits durationMs after BLE write
   • moveTo(x, y, angle, speed) — awaits the 0x83 motor-response
     notification (toio spec §Motor control with target specification)
     OR a calculated fallback timeout, whichever comes first
   • setLED(r,g,b, durationMs) — awaits durationMs if > 0
   • playSound(note, durationMs) — awaits durationMs if > 0
   • playSoundEffect(id) — awaits approximate effect duration

   This ensures that chained `await toio[0].xxx()` calls execute
   one at a time on the physical robot.
*/

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Sleep — mirrors simulator.js's sleep() so runtime code can share one def */
function _toioSleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))); }

// ─── BLE Service / Characteristic UUIDs (toio Core Cube spec) ────────────────
const TOIO_SERVICE   = '10b20100-5b3b-4571-9508-cf3efcd7bbae';
const CHAR_MOTOR     = '10b20102-5b3b-4571-9508-cf3efcd7bbae';
const CHAR_LIGHT     = '10b20103-5b3b-4571-9508-cf3efcd7bbae';
const CHAR_SOUND     = '10b20104-5b3b-4571-9508-cf3efcd7bbae';
const CHAR_SENSOR    = '10b20106-5b3b-4571-9508-cf3efcd7bbae';
const CHAR_BUTTON    = '10b20107-5b3b-4571-9508-cf3efcd7bbae';
const CHAR_BATTERY   = '10b20108-5b3b-4571-9508-cf3efcd7bbae';
const CHAR_ID_READER = '10b20101-5b3b-4571-9508-cf3efcd7bbae';
const CHAR_CONFIG    = '10b201ff-5b3b-4571-9508-cf3efcd7bbae';

/**
 * Approximate playback durations (ms) for each pre-programmed sound effect.
 * IDs: 0=Enter 1=Selected 2=Cancel 3=Cursor 4=Mat 5=Get 6=Score 7=Lose
 */
const EFFECT_DURATIONS = [350, 200, 200, 120, 220, 220, 300, 300, 300, 400, 400];

class ToioDevice {
  constructor(device, index) {
    this.device   = device;
    this.index    = index;
    this.name     = device.name || `Cube${index + 1}`;
    this._chars   = {};
    this._eventHandlers = {};
    this.position = { x: 250, y: 250, angle: 0 };
    this._posValid = false;   // true once we've received at least one position notification
    this.led      = { r: 0, g: 0, b: 0 };
    this.button   = false;

    // Motion sensor — high-precision posture angle (Euler, degrees)
    this.attitude   = { roll: 0, pitch: 0, yaw: 0 };
    this._attValid  = false;
    this.horizontal = true;   // motion-detection "is flat" flag

    // moveTo completion tracking — rotating 8-bit control ID per command
    this._moveCtrlId   = 0;
    this._moveResolvers = {};   // ctrlId (number) → resolveFn
    this._melodySeq    = 0;     // playMelody の中断トークン
  }

  /* ── Connect ─────────────────────────────────────────────────────────────── */
  async connect() {
    const server  = await this.device.gatt.connect();
    const service = await server.getPrimaryService(TOIO_SERVICE);
    const get     = uuid => service.getCharacteristic(uuid);

    this._chars.motor    = await get(CHAR_MOTOR);
    this._chars.light    = await get(CHAR_LIGHT);
    this._chars.sound    = await get(CHAR_SOUND);
    this._chars.sensor   = await get(CHAR_SENSOR);
    this._chars.button   = await get(CHAR_BUTTON);
    this._chars.battery  = await get(CHAR_BATTERY);
    this._chars.idReader = await get(CHAR_ID_READER);
    try { this._chars.config = await get(CHAR_CONFIG); } catch (e) { this._chars.config = null; }

    // ── Position / ID reader ─────────────────────────────────────────────────
    await this._chars.idReader.startNotifications();
    this._chars.idReader.addEventListener('characteristicvaluechanged',
      e => this._onIDReader(e.target.value));

    // ── Motor notifications ───────────────────────────────────────────────────
    // REQUIRED: receive 0x83 "moveTo complete" responses so moveTo() can resolve
    await this._chars.motor.startNotifications();
    this._chars.motor.addEventListener('characteristicvaluechanged',
      e => this._onMotorResponse(e.target.value));

    // ── Button ───────────────────────────────────────────────────────────────
    await this._chars.button.startNotifications();
    this._chars.button.addEventListener('characteristicvaluechanged', e => {
      this.button = e.target.value.getUint8(1) === 0x80;
      this._emit('button', this.button);
    });

    // ── Motion sensor (posture / high-precision tilt) ────────────────────────
    // Notifications carry both motion-detection (0x01) and posture-angle (0x03).
    await this._chars.sensor.startNotifications();
    this._chars.sensor.addEventListener('characteristicvaluechanged',
      e => this._onSensor(e.target.value));
    // Request Euler-angle posture notifications (toio spec §High-precision tilt).
    //   [0x1d, reserved, contentType=0x01 Euler, interval=0x01 (×10ms), condition=0x01 on-change]
    if (this._chars.config) {
      try {
        await this._chars.config.writeValue(new Uint8Array([0x1d, 0x00, 0x01, 0x01, 0x01]));
      } catch (e) { /* older firmware: posture angle unsupported — ignore */ }
    }

    // ── Disconnect ───────────────────────────────────────────────────────────
    // Resolve (not reject) all pending moveTo waiters so execution doesn't hang
    this.device.addEventListener('gattserverdisconnected', () => {
      for (const fn of Object.values(this._moveResolvers)) fn();
      this._moveResolvers = {};
      this._emit('disconnect');
    });
  }

  /* ── Internal notification handlers ─────────────────────────────────────── */

  _onIDReader(dv) {
    const type = dv.getUint8(0);
    if (type === 0x01) {  // Position ID (cube on mat with coordinate stickers)
      this.position.x = dv.getUint16(1, true);
      this.position.y = dv.getUint16(3, true);
      // toio BLE reports angle where 0° = facing East (right).
      // App convention is 0° = facing North (up), so add 90° offset.
      this.position.angle = (dv.getUint16(5, true) + 90) % 360;
      this._posValid = true;
      this._emit('position', { ...this.position });
    }
    // type 0x02 = Position ID missed (cube lifted off mat)
    if (type === 0x02) {
      this._posValid = false;
      this._emit('matMissed');
    }
  }

  get onMat() { return this._posValid; }

  /**
   * Handle motor-characteristic notification.
   *
   * 0x83 = response to single-target move (type 0x03)  ← we send this
   * 0x84 = response to multi-target  move (type 0x04)  ← handle for safety
   *
   * Response codes (byte 2):
   *   0x00 Normal end   — cube reached the target
   *   0x01 Timeout      — timed out without reaching target
   *   0x02 ID missed    — cube was lifted off the mat
   *   0x03–0x06 Errors  — parameter or state issues
   *
   * We resolve on ANY code so execution always continues.
   */
  _onMotorResponse(dv) {
    const type = dv.getUint8(0);
    if (type === 0x83 || type === 0x84) {
      const ctrlId = dv.getUint8(1);
      const fn = this._moveResolvers[ctrlId];
      if (fn) {
        delete this._moveResolvers[ctrlId];
        fn();
      }
    }
  }

  /**
   * Handle motion/sensor characteristic (0x10b20106) notifications.
   *   0x01 = motion detection (horizontal, collision, double-tap, posture, shake)
   *   0x03 = posture angle. Content type 0x01 = Euler angles (int16 LE, degrees):
   *          roll (X, −179…180), pitch (Y, −90…90), yaw (Z, −179…180)
   */
  _onSensor(dv) {
    const type = dv.getUint8(0);
    if (type === 0x01) {
      this.horizontal = dv.getUint8(1) === 0x01;
      this._emit('motion', {
        horizontal: this.horizontal,
        collision:  dv.getUint8(2) === 0x01,
        doubleTap:  dv.getUint8(3) === 0x01,
        posture:    dv.getUint8(4),
        shake:      dv.byteLength > 5 ? dv.getUint8(5) : 0,
      });
    } else if (type === 0x03 && dv.getUint8(1) === 0x01) {
      this.attitude = {
        roll:  dv.getInt16(2, true),
        pitch: dv.getInt16(4, true),
        yaw:   dv.getInt16(6, true),
      };
      this._attValid = true;
      this._emit('attitude', { ...this.attitude });
    }
  }

  disconnect() {
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }

  /* ── Motor ───────────────────────────────────────────────────────────────── */

  /**
   * Time-based motor control.
   *
   * Sends BLE command 0x02 (motor control with duration), then WAITS for
   * durationMs to elapse (+ 50 ms ramp-down buffer) before resolving.
   *
   * durationMs = 0 → run indefinitely; returns immediately (fire-and-forget).
   * Speed range: −115 … +115 (negative = backward direction).
   *
   * NOTE: BLE encodes duration in 10 ms units (max byte = 255 → 2550 ms).
   *       Longer durations are split into consecutive chunks automatically.
   */
  async move(leftSpeed, rightSpeed, durationMs = 0) {
    const MAX_CHUNK_MS = 2550;  // 255 × 10 ms = BLE duration ceiling
    const lDir = leftSpeed  >= 0 ? 0x01 : 0x02;
    const rDir = rightSpeed >= 0 ? 0x01 : 0x02;
    const lSpd = Math.min(115, Math.abs(Math.round(leftSpeed)));
    const rSpd = Math.min(115, Math.abs(Math.round(rightSpeed)));

    if (durationMs <= 0) {
      // Unlimited duration — fire and forget (motor runs until next command)
      const cmd = new Uint8Array([0x02,
        0x01, lDir, lSpd,
        0x02, rDir, rSpd,
        0]);
      await this._chars.motor.writeValue(cmd);
      return;
    }

    // Send in ≤2550 ms chunks so the BLE duration byte never overflows
    let remaining = durationMs;
    while (remaining > 0) {
      const chunk = Math.min(MAX_CHUNK_MS, remaining);
      const dur   = Math.round(chunk / 10);
      const cmd   = new Uint8Array([0x02,
        0x01, lDir, lSpd,
        0x02, rDir, rSpd,
        dur]);
      await this._chars.motor.writeValue(cmd);
      // ★ Wait for this chunk to finish (+ 50 ms ramp-down on last chunk)
      await _toioSleep(chunk + (remaining <= MAX_CHUNK_MS ? 50 : 0));
      remaining -= chunk;
    }
  }

  async stop() {
    // Explicitly stop both motors (speed 0, unlimited duration)
    const cmd = new Uint8Array([0x02,
      0x01, 0x01, 0,
      0x02, 0x01, 0,
      0]);
    await this._chars.motor.writeValue(cmd);
  }

  /**
   * Absolute-position move (toio BLE spec §Motor control with target).
   *
   * Sends command type 0x03, then WAITS for the 0x83 response notification
   * which the cube fires when it reaches the target (or times out/errors).
   * A JS-side fallback timer fires TIMEOUT_S + 0.5s after the command in
   * case the BLE notification is lost.
   *
   * speed: 10–115 (clamped; values below 10 may not move the cube)
   */
  async moveTo(x, y, angle = 0, speed = 80, mode = 'NORMAL') {
    const ctrlId = this._moveCtrlId;
    this._moveCtrlId = (this._moveCtrlId + 1) & 0xFF;

    const TIMEOUT_S = 10;  // cube's own hard timeout (sends 0x83 code=0x01 after this)
    const spd       = Math.min(115, Math.max(10, Math.round(speed)));

    // POS_ONLY (and angle=null): face the direction of travel rather than a fixed angle.
    // Compute heading from current position → target, in app coords (0=up/north).
    let targetAngle;
    if (mode === 'POS_ONLY' || angle === null || angle === undefined) {
      const cx  = this._posValid ? this.position.x : 250;
      const cy  = this._posValid ? this.position.y : 250;
      const dx  = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // atan2(dx, -dy): in toio coords Y increases downward,
      // so "up" is -dy direction, giving 0=up (north), 90=right, etc.
      targetAngle = dist > 5
        ? ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360
        : (this._posValid && this.position.angle != null ? this.position.angle : 0);
    } else {
      targetAngle = ((Math.round(angle) % 360) + 360) % 360;
    }

    // Convert app angle (0=North/up) to toio BLE angle (0=East/right) by subtracting 90°.
    const bleAngle = ((targetAngle - 90) + 360) % 360;

    // toio spec: Motor control with target specification (type 0x03)
    //   [type][ctrlId][timeout_s][moveType][maxSpeed][speedChange][reserved]
    //   [X_lo][X_hi][Y_lo][Y_hi][Angle_lo][Angle_hi]
    const cmd = new Uint8Array([
      0x03,           // information type: target move
      ctrlId,         // control identifier (matched in 0x83 response)
      TIMEOUT_S,      // cube-side timeout in seconds
      0x00,           // move type 0 = rotate and move simultaneously
      spd,            // max motor speed
      0x00,           // speed change type 0 = constant speed
      0x00,           // reserved
      x        & 0xFF, (x        >> 8) & 0xFF,
      y        & 0xFF, (y        >> 8) & 0xFF,
      bleAngle & 0xFF, (bleAngle >> 8) & 0xFF,
    ]);

    await this._chars.motor.writeValue(cmd);

    // ★ Compute JS-side fallback timeout
    //   ~1 toio coord unit ≈ 1 mm; speed value ≈ mm·s⁻¹ (empirically)
    //   We multiply by 1.4 for margin, then cap at hardware timeout + 500 ms
    const dx   = x - (this._posValid ? this.position.x : 250);
    const dy   = y - (this._posValid ? this.position.y : 250);
    const dist = Math.sqrt(dx * dx + dy * dy);
    const travelMs    = Math.max(400, (dist / spd) * 1400 + 300);
    const fallbackMs  = Math.min(travelMs, TIMEOUT_S * 1000 + 500);

    // ★ Wait for the motor response or fallback
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        delete this._moveResolvers[ctrlId];
        resolve();
      }, fallbackMs);

      this._moveResolvers[ctrlId] = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Rotate in place to an absolute heading (degrees, 0 = forward / north).
   * Uses moveTo with the current position so the cube spins without translating.
   */
  async rotateTo(targetAngle, speed = 80) {
    const x = this._posValid ? this.position.x : 250;
    const y = this._posValid ? this.position.y : 250;
    await this.moveTo(x, y, ((Math.round(targetAngle) % 360) + 360) % 360, speed);
  }

  /**
   * Move forward (or backward) relative to the current heading.
   *
   * dist > 0 = forward along the cube's current facing direction.
   * dist < 0 = backward.
   *
   * Reads the cube's live position/angle, computes the absolute target
   * coordinates, then calls moveTo().  Falls back to (250,250) / 0°
   * if no position has been received yet.
   */
  async moveRel(dist, speed = 80) {
    const pos      = this.position;
    const angleRad = pos.angle * Math.PI / 180;
    // 0° = North (up): forward = +sin(angle) in X, −cos(angle) in Y
    const nx = Math.round(pos.x + dist * Math.sin(angleRad));
    const ny = Math.round(pos.y - dist * Math.cos(angleRad));
    await this.moveTo(nx, ny, pos.angle, speed);
  }

  /**
   * Rotate by a relative angle from the current heading.
   *
   * dAngle > 0 = clockwise (right)
   * dAngle < 0 = counter-clockwise (left)
   */
  async rotateRel(dAngle, speed = 80) {
    const newAngle = ((this.position.angle + Math.round(dAngle)) % 360 + 360) % 360;
    await this.rotateTo(newAngle, speed);
  }

  /* ── Light ───────────────────────────────────────────────────────────────── */

  /**
   * Turn on the bottom LED.
   * durationMs > 0: LED auto-off after duration (JS waits the same time).
   * durationMs = 0: LED stays on indefinitely; JS returns immediately.
   */
  async setLED(r, g, b, durationMs = 0) {
    this.led = { r, g, b };
    const dur = Math.min(255, Math.round(Math.max(0, durationMs) / 10));
    const cmd = new Uint8Array([0x03, dur, 0x01, 0x01,
      Math.min(255, Math.max(0, r)),
      Math.min(255, Math.max(0, g)),
      Math.min(255, Math.max(0, b))]);
    await this._chars.light.writeValue(cmd);
    this._emit('led', { r, g, b });
    // ★ Wait for the LED duration before returning
    if (durationMs > 0) await _toioSleep(durationMs);
  }

  async turnOffLED() {
    // Type 0x01 = explicit off command (cleaner than setLED(0,0,0,0))
    const cmd = new Uint8Array([0x01]);
    await this._chars.light.writeValue(cmd);
    this.led = { r: 0, g: 0, b: 0 };
    this._emit('led', { r: 0, g: 0, b: 0 });
  }

  /* ── Sound ───────────────────────────────────────────────────────────────── */

  /**
   * Play a single MIDI note for durationMs.
   * JS waits for the note to finish before resolving.
   */
  async playSound(noteNo, durationMs = 500) {
    const dur = Math.min(255, Math.round(Math.max(0, durationMs) / 10));
    // Type 0x03: play MIDI — [type][numOps][repeat][dur][note][vol]
    const cmd = new Uint8Array([0x03, 0x01, 0x01, dur,
      Math.min(128, Math.max(0, noteNo)), 255]);
    await this._chars.sound.writeValue(cmd);
    // ★ Wait for the note to finish
    if (durationMs > 0) await _toioSleep(durationMs);
  }

  /**
   * Play a pre-programmed sound effect.
   * JS waits for the approximate effect duration before resolving.
   * IDs: 0=Enter 1=Selected 2=Cancel 3=Cursor 4=Mat 5=Get 6=Score 7=Lose
   */
  async playSoundEffect(effectId) {
    const id  = Math.min(10, Math.max(0, effectId));
    const cmd = new Uint8Array([0x02, id, 255]);
    await this._chars.sound.writeValue(cmd);
    // ★ Wait for the effect to finish (approximate durations from spec)
    await _toioSleep(EFFECT_DURATIONS[id] ?? 350);
  }

  /**
   * MIDIメロディの一括再生。notes = [[durationMs, noteNo, volume?], ...]
   * noteNo 128 = 休符。1回のBLE書き込みに最大59音（超過分は自動分割して順次送信）。
   * 演奏タイミングはキューブのファームウェアが刻むのでJS側のジッタが乗らない。
   * repeat: 曲全体の繰り返し回数。stopSound() で中断できる。
   */
  async playMelody(notes, repeat = 1) {
    const seq = ++this._melodySeq;
    for (let r = 0; r < repeat; r++) {
      for (let i = 0; i < notes.length; i += 59) {
        if (seq !== this._melodySeq) return;           // stopSound() された
        const chunk = notes.slice(i, i + 59);
        const bytes = [0x03, 0x01, chunk.length];
        let totalMs = 0;
        for (const [ms, note, vol] of chunk) {
          const d = Math.min(255, Math.max(1, Math.round(ms / 10)));
          bytes.push(d, Math.min(128, Math.max(0, note)), vol == null ? 255 : vol);
          totalMs += d * 10;
        }
        await this._chars.sound.writeValue(new Uint8Array(bytes));
        await _toioSleep(totalMs + 20);
      }
    }
  }

  async stopSound() {
    this._melodySeq = (this._melodySeq || 0) + 1;   // playMelody のループを止める
    const cmd = new Uint8Array([0x01]);
    await this._chars.sound.writeValue(cmd);
  }

  /* ── Battery ─────────────────────────────────────────────────────────────── */

  async getBattery() {
    const dv = await this._chars.battery.readValue();
    return dv.getUint8(0);
  }

  /* ── Button ──────────────────────────────────────────────────────────────── */

  /** Wait until the cube's physical button is pressed, then resolve. */
  async waitButton() {
    return new Promise(resolve => {
      const off = this.on('button', pressed => {
        if (pressed) { off(); resolve(); }
      });
    });
  }

  /* ── Events ──────────────────────────────────────────────────────────────── */

  on(event, fn) {
    if (!this._eventHandlers[event]) this._eventHandlers[event] = [];
    this._eventHandlers[event].push(fn);
    return () => {
      this._eventHandlers[event] =
        this._eventHandlers[event].filter(h => h !== fn);
    };
  }

  _emit(event, data) {
    (this._eventHandlers[event] || []).forEach(fn => fn(data));
  }
}

/* ── ToioManager ──────────────────────────────────────────────────────────── */
class ToioManager {
  constructor() {
    this._cubes    = [];
    this._listeners = {};
  }

  get cubes() { return this._cubes; }
  get count()  { return this._cubes.length; }

  /** Prompt BLE device picker and connect a new cube.
   *  cubeId (optional): 3桁ID (例 "954") — 会場に大量のtoioがある時、
   *  選択ダイアログを "toio Core Cube-954" だけに絞り込む。空なら全toio表示。 */
  async addCube(cubeId) {
    if (!navigator.bluetooth)
      throw new Error('Web Bluetooth is not supported in this browser.');

    const id = (cubeId || '').trim();
    // 名前形式はファームで異なる: "toio Core Cube-954" / "toio-954" 両対応（OR条件）
    const filters = id
      ? [{ namePrefix: `toio Core Cube-${id}` },
         { namePrefix: `toio-${id}` },
         { name: id }]
      : [{ services: [TOIO_SERVICE] }];
    const device = await navigator.bluetooth.requestDevice({
      filters,
      optionalServices: [TOIO_SERVICE],
    });

    const cube = new ToioDevice(device, this._cubes.length);
    await cube.connect();
    this._cubes.push(cube);

    cube.on('position', () => this._emit('update', cube));
    cube.on('led',      () => this._emit('update', cube));
    cube.on('button',   () => this._emit('update', cube));
    cube.on('disconnect', () => {
      this._cubes = this._cubes.filter(c => c !== cube);
      this._emit('remove', cube);
    });

    this._emit('add', cube);
    return cube;
  }

  get(index) { return this._cubes[index] || null; }

  /** Run fn(cube) on all cubes in parallel and wait for all to finish. */
  async all(fn) {
    await Promise.all(this._cubes.map(fn));
  }

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return () => {
      this._listeners[event] =
        this._listeners[event].filter(h => h !== fn);
    };
  }

  _emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  }
}

/* Singleton exposed globally */
const toioManager = new ToioManager();
