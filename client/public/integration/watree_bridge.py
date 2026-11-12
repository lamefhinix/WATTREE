#!/usr/bin/env python3
"""Finite-cycle Watree device bridge example.

This is an integration skeleton, not controller-specific hardware code. It uses
only Python's standard library. By default one cycle sends a heartbeat and
nothing else; it never polls commands and never actuates a pump. Telemetry is
sent only when a real JSON payload or an explicit adapter supplies it.

An adapter module must provide:

    def read_telemetry() -> dict:
        # Return measured Watree telemetry, including ``readings``.

    def water(channel: str, amount_ml: int, max_runtime_seconds: float) -> int:
        # Perform one calibrated attempt and return actual delivered ml.

The adapter, controller, and pump driver must implement a local physical
cutoff. A Python thread timeout is not a reliable safety cutoff. Do not add
generic GPIO pin guesses here.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib
import json
import math
import os
import re
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

MAX_RESERVOIR_ML = 2_000_000_000
MAX_TELEMETRY_READINGS = 32
MAX_COMMAND_ML = 500
MAX_ERROR_LENGTH = 500
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_MAX_RUNTIME_SECONDS = 30.0
ACK_ATTEMPTS = 3
CHANNEL_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


class BridgeError(RuntimeError):
    """A safe, non-secret integration error."""


class AmbiguousExecution(BridgeError):
    """The journal says a command may already have activated hardware."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def require_config() -> tuple[str, str]:
    base_url = os.environ.get("WATREE_BASE_URL", "").strip().rstrip("/")
    token = os.environ.get("WATREE_DEVICE_TOKEN", "")
    if not base_url:
        raise BridgeError("WATREE_BASE_URL is required")
    if not base_url.lower().startswith("https://"):
        raise BridgeError("WATREE_BASE_URL must use HTTPS")
    if not token:
        raise BridgeError("WATREE_DEVICE_TOKEN is required")
    return base_url, token


def api_request(
    base_url: str,
    token: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> Any:
    """Make one authenticated request without ever putting the token in a URL."""
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = Request(f"{base_url}{path}", data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout_seconds) as response:  # nosec B310: URL is required to be HTTPS above
            raw = response.read()
    except HTTPError as exc:
        raise BridgeError(f"Watree {method} {path} failed with HTTP {exc.code}") from None
    except URLError as exc:
        raise BridgeError(f"Watree {method} {path} network failure: {exc.reason}") from None
    except TimeoutError:
        raise BridgeError(f"Watree {method} {path} timed out") from None
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BridgeError(f"Watree {method} {path} returned non-JSON data") from None


def require_finite_number(value: Any, label: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise BridgeError(f"{label} must be a finite number")
    number = float(value)
    if number < minimum or number > maximum:
        raise BridgeError(f"{label} must be between {minimum} and {maximum}")
    return value


def validate_telemetry(payload: Any) -> dict[str, Any]:
    """Validate a real adapter/file payload without manufacturing readings."""
    if not isinstance(payload, dict):
        raise BridgeError("telemetry payload must be a JSON object")
    readings = payload.get("readings")
    if not isinstance(readings, list) or not 1 <= len(readings) <= MAX_TELEMETRY_READINGS:
        raise BridgeError("telemetry readings must contain 1-32 items")
    seen: set[str] = set()
    for index, item in enumerate(readings):
        if not isinstance(item, dict):
            raise BridgeError(f"readings[{index}] must be an object")
        channel = item.get("channel")
        if not isinstance(channel, str) or not CHANNEL_RE.fullmatch(channel):
            raise BridgeError(
                f"readings[{index}].channel must match [A-Za-z0-9_-]{{1,32}}"
            )
        if channel in seen:
            raise BridgeError(f"duplicate telemetry channel: {channel}")
        seen.add(channel)
        require_finite_number(item.get("moisture"), f"readings[{index}].moisture", 0, 100)
        ranges = {
            "temperature": (-80, 100),
            "humidity": (0, 100),
            "light": (0, 2_000_000_000),
            "battery": (0, 100),
        }
        for name, (minimum, maximum) in ranges.items():
            if name in item and item[name] is not None:
                require_finite_number(item[name], f"readings[{index}].{name}", minimum, maximum)
    if "reservoirMl" in payload:
        reservoir = payload["reservoirMl"]
        if isinstance(reservoir, bool) or not isinstance(reservoir, int) or not 0 <= reservoir <= MAX_RESERVOIR_ML:
            raise BridgeError("reservoirMl must be a non-negative integer")
    if "firmware" in payload:
        firmware = payload["firmware"]
        if not isinstance(firmware, str) or len(firmware.strip()) > 160:
            raise BridgeError("firmware must be a string of at most 160 characters")
    return payload


def load_json_telemetry(path: str) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise BridgeError(f"cannot read telemetry file: {exc}") from None
    except json.JSONDecodeError as exc:
        raise BridgeError(f"telemetry file is not valid JSON: {exc}") from None
    return validate_telemetry(payload)


def load_adapter(module_name: str) -> tuple[Callable[[], Any], Callable[[str, int, float], Any] | None]:
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:  # adapters are user-owned; avoid exposing secrets in a traceback
        raise BridgeError(f"could not import adapter {module_name!r}: {exc}") from None
    read_telemetry = getattr(module, "read_telemetry", None)
    water = getattr(module, "water", None)
    if not callable(read_telemetry):
        raise BridgeError(f"adapter {module_name!r} must define read_telemetry()")
    if water is not None and not callable(water):
        raise BridgeError(f"adapter {module_name!r}.water must be callable")
    return read_telemetry, water


def open_journal(path: str) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS command_journal (
            id TEXT PRIMARY KEY,
            channel TEXT NOT NULL,
            amount_ml INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            state TEXT NOT NULL,
            started_at TEXT NOT NULL,
            delivered_ml INTEGER,
            ack_status TEXT,
            error TEXT,
            updated_at TEXT NOT NULL
        )
        """
    )
    connection.commit()
    return connection


def journal_pending_acknowledgements(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return list(
        connection.execute(
            "SELECT * FROM command_journal WHERE state = 'ack_pending' ORDER BY started_at"
        )
    )


def journal_start(
    connection: sqlite3.Connection,
    command_id: str,
    channel: str,
    amount_ml: int,
    expires_at: str,
) -> sqlite3.Row | None:
    """Commit a durable started marker before the adapter can turn on a pump."""
    try:
        connection.execute(
            """
            INSERT INTO command_journal
              (id, channel, amount_ml, expires_at, state, started_at, updated_at)
            VALUES (?, ?, ?, ?, 'started', ?, ?)
            """,
            (command_id, channel, amount_ml, expires_at, utc_now(), utc_now()),
        )
        connection.commit()
        return None
    except sqlite3.IntegrityError:
        row = connection.execute("SELECT * FROM command_journal WHERE id = ?", (command_id,)).fetchone()
        if row is None:
            raise BridgeError("command journal conflict")
        if row["state"] in {"started", "unknown"}:
            raise AmbiguousExecution(
                f"command {command_id} is already {row['state']} in the durable journal; inspect hardware and do not rerun"
            )
        return row


def journal_result(
    connection: sqlite3.Connection,
    command_id: str,
    delivered_ml: int,
    ack_status: str,
    error: str | None,
) -> None:
    connection.execute(
        """
        UPDATE command_journal
        SET state = 'ack_pending', delivered_ml = ?, ack_status = ?, error = ?, updated_at = ?
        WHERE id = ?
        """,
        (delivered_ml, ack_status, error, utc_now(), command_id),
    )
    connection.commit()


def journal_unknown(connection: sqlite3.Connection, command_id: str, error: str) -> None:
    connection.execute(
        "UPDATE command_journal SET state = 'unknown', error = ?, updated_at = ? WHERE id = ?",
        (error[:MAX_ERROR_LENGTH], utc_now(), command_id),
    )
    connection.commit()


def journal_acknowledged(connection: sqlite3.Connection, command_id: str) -> None:
    connection.execute(
        "UPDATE command_journal SET state = 'acknowledged', updated_at = ? WHERE id = ?",
        (utc_now(), command_id),
    )
    connection.commit()


def ack_with_finite_retries(
    base_url: str,
    token: str,
    connection: sqlite3.Connection,
    command_id: str,
    delivered_ml: int,
    status: str,
    error: str | None,
    timeout_seconds: float,
) -> None:
    body: dict[str, Any] = {"status": status, "deliveredMl": delivered_ml}
    if error:
        body["error"] = error[:MAX_ERROR_LENGTH]
    last_error: BridgeError | None = None
    for attempt in range(ACK_ATTEMPTS):
        try:
            result = api_request(
                base_url,
                token,
                "POST",
                f"/api/device/commands/{command_id}/ack",
                body,
                timeout_seconds,
            )
            if not isinstance(result, dict) or result.get("success") is not True:
                raise BridgeError("acknowledgement returned an unexpected response")
            journal_acknowledged(connection, command_id)
            print(f"acknowledged command {command_id} ({status}, deliveredMl={delivered_ml})")
            return
        except BridgeError as exc:
            last_error = exc
            if attempt + 1 < ACK_ATTEMPTS:
                time.sleep(0.5 * (attempt + 1))
    raise BridgeError(f"acknowledgement is pending for command {command_id}: {last_error}")


def retry_pending_acknowledgements(
    base_url: str,
    token: str,
    connection: sqlite3.Connection,
    read_telemetry: Callable[[], Any] | None,
    timeout_seconds: float,
) -> bool:
    safe_to_poll = True
    for row in journal_pending_acknowledgements(connection):
        print(f"retrying saved acknowledgement for command {row['id']}")
        try:
            ack_with_finite_retries(
                base_url,
                token,
                connection,
                row["id"],
                int(row["delivered_ml"]),
                row["ack_status"],
                row["error"],
                timeout_seconds,
            )
            refresh_after_ack(base_url, token, read_telemetry, timeout_seconds)
        except BridgeError as exc:
            safe_to_poll = False
            print(str(exc), file=sys.stderr)
    return safe_to_poll


def refresh_after_ack(
    base_url: str,
    token: str,
    read_telemetry: Callable[[], Any] | None,
    timeout_seconds: float,
) -> None:
    """Post a fresh measured level after ack; never estimate reservoir state."""
    if read_telemetry is None:
        raise BridgeError(
            "acknowledged command, but no adapter read_telemetry() is available for a fresh reservoir reading"
        )
    try:
        payload = validate_telemetry(read_telemetry())
    except BridgeError:
        raise
    except Exception as exc:
        raise BridgeError(f"acknowledged command, but fresh telemetry read failed: {exc}") from None
    if "reservoirMl" not in payload:
        raise BridgeError(
            "acknowledged command, but adapter supplied no measured reservoirMl; no reservoir estimate was sent"
        )
    send_telemetry(base_url, token, payload, timeout_seconds)
    print("fresh post-ack reservoir telemetry sent")


def parse_expiry(value: Any) -> dt.datetime:
    if not isinstance(value, str):
        raise BridgeError("command expiresAt must be an ISO-8601 string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError:
        raise BridgeError("command expiresAt is not valid ISO-8601") from None
    if parsed.tzinfo is None:
        raise BridgeError("command expiresAt must include a timezone")
    return parsed.astimezone(dt.timezone.utc)


def validate_command(command: Any) -> dict[str, Any]:
    if not isinstance(command, dict):
        raise BridgeError("command must be an object")
    command_id = command.get("id")
    channel = command.get("channel")
    amount = command.get("amountMl")
    if not isinstance(command_id, str) or not command_id:
        raise BridgeError("command id is required")
    if not isinstance(channel, str) or not CHANNEL_RE.fullmatch(channel):
        raise BridgeError("command channel must match [A-Za-z0-9_-]{1,32}")
    if isinstance(amount, bool) or not isinstance(amount, int) or not 1 <= amount <= MAX_COMMAND_ML:
        raise BridgeError("command amountMl must be an integer from 1 through 500")
    parse_expiry(command.get("expiresAt"))
    if command.get("mode") not in {"automatic", "manual"}:
        raise BridgeError("command mode must be automatic or manual")
    return command


def poll_and_execute(
    base_url: str,
    token: str,
    connection: sqlite3.Connection,
    water: Callable[[str, int, float], Any],
    read_telemetry: Callable[[], Any],
    max_runtime_seconds: float,
    timeout_seconds: float,
) -> None:
    response = api_request(base_url, token, "GET", "/api/device/commands", timeout_seconds=timeout_seconds)
    if not isinstance(response, dict) or not isinstance(response.get("commands"), list):
        raise BridgeError("command poll returned an unexpected response")
    commands = response["commands"]
    if not commands:
        print("command queue empty")
        return
    if len(commands) != 1:
        raise BridgeError("command poll returned more than one command")
    command = validate_command(commands[0])
    command_id = command["id"]
    amount = command["amountMl"]
    expiry = parse_expiry(command["expiresAt"])

    existing = journal_start(connection, command_id, command["channel"], amount, command["expiresAt"])
    if existing is not None:
        if existing["state"] == "ack_pending":
            ack_with_finite_retries(
                base_url,
                token,
                connection,
                command_id,
                int(existing["delivered_ml"]),
                existing["ack_status"],
                existing["error"],
                timeout_seconds,
            )
            refresh_after_ack(base_url, token, read_telemetry, timeout_seconds)
        else:
            print(f"command {command_id} already recorded as {existing['state']}; no pump retry")
        return

    if expiry <= dt.datetime.now(dt.timezone.utc):
        error = "command expired before local execution"
        journal_result(connection, command_id, 0, "failed", error)
        ack_with_finite_retries(base_url, token, connection, command_id, 0, "failed", error, timeout_seconds)
        refresh_after_ack(base_url, token, read_telemetry, timeout_seconds)
        return

    try:
        delivered = water(command["channel"], amount, max_runtime_seconds)
    except Exception as exc:  # hardware delivery is unknown; never fabricate deliveredMl=0
        message = f"adapter execution outcome is unknown: {exc}"
        journal_unknown(connection, command_id, message)
        raise AmbiguousExecution(
            f"{message}; command {command_id} was not acknowledged and must not be rerun automatically"
        ) from None

    if isinstance(delivered, bool) or not isinstance(delivered, int) or not 0 <= delivered <= amount:
        message = "adapter.water() must return actual delivered integer ml from 0 through amountMl"
        journal_unknown(connection, command_id, message)
        raise AmbiguousExecution(
            f"{message}; command {command_id} was not acknowledged and must not be rerun automatically"
        )
    status = "completed" if delivered == amount else "failed"
    error = None if status == "completed" else "partial or failed delivery reported by adapter"
    journal_result(connection, command_id, delivered, status, error)
    ack_with_finite_retries(base_url, token, connection, command_id, delivered, status, error, timeout_seconds)
    refresh_after_ack(base_url, token, read_telemetry, timeout_seconds)


def send_heartbeat(
    base_url: str,
    token: str,
    reservoir_ml: int | None,
    firmware: str | None,
    timeout_seconds: float,
) -> None:
    payload: dict[str, Any] = {}
    if reservoir_ml is not None:
        payload["reservoirMl"] = reservoir_ml
    if firmware:
        payload["firmware"] = firmware
    result = api_request(base_url, token, "POST", "/api/device/heartbeat", payload, timeout_seconds)
    if not isinstance(result, dict) or result.get("success") is not True:
        raise BridgeError("heartbeat returned an unexpected response")
    print("heartbeat sent")


def send_telemetry(base_url: str, token: str, payload: dict[str, Any], timeout_seconds: float) -> None:
    result = api_request(base_url, token, "POST", "/api/device/telemetry", payload, timeout_seconds)
    if not isinstance(result, dict) or result.get("success") is not True:
        raise BridgeError("telemetry returned an unexpected response")
    print(f"telemetry accepted: {result.get('accepted')}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run one finite Watree bridge cycle; no command polling or watering by default."
    )
    parser.add_argument(
        "--heartbeat-reservoir",
        type=int,
        metavar="ML",
        help="include this measured non-negative reservoir amount in the heartbeat",
    )
    parser.add_argument("--telemetry-json", metavar="PATH", help="send measured telemetry from this JSON file")
    parser.add_argument("--adapter", metavar="MODULE", help="import a controller adapter module")
    parser.add_argument(
        "--poll",
        action="store_true",
        help="claim at most one command and execute it through --adapter (requires --allow-watering)",
    )
    parser.add_argument(
        "--allow-watering",
        action="store_true",
        help="explicitly permit the --poll path to call adapter.water(); never implied by --adapter",
    )
    parser.add_argument(
        "--journal",
        default="watree-command-journal.sqlite3",
        metavar="PATH",
        help="durable local SQLite command journal (default: %(default)s)",
    )
    parser.add_argument(
        "--max-runtime-seconds",
        type=float,
        default=DEFAULT_MAX_RUNTIME_SECONDS,
        metavar="SECONDS",
        help="maximum runtime passed to adapter.water(); hardware must enforce it physically",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        metavar="SECONDS",
        help="HTTP request timeout (default: %(default)s)",
    )
    parser.add_argument(
        "--firmware",
        default=os.environ.get("WATREE_FIRMWARE", ""),
        help="optional firmware string for heartbeat (default: WATREE_FIRMWARE)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="explicitly prohibit polling/watering; still sends heartbeat and supplied real telemetry",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.heartbeat_reservoir is not None and not 0 <= args.heartbeat_reservoir <= MAX_RESERVOIR_ML:
        parser.error("--heartbeat-reservoir must be a non-negative integer")
    if args.timeout_seconds <= 0 or args.max_runtime_seconds <= 0:
        parser.error("timeouts must be positive")
    if args.telemetry_json and args.adapter:
        parser.error("use --telemetry-json or --adapter, not both")
    if args.poll and not args.allow_watering:
        parser.error("--poll requires explicit --allow-watering")
    if args.allow_watering and not args.poll:
        parser.error("--allow-watering is only valid with --poll")
    if args.poll and not args.adapter:
        parser.error("--poll requires an explicit --adapter module")
    if args.dry_run and (args.poll or args.allow_watering):
        parser.error("--dry-run cannot be combined with --poll or --allow-watering")

    try:
        base_url, token = require_config()
        adapter_read: Callable[[], Any] | None = None
        adapter_water: Callable[[str, int, float], Any] | None = None
        if args.adapter:
            adapter_read, adapter_water = load_adapter(args.adapter)
        if args.poll and adapter_water is None:
            raise BridgeError(f"adapter {args.adapter!r} must define water(channel, amount_ml, max_runtime_seconds)")

        send_heartbeat(base_url, token, args.heartbeat_reservoir, args.firmware or None, args.timeout_seconds)

        telemetry: dict[str, Any] | None = None
        if args.telemetry_json:
            telemetry = load_json_telemetry(args.telemetry_json)
        elif adapter_read is not None:
            try:
                telemetry = validate_telemetry(adapter_read())
            except BridgeError:
                raise
            except Exception as exc:
                raise BridgeError(f"adapter read_telemetry() failed: {exc}") from None
        if telemetry is not None:
            send_telemetry(base_url, token, telemetry, args.timeout_seconds)

        if not args.poll:
            return 0

        if telemetry is None or "reservoirMl" not in telemetry:
            raise BridgeError(
                "--poll requires adapter.read_telemetry() to provide a fresh measured reservoirMl; no value was fabricated"
            )

        with open_journal(args.journal) as connection:
            safe_to_poll = retry_pending_acknowledgements(
                base_url, token, connection, adapter_read, args.timeout_seconds
            )
            if not safe_to_poll:
                raise BridgeError("saved acknowledgement is not reconciled; refusing a new command poll")
            poll_and_execute(
                base_url,
                token,
                connection,
                adapter_water,  # checked above when --poll is selected
                adapter_read,  # checked above when --poll is selected
                args.max_runtime_seconds,
                args.timeout_seconds,
            )
        return 0
    except (BridgeError, OSError, sqlite3.Error) as exc:
        print(f"watree bridge: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
