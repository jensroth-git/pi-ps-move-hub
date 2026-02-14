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

// ─── Service manager types ──────────────────────────────────────────────────

export interface RegisteredClient {
  socketId: string;
  serviceName: string;
  registeredAt: number;
}

export interface ClientListInfo {
  clients: RegisteredClient[];
  activeIndex: number;           // -1 if none active
  activeServiceName: string | null;
}

// ─── Socket.IO event map ────────────────────────────────────────────────────

export interface ServerToClientEvents {
  'nav:button': (event: PSNavButtonEvent) => void;
  'nav:axis': (event: PSNavAxisEvent) => void;
  'nav:raw': (event: RawInputEvent) => void;
  'nav:connected': (info: { device: string }) => void;
  'nav:disconnected': (info: { device: string; reason: string }) => void;

  /** Sent to the newly active client */
  'client:activated': (info: { serviceName: string }) => void;
  /** Sent to the previously active client */
  'client:deactivated': (info: { serviceName: string }) => void;
  /** Broadcast to all clients when the client list or active client changes */
  'client:list': (info: ClientListInfo) => void;
}

export interface ClientToServerEvents {
  'subscribe:raw': (enabled: boolean) => void;
  /** Register this socket as a named service */
  'register': (serviceName: string) => void;
}

export interface InterServerEvents {}

export interface SocketData {
  wantsRaw: boolean;
  serviceName: string | null;
}
