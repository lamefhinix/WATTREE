import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, isNull, lt } from "drizzle-orm";
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { commands, devices, gardens, plants, readings, waterEvents } from "../../drizzle/schema";
import { getDb } from "../db";
import { authenticateDevice, enqueueCommandTx, requireDb, tokenHash, validateMeasurement, type GardenDb } from "./common";

const MAX_TELEMETRY_READINGS = 32;
const MAX_ERROR_LENGTH = 500;
const CHANNEL_RE = /^[A-Za-z0-9_-]{1,32}$/;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length > max) throw new Error(`${label} must be a string of at most ${max} characters`);
  return value.trim();
}

function optionalReservoir(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 2_000_000_000) throw new Error("reservoirMl must be a non-negative integer");
  return value as number;
}

async function auth(req: Request): Promise<Awaited<ReturnType<typeof authenticateDevice>>> {
  const header = req.header("authorization");
  const explicit = req.header("x-device-token");
  const token = explicit ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
  if (!token) return null;
  return authenticateDevice(await requireDb(), token);
}

async function withDevice(req: Request, res: Response, work: (db: GardenDb, device: NonNullable<Awaited<ReturnType<typeof authenticateDevice>>>) => Promise<void>): Promise<void> {
  try {
    const db = await requireDb();
    const device = await auth(req);
    if (!device) {
      sendError(res, 401, "UNAUTHORIZED", "Valid device token is required");
      return;
    }
    await work(db, device);
  } catch (error) {
    console.error("[Device API] request failed", error instanceof Error ? error.message : error);
    if (!res.headersSent) sendError(res, 400, "BAD_REQUEST", error instanceof Error ? error.message : "Invalid device request");
  }
}

export function registerDeviceRoutes(app: Express): void {
  app.post("/api/device/heartbeat", (req, res) => {
    void withDevice(req, res, async (db, device) => {
      const body = bodyRecord(req.body);
      const reservoirMl = optionalReservoir(body.reservoirMl);
      if (reservoirMl !== undefined && reservoirMl > device.capacity) throw new Error("reservoirMl cannot exceed device capacity");
      const firmware = optionalString(body.firmware, "firmware", 160);
      const patch: Partial<typeof devices.$inferInsert> = { lastSeenAt: new Date() };
      if (reservoirMl !== undefined) patch.reservoir = reservoirMl;
      if (firmware !== undefined) patch.firmware = firmware;
      await db.update(devices).set(patch).where(eq(devices.id, device.id));
      res.json({ success: true });
    });
  });

  app.post("/api/device/telemetry", (req, res) => {
    void withDevice(req, res, async (db, device) => {
      const body = bodyRecord(req.body);
      if (!Array.isArray(body.readings) || body.readings.length < 1 || body.readings.length > MAX_TELEMETRY_READINGS) throw new Error(`readings must contain 1-${MAX_TELEMETRY_READINGS} items`);
      const reservoirMl = optionalReservoir(body.reservoirMl);
      const firmware = optionalString(body.firmware, "firmware", 160);
      const receivedAt = new Date();
      const parsed = (body.readings as unknown[]).map((raw, index) => {
        const item = bodyRecord(raw);
        if (typeof item.channel !== "string" || !CHANNEL_RE.test(item.channel.trim())) throw new Error(`readings[${index}].channel must match [A-Za-z0-9_-]{1,32}`);
        const channel = item.channel.trim();
        const moisture = validateMeasurement(`readings[${index}].moisture`, item.moisture, 0, 100);
        const temperature = item.temperature === undefined ? undefined : validateMeasurement(`readings[${index}].temperature`, item.temperature, -80, 100);
        const humidity = item.humidity === undefined ? undefined : validateMeasurement(`readings[${index}].humidity`, item.humidity, 0, 100);
        const light = item.light === undefined ? undefined : validateMeasurement(`readings[${index}].light`, item.light, 0, 2_000_000_000);
        const battery = item.battery === undefined ? undefined : validateMeasurement(`readings[${index}].battery`, item.battery, 0, 100);
        return { channel, moisture, temperature, humidity, light, battery };
      });
      const channels = new Set<string>();
      for (const item of parsed) {
        if (channels.has(item.channel)) throw new Error(`Duplicate telemetry channel: ${item.channel}`);
        channels.add(item.channel);
      }
      const accepted = await db.transaction(async tx => {
        await tx.execute(sql`SELECT id FROM devices WHERE id = ${device.id} FOR UPDATE`);
        const current = (await tx.select().from(devices).where(eq(devices.id, device.id)).limit(1))[0];
        if (!current || current.revoked) throw new Error("Device is revoked or unavailable");
        if (reservoirMl !== undefined && reservoirMl > current.capacity) throw new Error("reservoirMl cannot exceed device capacity");
        const garden = (await tx.select().from(gardens).where(eq(gardens.id, current.gardenId)).limit(1))[0];
        if (!garden) throw new Error("Garden not found");
        await tx.update(devices).set({ lastSeenAt: receivedAt, ...(reservoirMl === undefined ? {} : { reservoir: reservoirMl }), ...(firmware === undefined ? {} : { firmware }) }).where(eq(devices.id, device.id));
        let count = 0;
        for (const item of parsed) {
          const plant = (await tx.select().from(plants).where(and(eq(plants.gardenId, current.gardenId), eq(plants.deviceId, current.id), eq(plants.channel, item.channel), isNull(plants.archivedAt))).limit(1))[0];
          if (!plant) throw new Error(`Telemetry channel is not assigned: ${item.channel}`);
          await tx.insert(readings).values({ gardenId: current.gardenId, plantId: plant.id, deviceId: current.id, channel: item.channel, moisture: item.moisture, temperature: item.temperature, humidity: item.humidity, light: item.light, battery: item.battery, recordedAt: receivedAt });
          count += 1;
          if (garden.enabled && plant.autoWater && item.moisture < plant.threshold && plant.deviceId !== null && plant.channel !== null) {
            try {
              await enqueueCommandTx(tx, { gardenId: current.gardenId, plantId: plant.id, deviceId: current.id, channel: plant.channel, amountMl: plant.dose, mode: "automatic", moisture: item.moisture });
            } catch (error) {
              // Safety gates intentionally make auto-enqueue a no-op when cooldown,
              // duplicate, reservoir, or assignment checks reject the reading.
              if (!(error instanceof Error && /cooldown|pending|insufficient|offline|threshold|disabled/i.test(error.message))) throw error;
            }
          }
        }
        return count;
      });
      res.json({ success: true, accepted });
    });
  });

  app.get("/api/device/commands", (req, res) => {
    void withDevice(req, res, async (db, device) => {
      const now = new Date();
      const result = await db.transaction(async tx => {
        await tx.execute(sql`SELECT id FROM devices WHERE id = ${device.id} FOR UPDATE`);
        const currentDevice = (await tx.select().from(devices).where(eq(devices.id, device.id)).limit(1))[0];
        if (!currentDevice || currentDevice.revoked) throw new Error("Device is revoked");
        const garden = (await tx.select().from(gardens).where(eq(gardens.id, currentDevice.gardenId)).limit(1))[0];
        if (!garden || !garden.enabled) throw new Error("Garden is disabled");
        // Polling is an authenticated liveness signal; it also prevents a
        // healthy controller from appearing stale when it has no telemetry.
        await tx.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, device.id));
        await tx.update(commands).set({ status: "expired", error: "delivery unknown" }).where(and(eq(commands.deviceId, device.id), eq(commands.status, "claimed"), lt(commands.claimExpiresAt, now)));
        await tx.update(commands).set({ status: "expired", error: "Command expired before claim" }).where(and(eq(commands.deviceId, device.id), eq(commands.status, "queued"), lt(commands.expiresAt, now)));
        let command = (await tx.select().from(commands).where(and(eq(commands.deviceId, device.id), eq(commands.status, "queued"), gte(commands.expiresAt, now))).orderBy(asc(commands.createdAt)).limit(1))[0];
        if (!command) return null;
        const assignedPlant = (await tx.select().from(plants).where(and(eq(plants.id, command.plantId), eq(plants.gardenId, currentDevice.gardenId), eq(plants.deviceId, device.id), eq(plants.channel, command.channel), isNull(plants.archivedAt))).limit(1))[0];
        if (!assignedPlant) {
          await tx.update(commands).set({ status: "canceled", error: "Plant device assignment changed" }).where(and(eq(commands.id, command.id), eq(commands.status, "queued")));
          command = (await tx.select().from(commands).where(and(eq(commands.deviceId, device.id), eq(commands.status, "queued"), gte(commands.expiresAt, now))).orderBy(asc(commands.createdAt)).limit(1))[0];
          if (!command) return null;
        }
        const claimExpiresAt = new Date(now.getTime() + 60_000);
        await tx.update(commands).set({ status: "claimed", claimedAt: now, claimExpiresAt }).where(and(eq(commands.id, command.id), eq(commands.status, "queued")));
        return { id: command.id, channel: command.channel, amountMl: command.amountMl, mode: command.mode, expiresAt: claimExpiresAt };
      });
      res.json({ commands: result ? [result] : [] });
    });
  });

  app.post("/api/device/commands/:id/ack", (req, res) => {
    void withDevice(req, res, async (db, device) => {
      const body = bodyRecord(req.body);
      if (body.status !== "completed" && body.status !== "failed") throw new Error("status must be completed or failed");
      const ackStatus: "completed" | "failed" = body.status;
      if (!Number.isInteger(body.deliveredMl) || (body.deliveredMl as number) < 0) throw new Error("deliveredMl must be a non-negative integer");
      const deliveredMl = body.deliveredMl as number;
      const errorText = body.error === undefined ? undefined : optionalString(body.error, "error", MAX_ERROR_LENGTH);
      const commandId = req.params.id;
      const result = await db.transaction(async tx => {
        await tx.execute(sql`SELECT id FROM commands WHERE id = ${commandId} AND deviceId = ${device.id} FOR UPDATE`);
        const command = (await tx.select().from(commands).where(and(eq(commands.id, commandId), eq(commands.deviceId, device.id))).limit(1))[0];
        if (!command) throw new Error("Command not found for this device");
        if (command.status === "completed" || command.status === "failed") return { replay: true, status: command.status, deliveredMl: command.deliveredMl ?? 0, error: command.error };
        if (command.status === "expired" && command.error === "delivery unknown") throw new Error("Command delivery is unknown; it will not be reissued");
        if (command.status !== "claimed") throw new Error("Command is not awaiting acknowledgement");
        if (!command.claimExpiresAt || command.claimExpiresAt.getTime() < Date.now()) {
          await tx.update(commands).set({ status: "expired", error: "delivery unknown" }).where(and(eq(commands.id, command.id), eq(commands.status, "claimed")));
          throw new Error("Command acknowledgement is stale; command will not be reissued");
        }
        if (deliveredMl > command.amountMl) throw new Error("deliveredMl cannot exceed the requested amount");
        const completedAt = new Date();
        await tx.update(commands).set({ status: ackStatus, completedAt, deliveredMl, error: errorText ?? null }).where(and(eq(commands.id, command.id), eq(commands.status, "claimed")));
        if (deliveredMl > 0) {
          await tx.insert(waterEvents).values({ id: randomUUID(), gardenId: command.gardenId, plantId: command.plantId, commandId: command.id, amountMl: deliveredMl, timestamp: completedAt, mode: command.mode, status: deliveredMl === command.amountMl ? "completed" : "partial" });
          // Do not subtract from the cached value: firmware may have reported a
          // post-watering measurement before this ack arrived. Require a fresh
          // heartbeat/telemetry reservoir reading instead of inventing a level.
          await tx.update(devices).set({ reservoir: null }).where(eq(devices.id, device.id));
        }
        return { replay: false, status: ackStatus, deliveredMl, error: errorText ?? null };
      });
      res.json({ success: true, ...result });
    });
  });
}
