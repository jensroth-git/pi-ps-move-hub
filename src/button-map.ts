import { EV_KEY, EV_ABS, PSNavButton, PSNavAxis } from './types';

// ─── PS Navigation Controller evdev code mappings ───────────────────────────
//
// These are the typical codes when the PS Navigation controller is connected
// via Bluetooth on a Raspberry Pi using the default hid-sony / hid-generic
// driver. If your codes differ, run `evtest /dev/input/event5` and update
// the maps below.
//
// Discover your codes:
//   sudo apt install evtest
//   sudo evtest /dev/input/event5
// ─────────────────────────────────────────────────────────────────────────────

/** Map of { evType -> { evCode -> button/axis name } } */
export const BUTTON_MAP: Record<number, Record<number, PSNavButton>> = {
  [EV_KEY]: {
    0x120: 'cross',        // BTN_TRIGGER
    0x121: 'circle',       // BTN_THUMB
    0x122: 'l1',           // BTN_THUMB2
    0x123: 'l2',           // BTN_TOP
    0x124: 'l3',           // BTN_TOP2
    0x125: 'ps',           // BTN_BASE

    // Alternative HID-Sony mapping (common on Pi)
    0x130: 'cross',        // BTN_A
    0x131: 'circle',       // BTN_B
    0x136: 'l1',           // BTN_TL
    0x137: 'l2',           // BTN_TR  (L2 digital)
    0x13d: 'l3',           // BTN_THUMBL
    0x13c: 'ps',           // BTN_MODE

    // D-pad as buttons (some drivers)
    0x220: 'dpad_up',      // BTN_DPAD_UP
    0x221: 'dpad_down',    // BTN_DPAD_DOWN
    0x222: 'dpad_left',    // BTN_DPAD_LEFT
    0x223: 'dpad_right',   // BTN_DPAD_RIGHT
  },
};

export const AXIS_MAP: Record<number, Record<number, PSNavAxis>> = {
  [EV_ABS]: {
    0x00: 'stick_x',       // ABS_X   – left stick horizontal
    0x01: 'stick_y',       // ABS_Y   – left stick vertical
    0x02: 'l2_analog',     // ABS_Z   – L2 analog pressure (some drivers)
    0x05: 'l2_analog',     // ABS_RZ  – L2 analog pressure (alt mapping)
  },
};

// D-pad as axis (hat) — some drivers expose D-pad as ABS_HAT0X / ABS_HAT0Y
export const DPAD_AXIS_MAP: Record<number, { neg: PSNavButton; pos: PSNavButton }> = {
  0x10: { neg: 'dpad_left', pos: 'dpad_right' },  // ABS_HAT0X
  0x11: { neg: 'dpad_up',   pos: 'dpad_down' },   // ABS_HAT0Y
};
