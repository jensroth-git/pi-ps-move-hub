// ─── Linux evdev event types ─────────────────────────────────────────────────

/** Raw input_event as read from /dev/input/eventX (24 bytes on 64-bit) */
export interface RawInputEvent {
  timeSec: number;
  timeUsec: number;
  type: number;
  code: number;
  value: number;
}

// ─── Evdev constants ─────────────────────────────────────────────────────────

export const EV_SYN = 0x00;
export const EV_KEY = 0x01;
export const EV_ABS = 0x03;

// ─── PS Navigation mapped events ────────────────────────────────────────────

export type PSNavButton =
  | 'cross'
  | 'circle'
  | 'l1'
  | 'l2'
  | 'l3'
  | 'dpad_up'
  | 'dpad_down'
  | 'dpad_left'
  | 'dpad_right'
  | 'ps';

export type PSNavAxis =
  | 'stick_x'
  | 'stick_y'
  | 'l2_analog';

export interface PSNavButtonEvent {
  kind: 'button';
  button: PSNavButton;
  pressed: boolean;        // true = pressed, false = released
  timestamp: number;       // ms since epoch
}

export interface PSNavAxisEvent {
  kind: 'axis';
  axis: PSNavAxis;
  value: number;           // 0-255 for axes
  timestamp: number;
}

export type PSNavEvent = PSNavButtonEvent | PSNavAxisEvent;

// ─── Socket.IO event map ────────────────────────────────────────────────────

export interface ServerToClientEvents {
  'nav:button': (event: PSNavButtonEvent) => void;
  'nav:axis': (event: PSNavAxisEvent) => void;
  'nav:raw': (event: RawInputEvent) => void;
  'nav:connected': (info: { device: string }) => void;
  'nav:disconnected': (info: { device: string; reason: string }) => void;
}

export interface ClientToServerEvents {
  'subscribe:raw': (enabled: boolean) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  wantsRaw: boolean;
}
