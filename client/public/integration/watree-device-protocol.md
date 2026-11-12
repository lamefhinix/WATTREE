# Watree device protocol

This guide describes the outbound HTTP contract for a Watree watering device. It is documentation and an example integration only: hardware, controller, sensor, pump, calibration, power, and electrical safety are intentionally unspecified. The Python example uses an explicit adapter hook; it is **not** plug-and-play GPIO code.

## Before connecting hardware

Complete this owner-controlled setup in Watree:

1. Log in to the real, published Watree site.
2. Create a garden.
3. Add a plant.
4. Register a device in that garden. The registration response shows a device token **once**.
5. Map the plant to that device and an exact channel name.
6. Configure the plant's watering settings and, where applicable, enable/disable garden and automatic-watering rules.
7. Configure the physical controller with the published, durable HTTPS URL and the token.

A device registration or plant/channel mapping does not mean that the controller is connected. The device is considered online only after the server receives a recent heartbeat or telemetry request. A durable, externally reachable HTTPS deployment is required for unattended hardware. A Preview URL may be temporary or protected by a private access gate, so it is not a dependable hardware endpoint and may be unreachable from the device.

The device makes outbound HTTPS requests; no inbound port forwarding is required.

## Authentication and request rules

Every device request uses the raw, one-time-issued device token as a bearer credential:

```http
Authorization: Bearer <device-token>
Content-Type: application/json
```

The server stores a hash of the token. Store the raw token in protected device configuration (for example, an environment variable or a secret store), never in source control, browser storage, telemetry, or logs. Do not print it while debugging. If it is exposed, rotate it immediately and update the device. Rotation invalidates the old token; revocation prevents authentication and does not delete the plant or its mapping.

The base URL must be the published Watree HTTPS origin, without a trailing path. The endpoint paths below are absolute paths under that origin. Authentication failures are returned as an error object; ordinary validation failures are also JSON errors, for example:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Valid device token is required"
  }
}
```

## API endpoints

| Purpose                                   | Method | Path                            |
| ----------------------------------------- | ------ | ------------------------------- |
| Update liveness and optional device state | `POST` | `/api/device/heartbeat`         |
| Submit measured sensor readings           | `POST` | `/api/device/telemetry`         |
| Atomically claim one queued command       | `GET`  | `/api/device/commands`          |
| Report one claimed command                | `POST` | `/api/device/commands/{id}/ack` |

### Heartbeat

Send a heartbeat regularly, typically every 30–60 seconds. The body may be empty, or may contain either or both of these fields:

```json
{ "reservoirMl": 800, "firmware": "controller-1.0.0" }
```

`reservoirMl` must be a non-negative integer no greater than `2000000000` **and no greater than the device capacity registered by the owner**. `firmware` must be a string of at most 160 characters. The backend does not use `deviceId`, `channels`, or pump-state fields in this endpoint; do not rely on those fields as part of this contract.

Successful response:

```json
{ "success": true }
```

Example (the values are illustrative; measure the reservoir on the real device):

```sh
curl --fail-with-body -X POST "https://published-watree.example/api/device/heartbeat" \
  -H "Authorization: Bearer ${WATREE_DEVICE_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"reservoirMl":800,"firmware":"controller-1.0.0"}'
```

A heartbeat updates server liveness. It does not run a pump, create a command, or prove that the pump is calibrated.

### Telemetry

Telemetry is for measured sensor data and optional device state. It is separate from watering: posting telemetry never directly runs a pump. The body must contain 1–32 readings, with no duplicate channel names:

```json
{
  "readings": [
    {
      "channel": "plant_1",
      "moisture": 42.5,
      "temperature": 24.1,
      "humidity": 61.5,
      "light": 780,
      "battery": 87
    }
  ],
  "reservoirMl": 800,
  "firmware": "controller-1.0.0"
}
```

Validation ranges are:

- `channel`: 1–32 characters matching `[A-Za-z0-9_-]`; it must be assigned to this device and an active plant.
- `moisture`: required finite number from 0 through 100.
- `temperature`: optional finite number from -80 through 100.
- `humidity`: optional finite number from 0 through 100.
- `light`: optional finite number from 0 through 2,000,000,000.
- `battery`: optional finite number from 0 through 100.
- `reservoirMl` and `firmware`: the same constraints as heartbeat, including the registered device-capacity limit for `reservoirMl`.

The API records the server receipt time; there is no client `timestamp` or `plantId` field in this contract. The bridge must not invent readings or timestamps. It must discard stale, missing, disconnected, or unsafe sensor samples locally instead of sending them as current readings. A delayed request is received when it arrives, so an adapter should use a fresh-sample policy before POSTing.

Successful response:

```json
{ "success": true, "accepted": 1 }
```

`accepted` is the number of readings inserted. Automatic watering rules may enqueue a command while telemetry is processed, but only when the applicable server-side rules allow it. Telemetry itself is not a watering instruction.

Example calibrated reading (example only; replace with a real adapter measurement):

```sh
curl --fail-with-body -X POST "https://published-watree.example/api/device/telemetry" \
  -H "Authorization: Bearer ${WATREE_DEVICE_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"readings":[{"channel":"plant_1","moisture":42.5,"temperature":24.1,"humidity":61.5,"light":780,"battery":87}],"reservoirMl":800,"firmware":"controller-1.0.0"}'
```

### Claiming commands

`GET /api/device/commands` returns zero or one command:

```json
{
  "commands": [
    {
      "id": "command-uuid",
      "channel": "plant_1",
      "amountMl": 250,
      "mode": "manual",
      "expiresAt": "2026-11-12T08:05:00.000Z"
    }
  ]
}
```

An empty queue is `{"commands":[]}`. The server transaction locks the device and atomically changes the oldest eligible queued command to `claimed`, so two polls cannot claim the same queued command. Claiming creates an execution lease; it is not a harmless read and must not be treated as a repeatable command preview. A command is queued for five minutes, and the returned `expiresAt` is the **60-second claim expiry**. It is not permission to ignore local safety checks. A claim that expires is marked delivery-unknown and is not reissued.

The device must validate the command again before any physical action:

- `id` is the durable command identifier; journal it locally before activating a pump.
- `amountMl` must be an integer within the controller's configured safe range and never greater than 500 ml. The Watree owner UI creates doses from 10–500 ml.
- `channel` must be a known, mapped channel on this controller.
- Do not execute if `expiresAt` has passed, the reservoir interlock is open, calibration is invalid, or any local safety check fails.
- Use a local physical timeout and pump-off default. The adapter must implement that timeout in the controller/driver; a Python worker-thread timeout is not a reliable substitute.

Example claim request (warning: this may claim a command and start a 60-second lease; do not run it as a polling test against a live garden):

```sh
curl --fail-with-body "https://published-watree.example/api/device/commands" \
  -H "Authorization: Bearer ${WATREE_DEVICE_TOKEN}"
```

The command is not executed by Watree. The controller performs the calibrated delivery, measures or determines the actual delivered amount, then acknowledges.

### Acknowledgement

Acknowledge only a command that this device has actually inspected and, if safe, attempted. The request body is:

```json
{ "status": "completed", "deliveredMl": 250 }
```

For a failed or partial delivery:

```json
{
  "status": "failed",
  "deliveredMl": 120,
  "error": "local timeout before requested dose"
}
```

`status` must be `completed` or `failed`. `deliveredMl` must be a non-negative integer no greater than the requested amount. `error` is optional and limited to 500 characters. A partial or failed delivery must report the actual delivered amount; do not report zero unless zero is actually known. Use `completed` only when the requested amount was delivered. A `failed` acknowledgement with a positive delivered amount still records that delivered water.

Successful response:

```json
{
  "success": true,
  "replay": false,
  "status": "completed",
  "deliveredMl": 250,
  "error": null
}
```

The response includes the acknowledged `status`, `deliveredMl`, and `error` (usually `null` when no error was supplied). A repeated acknowledgement for an already terminal command is idempotent and returns `replay:true` with the stored terminal result. Acknowledgement after the 60-second claim lease is rejected as stale and the command is not reissued, because automatic reissue could water twice when the original delivery succeeded but its response was lost. If a reboot or communication loss leaves the local journal in an ambiguous `started` state, do **not** rerun the pump and do **not** fabricate `deliveredMl: 0`; inspect the hardware and reconcile manually before acknowledging.

After a successful acknowledgement—especially when `deliveredMl` is positive—read the reservoir again from the real level sensor and publish that fresh measured value in a heartbeat or telemetry request before starting another device cycle. Do not derive the next reservoir value by subtracting `deliveredMl`, and do not send a guessed value. If the controller cannot measure the updated level, stop before another command poll until an owner/operator reconciles the reservoir.

## Server safety and connection rules

Watree applies server-side rules in addition to the controller's physical safety layer:

- A garden can be disabled by the owner; disabling it cancels queued commands and prevents automatic enqueue.
- Disabling a garden or revoking a device marks its already-claimed commands as expired with `delivery unknown`, never as safely canceled or delivered. A cloud setting cannot physically stop a pump that is already running; the controller's local hard stop remains mandatory. Unknown claims are never reissued.
- Automatic watering requires the plant's automatic-watering setting, moisture below its threshold, a current device connection, a matching plant/device/channel assignment, and sufficient reported reservoir. Automatic watering has a 12-hour cooldown.
- Manual watering requires a current connection and uses a 60-second cooldown. An active queued or claimed command for the plant/device blocks another one.
- The server requires a reported reservoir sufficient for the requested amount and reserves against active commands.
- After any positive delivery acknowledgement, the server invalidates its stored reservoir value. The controller must refresh it with a fresh measured reservoir before another watering cycle; the bridge must not estimate the level from an acknowledgement.
- Watering amounts are integer millilitres and are capped at 500 ml by owner configuration/API validation.
- A device is online when `lastSeenAt` is no more than 120 seconds old. Older devices are stale/offline; a mapping or registration alone is never a connected status.
- Stale telemetry should be ignored by the bridge rather than sent as fresh data. The API records receipt time and cannot make an old client sample current again.

These rules do not replace local hard stops, current sensing, dry-run protection, reservoir level interlocks, pump-off defaults, or safe handling of an unknown delivery.

## Token and operational checklist

Keep the token in a secret environment variable; never log request headers or full exception payloads. Rotate after exposure and revoke a decommissioned device. Use a durable HTTPS deployment, not a temporary/private Preview gate. Keep command IDs in a durable local journal before the pump starts. On reboot, an entry marked `started` is an ambiguous execution and must not be repeated automatically. Retry an acknowledgement finitely if its result is known; never retry the physical pump solely because an acknowledgement response was lost. After an ack, publish a fresh measured reservoir; if no level sensor is available, do not estimate it and do not begin another watering cycle.

The included [`watree_bridge.py`](watree_bridge.py) is a finite, standard-library example. By default it sends no command poll and never actuates hardware. `--poll` requires `--allow-watering`, an explicit controller adapter, and a fresh measured `reservoirMl`; after every successful ack it reads and sends fresh telemetry with `reservoirMl` before ending the cycle. If the adapter cannot provide that measurement, the example sends no estimate and reports the condition. Hardware details are needed before a safe adapter can be written.
