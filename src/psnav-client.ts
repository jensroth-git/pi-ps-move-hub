/**
 * psnav-client.ts — Single-file PS Navigation controller client
 *
 * Drop this file into any project that has `socket.io-client` installed.
 * All types are self-contained — no imports from psmovehub needed.
 *
 * Usage:
 *   import { PSNavClient } from './psnav-client';
 *
 *   const nav = new PSNavClient('http://192.168.1.50:3050');
 *
 *   nav.on('button', (evt) => console.log(evt.button, evt.pressed));
 *   nav.on('axis',   (evt) => console.log(evt.axis, evt.value));
 *
 *   nav.connect();
 */

import { io, Socket } from 'socket.io-client';

// ─── Types (self-contained, mirrors server) ─────────────────────────────────

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
  pressed: boolean;
  timestamp: number;
}

export interface PSNavAxisEvent {
  kind: 'axis';
  axis: PSNavAxis;
  value: number;
  timestamp: number;
}

export type PSNavEvent = PSNavButtonEvent | PSNavAxisEvent;

export interface RawInputEvent {
  timeSec: number;
  timeUsec: number;
  type: number;
  code: number;
  value: number;
}

// ─── Callback types ─────────────────────────────────────────────────────────

type ButtonCallback = (event: PSNavButtonEvent) => void;
type AxisCallback   = (event: PSNavAxisEvent) => void;
type RawCallback    = (event: RawInputEvent) => void;
type DeviceCallback = (info: { device: string; reason?: string }) => void;
type VoidCallback   = () => void;

interface CallbackMap {
  button:       Set<ButtonCallback>;
  axis:         Set<AxisCallback>;
  raw:          Set<RawCallback>;
  connected:    Set<DeviceCallback>;
  disconnected: Set<DeviceCallback>;
  open:         Set<VoidCallback>;
  close:        Set<VoidCallback>;
}

type EventName = keyof CallbackMap;
type CallbackFor<E extends EventName> = CallbackMap[E] extends Set<infer T> ? T : never;

// ─── Client options ─────────────────────────────────────────────────────────

export interface PSNavClientOptions {
  /** Subscribe to raw evdev events (default: false) */
  raw?: boolean;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
  /** socket.io-client connect options passthrough */
  socketOpts?: Parameters<typeof io>[1];
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class PSNavClient {
  private url: string;
  private opts: Required<Pick<PSNavClientOptions, 'raw' | 'reconnect'>> & Pick<PSNavClientOptions, 'socketOpts'>;
  private socket: Socket | null = null;

  private callbacks: CallbackMap = {
    button:       new Set(),
    axis:         new Set(),
    raw:          new Set(),
    connected:    new Set(),
    disconnected: new Set(),
    open:         new Set(),
    close:        new Set(),
  };

  // ── Snapshot of latest state ──
  /** Current button states (true = held) */
  public buttons: Record<PSNavButton, boolean> = {
    cross: false, circle: false,
    l1: false, l2: false, l3: false,
    dpad_up: false, dpad_down: false, dpad_left: false, dpad_right: false,
    ps: false,
  };

  /** Current axis values (0-255, center ≈ 128) */
  public axes: Record<PSNavAxis, number> = {
    stick_x: 128,
    stick_y: 128,
    l2_analog: 0,
  };

  constructor(url: string, opts: PSNavClientOptions = {}) {
    this.url = url;
    this.opts = {
      raw: opts.raw ?? false,
      reconnect: opts.reconnect ?? true,
      socketOpts: opts.socketOpts,
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Connect to the psmovehub server */
  connect(): void {
    if (this.socket) return;

    this.socket = io(this.url, {
      reconnection: this.opts.reconnect,
      ...this.opts.socketOpts,
    });

    this.socket.on('connect', () => {
      if (this.opts.raw) {
        this.socket!.emit('subscribe:raw', true);
      }
      this.fire('open');
    });

    this.socket.on('disconnect', () => {
      this.fire('close');
    });

    // ── Server events ──

    this.socket.on('nav:button', (evt: PSNavButtonEvent) => {
      this.buttons[evt.button] = evt.pressed;
      this.fire('button', evt);
    });

    this.socket.on('nav:axis', (evt: PSNavAxisEvent) => {
      this.axes[evt.axis] = evt.value;
      this.fire('axis', evt);
    });

    this.socket.on('nav:raw', (evt: RawInputEvent) => {
      this.fire('raw', evt);
    });

    this.socket.on('nav:connected', (info: { device: string }) => {
      this.fire('connected', info);
    });

    this.socket.on('nav:disconnected', (info: { device: string; reason: string }) => {
      this.fire('disconnected', info);
    });
  }

  /** Disconnect from the server */
  disconnect(): void {
    if (!this.socket) return;
    this.socket.disconnect();
    this.socket = null;
  }

  /** True when socket is connected */
  get isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  // ─── Event subscription ─────────────────────────────────────────────────

  on<E extends EventName>(event: E, callback: CallbackFor<E>): this {
    (this.callbacks[event] as Set<CallbackFor<E>>).add(callback);
    return this;
  }

  off<E extends EventName>(event: E, callback: CallbackFor<E>): this {
    (this.callbacks[event] as Set<CallbackFor<E>>).delete(callback);
    return this;
  }

  /** Subscribe to a specific button only */
  onButton(button: PSNavButton, callback: (pressed: boolean) => void): this {
    return this.on('button', (evt) => {
      if (evt.button === button) callback(evt.pressed);
    });
  }

  /** Subscribe to a specific axis only */
  onAxis(axis: PSNavAxis, callback: (value: number) => void): this {
    return this.on('axis', (evt) => {
      if (evt.axis === axis) callback(evt.value);
    });
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private fire(event: EventName, ...args: unknown[]): void {
    for (const cb of this.callbacks[event]) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }
}
