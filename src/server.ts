import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EvdevReader } from './evdev-reader';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  PSNavButtonEvent,
  PSNavAxisEvent,
  RawInputEvent,
  RegisteredClient,
  ClientListInfo,
  BatteryStatus,
} from './types';

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3050', 10);
const DEVICE_PATH_FALLBACK = process.env.DEVICE_PATH ?? '/dev/input/event5';
const IS_32BIT = process.env.IS_32BIT === '1';
const MOCK_INPUT = process.env.MOCK_INPUT === '1';

// ─── Express + HTTP + Socket.IO ─────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(httpServer, {
  cors: {
    origin: '*',               // allow any client origin
    methods: ['GET', 'POST'],
  },
});

// ─── Service Manager ────────────────────────────────────────────────────────

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

const registeredClients: RegisteredClient[] = [];
let activeIndex = -1;

function getClientListInfo(): ClientListInfo {
  return {
    clients: [...registeredClients],
    activeIndex,
    activeServiceName: activeIndex >= 0 ? registeredClients[activeIndex].serviceName : null,
  };
}

function broadcastClientList(): void {
  io.emit('client:list', getClientListInfo());
}

function getActiveSocket(): TypedSocket | null {
  if (activeIndex < 0 || activeIndex >= registeredClients.length) return null;
  const entry = registeredClients[activeIndex];
  return io.sockets.sockets.get(entry.socketId) as TypedSocket | undefined ?? null;
}

/** Get all connected sockets that never called register (always-on observers) */
function getUnregisteredSockets(): TypedSocket[] {
  const result: TypedSocket[] = [];
  for (const [, socket] of io.sockets.sockets) {
    if (!socket.data.serviceName) {
      result.push(socket as TypedSocket);
    }
  }
  return result;
}

/**
 * Emit a nav event to: the active registered client + all unregistered clients.
 * Unregistered clients are "always-on" — they receive events regardless of who
 * is currently active in the service rotation.
 */
function emitNavEvent(event: 'nav:button', data: PSNavButtonEvent): void;
function emitNavEvent(event: 'nav:axis', data: PSNavAxisEvent): void;
function emitNavEvent(event: 'nav:button' | 'nav:axis', data: PSNavButtonEvent | PSNavAxisEvent): void {
  // Active registered client
  const active = getActiveSocket();
  if (active) active.emit(event as any, data as any);

  // All unregistered (always-on) clients
  for (const socket of getUnregisteredSockets()) {
    socket.emit(event as any, data as any);
  }
}

function registerClient(socket: TypedSocket, serviceName: string): void {
  // Prevent double registration — update name if already registered
  const existing = registeredClients.findIndex((c) => c.socketId === socket.id);
  if (existing >= 0) {
    registeredClients[existing].serviceName = serviceName;
    console.log(`[svc] Updated registration: "${serviceName}" (${socket.id})`);
  } else {
    registeredClients.push({
      socketId: socket.id,
      serviceName,
      registeredAt: Date.now(),
    });
    console.log(`[svc] Registered: "${serviceName}" (${socket.id}) — ${registeredClients.length} service(s)`);
  }

  socket.data.serviceName = serviceName;

  // If this is the first client, auto-activate it
  if (registeredClients.length === 1) {
    activeIndex = 0;
    socket.emit('client:activated', { serviceName });
    console.log(`[svc] Auto-activated: "${serviceName}"`);
  }

  broadcastClientList();
}

function unregisterClient(socketId: string): void {
  const idx = registeredClients.findIndex((c) => c.socketId === socketId);
  if (idx < 0) return;

  const removed = registeredClients[idx];
  registeredClients.splice(idx, 1);
  console.log(`[svc] Unregistered: "${removed.serviceName}" (${socketId}) — ${registeredClients.length} service(s)`);

  // Adjust activeIndex after removal
  if (registeredClients.length === 0) {
    activeIndex = -1;
  } else if (idx === activeIndex) {
    // The active client left — activate the next (wrap around)
    activeIndex = activeIndex % registeredClients.length;
    const next = getActiveSocket();
    if (next) {
      const name = registeredClients[activeIndex].serviceName;
      next.emit('client:activated', { serviceName: name });
      console.log(`[svc] Active client left, switched to: "${name}"`);
    }
  } else if (idx < activeIndex) {
    // Someone before the active was removed — shift index back
    activeIndex--;
  }

  broadcastClientList();
}

function cycleActiveClient(): void {
  if (registeredClients.length === 0) return;

  // Deactivate current
  const prevSocket = getActiveSocket();
  if (prevSocket && activeIndex >= 0) {
    const prevName = registeredClients[activeIndex].serviceName;
    prevSocket.emit('client:deactivated', { serviceName: prevName });
  }

  // Advance to next
  activeIndex = (activeIndex + 1) % registeredClients.length;

  // Activate new
  const nextSocket = getActiveSocket();
  if (nextSocket) {
    const nextName = registeredClients[activeIndex].serviceName;
    nextSocket.emit('client:activated', { serviceName: nextName });
    console.log(`[svc] Switched active client → "${nextName}"`);
  }

  broadcastClientList();
}

// ─── Battery status (sysfs) ─────────────────────────────────────────────────

const POWER_SUPPLY_PATH = '/sys/class/power_supply';

/**
 * Read battery percentage from the Linux power_supply sysfs interface.
 * When a PS3 controller is connected via Bluetooth with hid-sony, the kernel
 * creates an entry like `sony_controller_battery_XX:XX:XX:XX:XX:XX`.
 */
async function getBatteryStatus(): Promise<BatteryStatus> {
  const fail: BatteryStatus = { level: null, charging: null, source: null, timestamp: Date.now() };

  let entries: string[];
  try {
    entries = await fs.readdir(POWER_SUPPLY_PATH);
  } catch {
    return fail;
  }

  // Find a power_supply entry that looks like a game controller battery
  const batteryEntry = entries.find((e) => {
    const lower = e.toLowerCase();
    return lower.includes('sony') || lower.includes('controller') || lower.includes('playstation');
  });

  if (!batteryEntry) return fail;

  const basePath = path.join(POWER_SUPPLY_PATH, batteryEntry);

  let level: number | null = null;
  try {
    const raw = await fs.readFile(path.join(basePath, 'capacity'), 'utf-8');
    const parsed = parseInt(raw.trim(), 10);
    if (!isNaN(parsed)) level = parsed;
  } catch { /* capacity file not available */ }

  let charging: boolean | null = null;
  try {
    const raw = await fs.readFile(path.join(basePath, 'status'), 'utf-8');
    const status = raw.trim().toLowerCase();
    charging = status === 'charging' || status === 'full';
  } catch { /* status file not available */ }

  return { level, charging, source: batteryEntry, timestamp: Date.now() };
}

// ─── Controller device auto-discovery ────────────────────────────────────────

const INPUT_SYSFS = '/sys/class/input';

/**
 * Scan /sys/class/input/eventX/device/name for a PlayStation controller.
 * Returns the /dev/input/eventX path if found, otherwise null.
 * This is called on every (re)connect so we always find the right device
 * even if the event number changed after a Bluetooth disconnect/reconnect.
 */
async function findControllerDevice(): Promise<string | null> {
  try {
    const entries = await fs.readdir(INPUT_SYSFS);
    for (const entry of entries) {
      if (!entry.startsWith('event')) continue;
      try {
        const name = await fs.readFile(
          path.join(INPUT_SYSFS, entry, 'device', 'name'),
          'utf-8',
        );
        if (name.toLowerCase().includes('playstation')) {
          return `/dev/input/${entry}`;
        }
      } catch { /* entry has no name file — skip */ }
    }
  } catch { /* sysfs not available */ }
  return null;
}

// ─── Health / status endpoint ───────────────────────────────────────────────

let connectedClients = 0;
let deviceConnected = false;
let currentDevicePath = DEVICE_PATH_FALLBACK;

app.get('/', async (_req, res) => {
  const battery = await getBatteryStatus();
  res.json({
    name: 'psmovehub',
    status: 'running',
    device: currentDevicePath,
    deviceConnected,
    battery,
    clients: connectedClients,
    services: getClientListInfo(),
    uptime: process.uptime(),
  });
});

// ─── Socket.IO connection handling ──────────────────────────────────────────

io.on('connection', (socket) => {
  connectedClients++;
  socket.data.wantsRaw = false;
  socket.data.serviceName = null;

  console.log(`[io] Client connected: ${socket.id} (${connectedClients} total)`);

  // Let client know current device status
  if (deviceConnected) {
    socket.emit('nav:connected', { device: currentDevicePath });
  }

  // Send current service list so the client knows the state
  socket.emit('client:list', getClientListInfo());

  // ── Register as a named service ──
  socket.on('register', (serviceName) => {
    registerClient(socket, serviceName);
  });

  // Client can opt-in to raw events
  socket.on('subscribe:raw', (enabled) => {
    socket.data.wantsRaw = enabled;
    console.log(`[io] ${socket.id} raw events: ${enabled}`);
  });

  // Battery status on request
  socket.on('battery:request', async () => {
    const status = await getBatteryStatus();
    socket.emit('battery:status', status);
  });

  socket.on('disconnect', (reason) => {
    connectedClients--;
    unregisterClient(socket.id);
    console.log(`[io] Client disconnected: ${socket.id} (${reason}) — ${connectedClients} remaining`);
  });
});

// ─── Evdev reader ───────────────────────────────────────────────────────────

async function startEvdevReader(): Promise<void> {
  // Auto-discover the controller device, fall back to configured path
  const discovered = await findControllerDevice();
  const devicePath = discovered ?? DEVICE_PATH_FALLBACK;
  currentDevicePath = devicePath;

  if (discovered) {
    console.log(`[evdev] Auto-discovered controller at: ${discovered}`);
  } else {
    console.log(`[evdev] No controller found via sysfs, falling back to: ${DEVICE_PATH_FALLBACK}`);
  }

  const reader = new EvdevReader({ devicePath, is32bit: IS_32BIT });

  reader.on('open', () => {
    deviceConnected = true;
    io.emit('nav:connected', { device: devicePath });
    console.log(`[evdev] Device connected: ${devicePath}`);
  });

  reader.on('nav', (event) => {
    // ── PS button: cycle active client (consume, don't forward) ──
    if (event.kind === 'button' && event.button === 'ps' && event.pressed) {
      cycleActiveClient();
      return;
    }

    // ── Forward to active registered client + all unregistered (always-on) clients ──
    if (event.kind === 'button') {
      emitNavEvent('nav:button', event as PSNavButtonEvent);
    } else if (event.kind === 'axis') {
      emitNavEvent('nav:axis', event as PSNavAxisEvent);
    }
  });

  reader.on('raw', (raw: RawInputEvent) => {
    // Active registered client
    const active = getActiveSocket();
    if (active?.data.wantsRaw) {
      active.emit('nav:raw', raw);
    }
    // Unregistered always-on clients
    for (const socket of getUnregisteredSockets()) {
      if (socket.data.wantsRaw) {
        socket.emit('nav:raw', raw);
      }
    }
  });

  reader.on('error', (err) => {
    console.error(`[evdev] Error: ${err.message}`);
  });

  reader.on('close', (reason) => {
    deviceConnected = false;
    io.emit('nav:disconnected', { device: devicePath, reason });
    console.log(`[evdev] Device closed: ${reason}`);

    // Auto-reconnect after 3 seconds — re-discovers the device path
    console.log('[evdev] Reconnecting in 3s...');
    setTimeout(() => startEvdevReader(), 3000);
  });

  reader.start();
}

// ─── Mock input for development/testing without the actual controller ────────

function startMockInput(): void {
  console.log('[mock] Starting mock PS Navigation input (no real device)');
  deviceConnected = true;
  io.emit('nav:connected', { device: 'mock' });

  // Simulate stick movement → active registered + all unregistered
  setInterval(() => {
    const now = Date.now();
    const x = Math.round(128 + 127 * Math.sin(now / 1000));
    const y = Math.round(128 + 127 * Math.cos(now / 1000));

    emitNavEvent('nav:axis', { kind: 'axis', axis: 'stick_x', value: x, timestamp: now });
    emitNavEvent('nav:axis', { kind: 'axis', axis: 'stick_y', value: y, timestamp: now });
  }, 50);

  // Simulate random button presses → active registered + all unregistered
  const buttons: Array<PSNavButtonEvent['button']> = [
    'cross', 'circle', 'l1', 'l2', 'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
  ];
  setInterval(() => {
    const btn = buttons[Math.floor(Math.random() * buttons.length)];
    const now = Date.now();

    emitNavEvent('nav:button', { kind: 'button', button: btn, pressed: true, timestamp: now });
    setTimeout(() => {
      emitNavEvent('nav:button', { kind: 'button', button: btn, pressed: false, timestamp: Date.now() });
    }, 100);
  }, 2000);

  // Simulate PS button press every 8s → cycles active registered client
  setInterval(() => {
    console.log('[mock] Simulating PS button → cycling active client');
    cycleActiveClient();
  }, 8000);
}

// ─── Start ──────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n  ┌──────────────────────────────────────────┐`);
  console.log(`  │  psmovehub — PS Navigation Socket.IO     │`);
  console.log(`  │  Server running on http://0.0.0.0:${PORT}  │`);
  console.log(`  │  Fallback: ${DEVICE_PATH_FALLBACK.padEnd(28)}│`);
  console.log(`  │  Discovery: auto (sysfs)                 │`);
  console.log(`  │  Mode: ${(MOCK_INPUT ? 'MOCK' : 'LIVE').padEnd(32)}│`);
  console.log(`  └──────────────────────────────────────────┘\n`);

  if (MOCK_INPUT) {
    startMockInput();
  } else {
    startEvdevReader();
  }
});

// ─── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(signal: string): void {
  console.log(`\n[server] ${signal} received, shutting down...`);
  io.disconnectSockets(true);
  httpServer.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
