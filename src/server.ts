import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { EvdevReader } from './evdev-reader';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
  PSNavButtonEvent,
  PSNavAxisEvent,
  RawInputEvent,
} from './types';

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3050', 10);
const DEVICE_PATH = process.env.DEVICE_PATH ?? '/dev/input/event5';
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

// ─── Health / status endpoint ───────────────────────────────────────────────

let connectedClients = 0;
let deviceConnected = false;

app.get('/', (_req, res) => {
  res.json({
    name: 'psmovehub',
    status: 'running',
    device: DEVICE_PATH,
    deviceConnected,
    clients: connectedClients,
    uptime: process.uptime(),
  });
});

// ─── Socket.IO connection handling ──────────────────────────────────────────

io.on('connection', (socket) => {
  connectedClients++;
  socket.data.wantsRaw = false;

  console.log(`[io] Client connected: ${socket.id} (${connectedClients} total)`);

  // Let client know current device status
  if (deviceConnected) {
    socket.emit('nav:connected', { device: DEVICE_PATH });
  }

  // Client can opt-in to raw events
  socket.on('subscribe:raw', (enabled) => {
    socket.data.wantsRaw = enabled;
    console.log(`[io] ${socket.id} raw events: ${enabled}`);
  });

  socket.on('disconnect', (reason) => {
    connectedClients--;
    console.log(`[io] Client disconnected: ${socket.id} (${reason}) — ${connectedClients} remaining`);
  });
});

// ─── Evdev reader ───────────────────────────────────────────────────────────

function startEvdevReader(): void {
  const reader = new EvdevReader({ devicePath: DEVICE_PATH, is32bit: IS_32BIT });

  reader.on('open', () => {
    deviceConnected = true;
    io.emit('nav:connected', { device: DEVICE_PATH });
    console.log(`[evdev] Device connected: ${DEVICE_PATH}`);
  });

  reader.on('nav', (event) => {
    if (event.kind === 'button') {
      io.emit('nav:button', event as PSNavButtonEvent);
    } else if (event.kind === 'axis') {
      io.emit('nav:axis', event as PSNavAxisEvent);
    }
  });

  reader.on('raw', (raw: RawInputEvent) => {
    // Only send to clients that opted in
    for (const [, socket] of io.sockets.sockets) {
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
    io.emit('nav:disconnected', { device: DEVICE_PATH, reason });
    console.log(`[evdev] Device closed: ${reason}`);

    // Auto-reconnect after 3 seconds
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

  // Simulate stick movement
  setInterval(() => {
    const now = Date.now();
    const x = Math.round(128 + 127 * Math.sin(now / 1000));
    const y = Math.round(128 + 127 * Math.cos(now / 1000));

    io.emit('nav:axis', {
      kind: 'axis',
      axis: 'stick_x',
      value: x,
      timestamp: now,
    });
    io.emit('nav:axis', {
      kind: 'axis',
      axis: 'stick_y',
      value: y,
      timestamp: now,
    });
  }, 50);

  // Simulate random button presses
  const buttons: Array<PSNavButtonEvent['button']> = [
    'cross', 'circle', 'l1', 'l2', 'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
  ];
  setInterval(() => {
    const btn = buttons[Math.floor(Math.random() * buttons.length)];
    const now = Date.now();

    io.emit('nav:button', { kind: 'button', button: btn, pressed: true, timestamp: now });

    // Release after 100ms
    setTimeout(() => {
      io.emit('nav:button', { kind: 'button', button: btn, pressed: false, timestamp: Date.now() });
    }, 100);
  }, 2000);
}

// ─── Start ──────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n  ┌──────────────────────────────────────────┐`);
  console.log(`  │  psmovehub — PS Navigation Socket.IO     │`);
  console.log(`  │  Server running on http://0.0.0.0:${PORT}  │`);
  console.log(`  │  Device: ${DEVICE_PATH.padEnd(30)}│`);
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
