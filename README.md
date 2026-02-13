# psmovehub

Socket.IO server that reads PS Navigation controller input events from a Raspberry Pi 5 and broadcasts them to any number of connected clients in real time.

## Architecture

```
PS Navigation Controller
        │  (Bluetooth)
        ▼
  Raspberry Pi 5
  /dev/input/event5     ← raw evdev input
        │
  ┌─────┴─────┐
  │  psmovehub │         ← Node.js + TypeScript
  │  :3050     │
  └─────┬─────┘
        │  Socket.IO
        ▼
  Client(s)              ← browser, Node, Python, etc.
```

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run on the Pi (requires read access to the input device)
sudo node dist/server.js

# Or run with ts-node (dev)
sudo npx ts-node src/server.ts
```

## Configuration

Environment variables:

| Variable      | Default              | Description                              |
|---------------|----------------------|------------------------------------------|
| `PORT`        | `3050`               | HTTP / Socket.IO port                    |
| `DEVICE_PATH` | `/dev/input/event5` | evdev device path for the controller     |
| `IS_32BIT`    | `0`                  | Set to `1` if running 32-bit Raspberry Pi OS |
| `MOCK_INPUT`  | `0`                  | Set to `1` to run with simulated input   |

## Socket.IO Events (Server → Client)

### `nav:button`
```json
{
  "kind": "button",
  "button": "cross",
  "pressed": true,
  "timestamp": 1707840000000
}
```
Buttons: `cross`, `circle`, `l1`, `l2`, `l3`, `dpad_up`, `dpad_down`, `dpad_left`, `dpad_right`, `ps`

### `nav:axis`
```json
{
  "kind": "axis",
  "axis": "stick_x",
  "value": 128,
  "timestamp": 1707840000000
}
```
Axes: `stick_x` (0-255), `stick_y` (0-255), `l2_analog` (0-255)

### `nav:raw` (opt-in)
Raw `input_event` struct fields — subscribe by emitting `subscribe:raw` with `true`.

### `nav:connected` / `nav:disconnected`
Device lifecycle events.

## Client Example (Browser)

```html
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
  const socket = io('http://<PI_IP>:3050');

  socket.on('nav:button', (evt) => {
    console.log(`${evt.button} ${evt.pressed ? 'pressed' : 'released'}`);
  });

  socket.on('nav:axis', (evt) => {
    console.log(`${evt.axis}: ${evt.value}`);
  });
</script>
```

## Client Example (Node.js)

```js
const { io } = require('socket.io-client');
const socket = io('http://<PI_IP>:3050');

socket.on('nav:button', (evt) => {
  console.log(evt);
});

socket.on('nav:axis', (evt) => {
  console.log(evt);
});
```

## Finding Your Device Path

```bash
# List input devices
ls /dev/input/event*

# Identify the PS Navigation controller
sudo apt install evtest
sudo evtest
# Select the device and press buttons — you'll see the event codes

# Or check by name
cat /proc/bus/input/devices
```

## Custom Button Mapping

If your controller uses different event codes, edit `src/button-map.ts`. Use `evtest` to discover the actual codes for your device.

## Mock Mode

For development without the actual controller:

```bash
MOCK_INPUT=1 npx ts-node src/server.ts
```

This generates synthetic stick movement and random button presses.

## License

ISC
