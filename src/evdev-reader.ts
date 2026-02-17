import * as fs from 'fs';
import { EventEmitter } from 'events';
import {
  RawInputEvent,
  PSNavEvent,
  PSNavButtonEvent,
  PSNavAxisEvent,
  EV_SYN,
  EV_KEY,
  EV_ABS,
} from './types';
import {
  BUTTON_MAP, AXIS_MAP, DPAD_AXIS_MAP,
  AMBIGUOUS_BTN_SOUTH, BTN_SOUTH_USB, BTN_SOUTH_BT,
} from './button-map';

// ─── Linux input_event struct ───────────────────────────────────────────────
// On 64-bit (Raspberry Pi OS 64-bit / aarch64):
//   struct input_event {
//     struct timeval { uint64 tv_sec; uint64 tv_usec; }  // 16 bytes
//     uint16_t type;                                       // 2 bytes
//     uint16_t code;                                       // 2 bytes
//     int32_t  value;                                      // 4 bytes
//   };                                                     // total: 24 bytes
//
// On 32-bit:
//   timeval is 2×uint32 = 8 bytes → total: 16 bytes
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_SIZE_64 = 24;
const EVENT_SIZE_32 = 16;

export interface EvdevReaderOptions {
  /** Path to the input device, e.g. /dev/input/event5 */
  devicePath: string;
  /** Set true if running 32-bit OS (default: false = 64-bit) */
  is32bit?: boolean;
}

export declare interface EvdevReader {
  on(event: 'raw', listener: (raw: RawInputEvent) => void): this;
  on(event: 'nav', listener: (nav: PSNavEvent) => void): this;
  on(event: 'open', listener: () => void): this;
  on(event: 'close', listener: (reason: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export class EvdevReader extends EventEmitter {
  private fd: number | null = null;
  private reading = false;
  private devicePath: string;
  private eventSize: number;
  private buf: Buffer;

  // Track D-pad hat axis state for proper press/release
  private dpadState: Record<number, number> = {};

  // Track last emitted stick values to suppress redundant deadzone events
  private lastStickValue: Record<string, number> = {};

  // Auto-detected input mode: USB (hid-sony) vs Bluetooth (hid-generic joystick)
  // USB axes: 0-255 (center 128)   |  BT axes: -127..127 (center 0)
  // USB buttons: 0x130+ (hid-sony) |  BT buttons: 0x120+ (generic joystick)
  private inputMode: 'unknown' | 'usb' | 'bluetooth' = 'unknown';

  // ─── Stick deadzone ─────────────────────────────────────────────────────
  // Values within [DEADZONE_MIN, DEADZONE_MAX] are clamped to DEADZONE_CENTER.
  // Events are only emitted when the clamped value actually changes.
  private static readonly DEADZONE_MIN = 118;
  private static readonly DEADZONE_MAX = 138;
  private static readonly DEADZONE_CENTER = 128;

  constructor(opts: EvdevReaderOptions) {
    super();
    this.devicePath = opts.devicePath;
    this.eventSize = opts.is32bit ? EVENT_SIZE_32 : EVENT_SIZE_64;
    this.buf = Buffer.alloc(this.eventSize);
  }

  /** Open the device and start the read loop */
  start(): void {
    try {
      this.fd = fs.openSync(this.devicePath, 'r');
    } catch (err) {
      const msg = `Cannot open ${this.devicePath}: ${(err as Error).message}`;
      this.emit('error', new Error(
        `${msg}. Make sure the device exists and you have read permissions (try running with sudo).`
      ));
      // Emit 'close' so the server's reconnect chain keeps retrying
      this.emit('close', msg);
      return;
    }

    this.reading = true;
    this.emit('open');
    console.log(`[evdev] Opened ${this.devicePath} (event size: ${this.eventSize} bytes)`);
    this.readLoop();
  }

  /** Stop reading and close the device */
  stop(): void {
    this.reading = false;
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch { /* ignore */ }
      this.fd = null;
    }
    this.emit('close', 'stopped');
  }

  // ─── Read loop ──────────────────────────────────────────────────────────

  private readLoop(): void {
    if (!this.reading || this.fd === null) return;

    fs.read(this.fd, this.buf, 0, this.eventSize, null, (err, bytesRead) => {
      if (err) {
        if (this.reading) {
          this.reading = false;
          // Close the fd to prevent leak
          if (this.fd !== null) {
            try { fs.closeSync(this.fd); } catch { /* ignore */ }
            this.fd = null;
          }
          this.emit('error', err);
          this.emit('close', err.message);
        }
        return;
      }

      if (bytesRead === this.eventSize) {
        const raw = this.parseEvent(this.buf);
        this.emit('raw', raw);
        this.mapAndEmit(raw);
      }

      // Schedule next read (non-blocking via setImmediate)
      setImmediate(() => this.readLoop());
    });
  }

  // ─── Parse raw bytes into RawInputEvent ─────────────────────────────────

  private parseEvent(buf: Buffer): RawInputEvent {
    if (this.eventSize === EVENT_SIZE_64) {
      // 64-bit: timeval is two 64-bit ints (little-endian)
      const timeSec = Number(buf.readBigUInt64LE(0));
      const timeUsec = Number(buf.readBigUInt64LE(8));
      const type = buf.readUInt16LE(16);
      const code = buf.readUInt16LE(18);
      const value = buf.readInt32LE(20);
      return { timeSec, timeUsec, type, code, value };
    } else {
      // 32-bit: timeval is two 32-bit ints
      const timeSec = buf.readUInt32LE(0);
      const timeUsec = buf.readUInt32LE(4);
      const type = buf.readUInt16LE(8);
      const code = buf.readUInt16LE(10);
      const value = buf.readInt32LE(12);
      return { timeSec, timeUsec, type, code, value };
    }
  }

  // ─── Map raw event to PS Navigation event ───────────────────────────────

  private mapAndEmit(raw: RawInputEvent): void {
    const now = Date.now();

    // Skip sync events
    if (raw.type === EV_SYN) return;

    // ── Auto-detect input mode ──
    // Bluetooth axes range -127..127 (negative values impossible in USB 0..255)
    // Button codes in 0x121..0x12e are unique to BT; 0x131..0x13d to USB.
    if (this.inputMode === 'unknown') {
      if (raw.type === EV_ABS && raw.value < 0) {
        this.inputMode = 'bluetooth';
        console.log('[evdev] Auto-detected Bluetooth mode (negative axis value)');
      } else if (raw.type === EV_ABS && raw.value > 127) {
        this.inputMode = 'usb';
        console.log('[evdev] Auto-detected USB mode (axis value > 127)');
      } else if (raw.type === EV_KEY && raw.code >= 0x121 && raw.code <= 0x12e) {
        this.inputMode = 'bluetooth';
        console.log('[evdev] Auto-detected Bluetooth mode (BT-only button code)');
      } else if (raw.type === EV_KEY && raw.code >= 0x131 && raw.code <= 0x13d) {
        this.inputMode = 'usb';
        console.log('[evdev] Auto-detected USB mode (USB-only button code)');
      }
    }

    // ── Button events ──
    if (raw.type === EV_KEY) {
      // Handle the ambiguous BTN_SOUTH (0x130): Cross in USB, PS in Bluetooth
      if (raw.code === AMBIGUOUS_BTN_SOUTH) {
        const button = this.inputMode === 'usb' ? BTN_SOUTH_USB : BTN_SOUTH_BT;
        const evt: PSNavButtonEvent = {
          kind: 'button',
          button,
          pressed: raw.value !== 0,
          timestamp: now,
        };
        this.emit('nav', evt);
        return;
      }

      const buttonMap = BUTTON_MAP[EV_KEY];
      if (buttonMap && raw.code in buttonMap) {
        const evt: PSNavButtonEvent = {
          kind: 'button',
          button: buttonMap[raw.code],
          pressed: raw.value !== 0,  // 1 = pressed, 0 = released, 2 = repeat
          timestamp: now,
        };
        this.emit('nav', evt);
        return;
      }
    }

    // ── Axis events ──
    if (raw.type === EV_ABS) {
      // Check D-pad hat axes first (USB/hid-sony only)
      if (raw.code in DPAD_AXIS_MAP) {
        this.handleDpadAxis(raw, now);
        return;
      }

      const axisMap = AXIS_MAP[EV_ABS];
      if (axisMap && raw.code in axisMap) {
        const axis = axisMap[raw.code];

        // Normalize axis value to 0-255 range
        // USB / hid-sony:  0..255 (center 128)  — no conversion needed
        // BT / hid-generic: -127..127 (center 0) — normalize to 0..255
        let value = raw.value;
        if (this.inputMode === 'bluetooth') {
          value = Math.round(((value + 127) / 254) * 255);
        }
        value = Math.max(0, Math.min(255, value));

        // Apply deadzone: clamp values in [118, 138] to 128
        const clamped =
          (value >= EvdevReader.DEADZONE_MIN && value <= EvdevReader.DEADZONE_MAX)
            ? EvdevReader.DEADZONE_CENTER
            : value;

        // Only emit when the clamped value actually changes
        if (this.lastStickValue[axis] === clamped) return;
        this.lastStickValue[axis] = clamped;

        const evt: PSNavAxisEvent = {
          kind: 'axis',
          axis,
          value: clamped,
          timestamp: now,
        };
        this.emit('nav', evt);
        return;
      }
    }
  }

  // ─── Handle D-pad hat axes (ABS_HAT0X / ABS_HAT0Y) ─────────────────────

  private handleDpadAxis(raw: RawInputEvent, now: number): void {
    const mapping = DPAD_AXIS_MAP[raw.code];
    if (!mapping) return;

    const prev = this.dpadState[raw.code] ?? 0;
    this.dpadState[raw.code] = raw.value;

    // Release previous direction
    if (prev < 0) {
      this.emit('nav', {
        kind: 'button',
        button: mapping.neg,
        pressed: false,
        timestamp: now,
      } as PSNavButtonEvent);
    } else if (prev > 0) {
      this.emit('nav', {
        kind: 'button',
        button: mapping.pos,
        pressed: false,
        timestamp: now,
      } as PSNavButtonEvent);
    }

    // Press new direction
    if (raw.value < 0) {
      this.emit('nav', {
        kind: 'button',
        button: mapping.neg,
        pressed: true,
        timestamp: now,
      } as PSNavButtonEvent);
    } else if (raw.value > 0) {
      this.emit('nav', {
        kind: 'button',
        button: mapping.pos,
        pressed: true,
        timestamp: now,
      } as PSNavButtonEvent);
    }
  }
}
