import { EV_KEY, EV_ABS, PSNavButton, PSNavAxis } from './types';

// ─── PS Navigation Controller evdev code mappings ───────────────────────────
//
// The PS Nav controller reports different event codes depending on whether it's
// connected via USB (hid-sony kernel driver) or via Bluetooth (hid-generic
// joystick driver). This file defines non-conflicting mappings for both modes.
//
// One code is ambiguous: BTN_SOUTH (0x130) = Cross in USB mode, PS in BT mode.
// This is handled by evdev-reader.ts via auto-detection.
//
// Discover your codes:
//   sudo apt install evtest
//   sudo evtest /dev/input/eventX
// ─────────────────────────────────────────────────────────────────────────────

/** Map of { evType -> { evCode -> button name } } — non-conflicting codes only */
export const BUTTON_MAP: Record<number, Record<number, PSNavButton>> = {
  [EV_KEY]: {
    // ── Bluetooth / hid-generic joystick mode ───────────────────────────
    // When connected via Bluetooth, the kernel's generic joystick driver
    // maps PS3 HID report buttons sequentially from BTN_TRIGGER (0x120):
    //   Select, L3, R3, Start, Up, Right, Down, Left,
    //   L2, R2, L1, R1, Triangle, Circle, Cross, Square, PS
    0x121: 'l3',           // BTN_THUMB    — L3 (stick press)
    0x124: 'dpad_up',      // BTN_TOP2     — D-pad Up
    0x125: 'dpad_right',   // BTN_PINKIE   — D-pad Right
    0x126: 'dpad_down',    // BTN_BASE     — D-pad Down
    0x127: 'dpad_left',    // BTN_BASE2    — D-pad Left
    0x128: 'l2',           // BTN_BASE3    — L2 (digital)
    0x12a: 'l1',           // BTN_BASE5    — L1
    0x12d: 'circle',       // code 301     — Circle
    0x12e: 'cross',        // code 302     — Cross

    // ── USB / hid-sony driver mode ──────────────────────────────────────
    // When connected via USB, the hid-sony kernel driver provides these.
    // NOTE: BTN_SOUTH (0x130) = Cross in this mode — handled separately
    //       in evdev-reader.ts because it conflicts with BT mode (= PS).
    0x131: 'circle',       // BTN_EAST     — Circle
    0x136: 'l1',           // BTN_TL       — L1
    0x138: 'l2',           // BTN_TL2      — L2 (digital)
    0x13c: 'ps',           // BTN_MODE     — PS button
    0x13d: 'l3',           // BTN_THUMBL   — L3 (stick press)

    // ── D-pad as buttons (hid-sony / some drivers) ──────────────────────
    0x220: 'dpad_up',      // BTN_DPAD_UP
    0x221: 'dpad_down',    // BTN_DPAD_DOWN
    0x222: 'dpad_left',    // BTN_DPAD_LEFT
    0x223: 'dpad_right',   // BTN_DPAD_RIGHT
  },
};

/** The ambiguous BTN_SOUTH (0x130) code — resolved based on detected input mode */
export const AMBIGUOUS_BTN_SOUTH = 0x130;
export const BTN_SOUTH_USB: PSNavButton = 'cross';   // USB / hid-sony
export const BTN_SOUTH_BT: PSNavButton = 'ps';       // Bluetooth / hid-generic

export const AXIS_MAP: Record<number, Record<number, PSNavAxis>> = {
  [EV_ABS]: {
    0x00: 'stick_x',       // ABS_X   – left stick horizontal
    0x01: 'stick_y',       // ABS_Y   – left stick vertical
    0x02: 'l2_analog',     // ABS_Z   – L2 analog pressure
  },
};

// D-pad as axis (hat) — hid-sony driver exposes D-pad as ABS_HAT0X / ABS_HAT0Y
export const DPAD_AXIS_MAP: Record<number, { neg: PSNavButton; pos: PSNavButton }> = {
  0x10: { neg: 'dpad_left', pos: 'dpad_right' },  // ABS_HAT0X
  0x11: { neg: 'dpad_up',   pos: 'dpad_down' },   // ABS_HAT0Y
};
