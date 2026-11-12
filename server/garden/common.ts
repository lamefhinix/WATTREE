import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { TRPCError } from "@trpc/server";
import {
  commands,
  devices,
  gardens,
  plants,
  readings,
  waterEvents,
  type CommandRow,
  type DeviceRow,
  type GardenRow,
  type PlantRow,
  type ReadingRow,
} from "../../drizzle/schema";
import type {
  LiveCommand,
  LiveDevice,
  LiveGardenState,
  LivePlant,
  LiveReading,
  LiveWaterEvent,
  Garden,
} from "../../shared/watree-live";
import { getDb } from "../db";

export type GardenDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type GardenTx = Parameters<Parameters<GardenDb["transaction"]>[0]>[0];

export const ONLINE_WINDOW_MS = 120_000;
export const COMMAND_TTL_MS = 5 * 60_000;
export const CLAIM_TTL_MS = 60_000;

export function nowDate(): Date {
  return new Date();
}

export function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

export function iso(value: Date | string | null | undefined): string {
  return (asDate(value) ?? new Date(0)).toISOString();
}

export function nullableIso(
  value: Date | string | null | undefined
): string | null {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeTokenEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function validateMeasurement(
  name: string,
  value: unknown,
  min: number,
  max: number
): number {
  if (!isFiniteNumber(value) || value < min || value > max) {
    throw new Error(
      `${name} must be a finite number between ${min} and ${max}`
    );
  }
  return value;
}

export async function requireDb(): Promise<GardenDb> {
  const db = await getDb();
  if (!db) throw new Error("Database is not available");
  return db;
}

export async function ownerGarden(
  db: GardenDb | GardenTx,
  userId: number,
  gardenId: number
): Promise<GardenRow> {
  const rows = await db
    .select()
    .from(gardens)
    .where(and(eq(gardens.id, gardenId), eq(gardens.userId, userId)))
    .limit(1);
  const garden = rows[0];
  if (!garden) throw new Error("Garden not found");
  return garden;
}

export async function ownerPlant(
  db: GardenDb | GardenTx,
  userId: number,
  gardenId: number,
  plantId: string
): Promise<PlantRow> {
  await ownerGarden(db, userId, gardenId);
  const rows = await db
    .select()
    .from(plants)
    .where(
      and(
        eq(plants.id, plantId),
        eq(plants.gardenId, gardenId),
        isNull(plants.archivedAt)
      )
    )
    .limit(1);
  const plant = rows[0];
  if (!plant) throw new Error("Plant not found");
  return plant;
}

export async function ownerDevice(
  db: GardenDb | GardenTx,
  userId: number,
  gardenId: number,
  deviceId: number
): Promise<DeviceRow> {
  await ownerGarden(db, userId, gardenId);
  const rows = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.gardenId, gardenId)))
    .limit(1);
  const device = rows[0];
  if (!device) throw new Error("Device not found");
  return device;
}

export function toGarden(row: GardenRow): Garden {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    timezone: row.timezone,
    notifications: Boolean(row.notifications),
    enabled: Boolean(row.enabled),
    createdAt: iso(row.createdAt),
  };
}

export function toLiveDevice(row: DeviceRow): LiveDevice {
  return {
    id: row.id,
    gardenId: row.gardenId,
    name: row.name,
    type: row.type,
    capacity: row.capacity,
    reservoir: row.reservoir,
    lastSeenAt: nullableIso(row.lastSeenAt),
    firmware: row.firmware,
    revoked: Boolean(row.revoked),
    createdAt: iso(row.createdAt),
  };
}

export function toLiveReading(row: ReadingRow): LiveReading {
  return {
    plantId: row.plantId,
    timestamp: iso(row.recordedAt),
    moisture: row.moisture,
    temperature: row.temperature,
    humidity: row.humidity,
    light: row.light,
  };
}

export function toLiveCommand(row: CommandRow): LiveCommand {
  const expired =
    (row.status === "queued" || row.status === "claimed") &&
    !isCommandActive(row);
  return {
    id: row.id,
    plantId: row.plantId,
    deviceId: row.deviceId,
    channel: row.channel,
    amount: row.amountMl,
    mode: row.mode,
    status: expired ? "expired" : row.status,
    createdAt: iso(row.createdAt),
    expiresAt: iso(
      row.status === "claimed"
        ? (row.claimExpiresAt ?? row.expiresAt)
        : row.expiresAt
    ),
    completedAt: nullableIso(row.completedAt),
    error: expired
      ? row.status === "claimed"
        ? "delivery unknown"
        : "Command expired before claim"
      : row.error,
  };
}

export function toLiveEvent(
  row: typeof waterEvents.$inferSelect
): LiveWaterEvent {
  return {
    id: row.id,
    plantId: row.plantId,
    amount: row.amountMl,
    timestamp: iso(row.timestamp),
    mode: row.mode,
    status: row.status,
  };
}

export function toLivePlant(
  row: PlantRow,
  latest: ReadingRow | undefined,
  lastWatered: typeof waterEvents.$inferSelect | undefined
): LivePlant {
  return {
    id: row.id,
    gardenId: row.gardenId,
    name: row.name,
    species: row.species,
    location: row.location,
    image: row.image,
    deviceId: row.deviceId,
    channel: row.channel,
    autoWater: Boolean(row.autoWater),
    threshold: row.threshold,
    dose: row.dose,
    moisture: latest?.moisture ?? null,
    temperature: latest?.temperature ?? null,
    humidity: latest?.humidity ?? null,
    light: latest?.light ?? null,
    battery: latest?.battery ?? null,
    lastReadingAt: nullableIso(latest?.recordedAt),
    lastWatered: nullableIso(lastWatered?.timestamp),
    addedAt: iso(row.addedAt),
  };
}

export async function gardenState(
  db: GardenDb,
  userId: number,
  gardenId: number
): Promise<LiveGardenState> {
  const garden = await ownerGarden(db, userId, gardenId);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [plantRows, deviceRows, readingRows, eventRows, commandRows] =
    await Promise.all([
      db
        .select()
        .from(plants)
        .where(and(eq(plants.gardenId, gardenId), isNull(plants.archivedAt))),
      db.select().from(devices).where(eq(devices.gardenId, gardenId)),
      db
        .select()
        .from(readings)
        .where(
          and(eq(readings.gardenId, gardenId), gte(readings.recordedAt, since))
        )
        .orderBy(desc(readings.recordedAt))
        .limit(5000),
      db
        .select()
        .from(waterEvents)
        .where(
          and(
            eq(waterEvents.gardenId, gardenId),
            gte(waterEvents.timestamp, since)
          )
        )
        .orderBy(desc(waterEvents.timestamp))
        .limit(5000),
      db
        .select()
        .from(commands)
        .where(
          and(eq(commands.gardenId, gardenId), gte(commands.createdAt, since))
        )
        .orderBy(desc(commands.createdAt))
        .limit(5000),
    ]);
  const latestByPlant = new Map<string, ReadingRow>();
  for (const reading of readingRows)
    if (!latestByPlant.has(reading.plantId))
      latestByPlant.set(reading.plantId, reading);
  const lastWateredByPlant = new Map<string, (typeof eventRows)[number]>();
  for (const event of eventRows)
    if (!lastWateredByPlant.has(event.plantId))
      lastWateredByPlant.set(event.plantId, event);
  return {
    garden: toGarden(garden),
    plants: plantRows.map(row =>
      toLivePlant(
        row,
        latestByPlant.get(row.id),
        lastWateredByPlant.get(row.id)
      )
    ),
    devices: deviceRows.map(toLiveDevice),
    events: eventRows.map(toLiveEvent),
    readings: readingRows.map(toLiveReading),
    commands: commandRows.map(toLiveCommand),
  };
}

export type EnqueueInput = {
  gardenId: number;
  plantId: string;
  deviceId: number;
  channel: string;
  amountMl: number;
  mode: "automatic" | "manual";
  moisture?: number;
};

/**
 * Must be called inside a transaction. Garden, plant, and device rows are locked
 * before checking active commands, cooldown, and reservoir reservations. Claimed
 * commands are never reissued after their claim lease expires: an acknowledgement
 * that arrives after the lease is rejected as stale, because retrying could run a
 * pump twice when the original delivery actually happened.
 */
export async function enqueueCommandTx(
  tx: GardenTx,
  input: EnqueueInput
): Promise<CommandRow> {
  await tx.execute(
    sql`SELECT id FROM devices WHERE id = ${input.deviceId} AND gardenId = ${input.gardenId} FOR UPDATE`
  );
  await tx.execute(
    sql`SELECT id FROM gardens WHERE id = ${input.gardenId} FOR UPDATE`
  );
  await tx.execute(
    sql`SELECT id FROM plants WHERE id = ${input.plantId} AND gardenId = ${input.gardenId} FOR UPDATE`
  );
  const now = nowDate();
  await tx
    .update(commands)
    .set({ status: "expired", error: "Command expired before claim" })
    .where(
      and(
        eq(commands.deviceId, input.deviceId),
        eq(commands.status, "queued"),
        lte(commands.expiresAt, now)
      )
    );
  await tx
    .update(commands)
    .set({ status: "expired", error: "delivery unknown" })
    .where(
      and(
        eq(commands.deviceId, input.deviceId),
        eq(commands.status, "claimed"),
        or(isNull(commands.claimExpiresAt), lte(commands.claimExpiresAt, now))
      )
    );
  const garden = (
    await tx
      .select()
      .from(gardens)
      .where(eq(gardens.id, input.gardenId))
      .limit(1)
  )[0];
  const plant = (
    await tx
      .select()
      .from(plants)
      .where(
        and(
          eq(plants.id, input.plantId),
          eq(plants.gardenId, input.gardenId),
          isNull(plants.archivedAt)
        )
      )
      .limit(1)
  )[0];
  const device = (
    await tx
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.id, input.deviceId),
          eq(devices.gardenId, input.gardenId)
        )
      )
      .limit(1)
  )[0];
  if (!garden || !plant || !device)
    throw new Error("Garden, plant, or device not found");
  if (!garden.enabled) throw new Error("Garden is disabled");
  if (device.revoked) throw new Error("Device is revoked");
  if (plant.deviceId !== device.id || plant.channel !== input.channel)
    throw new Error("Plant is not assigned to this device channel");
  if (input.mode === "automatic") {
    if (!plant.autoWater)
      throw new Error("Automatic watering is disabled for this plant");
    if (input.moisture === undefined || input.moisture >= plant.threshold)
      throw new Error("Moisture is not below the plant threshold");
    if (
      !device.lastSeenAt ||
      Date.now() - asDate(device.lastSeenAt)!.getTime() > ONLINE_WINDOW_MS
    )
      throw new Error("Device is offline");
  }
  const active = await tx
    .select()
    .from(commands)
    .where(
      and(
        eq(commands.deviceId, input.deviceId),
        inArray(commands.status, ["queued", "claimed"])
      )
    );
  if (active.some(command => command.plantId === input.plantId))
    throw new Error("A command is already pending for this plant and device");
  const last = (
    await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.plantId, input.plantId),
          eq(commands.deviceId, input.deviceId)
        )
      )
      .orderBy(desc(commands.createdAt))
      .limit(1)
  )[0];
  const cooldown = input.mode === "automatic" ? 12 * 60 * 60 * 1000 : 60_000;
  if (
    last?.createdAt &&
    Date.now() - asDate(last.createdAt)!.getTime() < cooldown
  )
    throw new Error("Watering cooldown is active");
  if (!device.reservoir || device.reservoir < input.amountMl)
    throw new Error("Reported reservoir is insufficient");
  const reserved = active.reduce((sum, command) => sum + command.amountMl, 0);
  if (device.reservoir - reserved < input.amountMl)
    throw new Error("Reservoir reservation is insufficient");
  const createdAt = nowDate();
  const row: typeof commands.$inferInsert = {
    id: randomUUID(),
    gardenId: input.gardenId,
    plantId: input.plantId,
    deviceId: input.deviceId,
    channel: input.channel,
    amountMl: input.amountMl,
    mode: input.mode,
    status: "queued",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + COMMAND_TTL_MS),
  };
  await tx.insert(commands).values(row);
  return (
    await tx.select().from(commands).where(eq(commands.id, row.id)).limit(1)
  )[0]!;
}

export async function authenticateDevice(
  db: GardenDb,
  token: string
): Promise<DeviceRow | null> {
  if (!token || token.length < 32 || token.length > 256) return null;
  const hash = tokenHash(token);
  const device = (
    await db.select().from(devices).where(eq(devices.tokenHash, hash)).limit(1)
  )[0];
  if (!device || device.revoked || !safeTokenEquals(device.tokenHash, hash))
    return null;
  return device;
}

export function isCommandActive(
  command: Pick<CommandRow, "status" | "expiresAt" | "claimExpiresAt">,
  now = Date.now()
): boolean {
  if (command.status === "queued")
    return (asDate(command.expiresAt)?.getTime() ?? 0) > now;
  if (command.status === "claimed")
    return (asDate(command.claimExpiresAt)?.getTime() ?? 0) > now;
  return false;
}

export function parseDeviceToken(value: string | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("Bearer ")) return value.slice(7).trim() || null;
  return value.trim() || null;
}

export function trpcValidationError(message: string): TRPCError {
  return { name: "TRPCError", message, code: "BAD_REQUEST" } as TRPCError;
}
