import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  commands,
  devices,
  gardens,
  plants,
  users,
  waterEvents,
} from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import {
  asDate,
  enqueueCommandTx,
  gardenState,
  newDeviceToken,
  ownerDevice,
  ownerGarden,
  ownerPlant,
  requireDb,
  tokenHash,
  toGarden,
  toLiveCommand,
  toLiveDevice,
  toLivePlant,
} from "./common";

const id = z.number().int().positive();
const nonEmpty = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required`).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const optionalNonEmpty = (label: string, max: number) =>
  z.string().trim().min(1, `${label} cannot be empty`).max(max).optional();
const channel = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9_-]{1,32}$/,
    "Channel must contain only letters, numbers, _ or -"
  );
const optionalChannel = channel.optional();
const optionalTimezone = z
  .string()
  .trim()
  .max(64)
  .refine(value => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Invalid timezone")
  .optional();

function bad(
  message: string,
  code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" = "BAD_REQUEST"
): never {
  throw new TRPCError({ code, message });
}

function normalizeError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const message = error instanceof Error ? error.message : "Request failed";
  const cause =
    error instanceof Error
      ? (error.cause as { code?: string } | undefined)
      : undefined;
  if (cause?.code === "ER_DUP_ENTRY" || /duplicate entry/i.test(message))
    throw new TRPCError({
      code: "CONFLICT",
      message: "That device channel or record is already assigned.",
    });
  if (error && typeof error === "object" && "query" in error)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "The database request failed. Please retry.",
    });
  const code = /not found/i.test(message)
    ? "NOT_FOUND"
    : /already pending|cooldown|insufficient|offline|revoked|disabled/i.test(
          message
        )
      ? "CONFLICT"
      : "BAD_REQUEST";
  throw new TRPCError({ code, message });
}

async function withErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return normalizeError(error);
  }
}

export const gardenRouter = router({
  list: protectedProcedure.query(({ ctx }) =>
    withErrors(async () => {
      const db = await requireDb();
      const rows = await db
        .select()
        .from(gardens)
        .where(eq(gardens.userId, ctx.user.id))
        .orderBy(desc(gardens.createdAt));
      return rows.map(toGarden);
    })
  ),

  create: protectedProcedure
    .input(
      z.object({
        name: nonEmpty("Garden name", 160),
        location: optionalText(255),
      })
    )
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        const row: typeof gardens.$inferInsert = {
          userId: ctx.user.id,
          name: input.name,
          location: input.location ?? "",
        };
        await db.insert(gardens).values(row);
        const created = (
          await db
            .select()
            .from(gardens)
            .where(
              and(eq(gardens.userId, ctx.user.id), eq(gardens.name, input.name))
            )
            .orderBy(desc(gardens.id))
            .limit(1)
        )[0];
        if (!created) bad("Garden could not be created");
        return toGarden(created);
      })
    ),

  update: protectedProcedure
    .input(
      z.object({
        gardenId: id,
        name: optionalNonEmpty("Garden name", 160),
        location: optionalText(255),
        timezone: optionalTimezone,
        notifications: z.boolean().optional(),
        enabled: z.boolean().optional(),
      })
    )
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        await db.transaction(async tx => {
          await ownerGarden(tx, ctx.user.id, input.gardenId);
          await tx
            .select()
            .from(devices)
            .where(eq(devices.gardenId, input.gardenId))
            .orderBy(devices.id)
            .for("update");
          await tx.execute(
            sql`SELECT id FROM gardens WHERE id = ${input.gardenId} FOR UPDATE`
          );
          const patch: Partial<typeof gardens.$inferInsert> = {};
          if (input.name !== undefined) patch.name = input.name;
          if (input.location !== undefined) patch.location = input.location;
          if (input.timezone !== undefined) patch.timezone = input.timezone;
          if (input.notifications !== undefined)
            patch.notifications = input.notifications;
          if (input.enabled !== undefined) patch.enabled = input.enabled;
          if (!Object.keys(patch).length)
            bad("At least one garden setting is required");
          if (input.enabled === false) {
            await tx
              .update(commands)
              .set({ status: "canceled", error: "Garden disabled" })
              .where(
                and(
                  eq(commands.gardenId, input.gardenId),
                  eq(commands.status, "queued")
                )
              );
            const claimed = await tx
              .select()
              .from(commands)
              .where(
                and(
                  eq(commands.gardenId, input.gardenId),
                  eq(commands.status, "claimed")
                )
              );
            for (const command of claimed)
              await tx
                .update(devices)
                .set({ reservoir: null })
                .where(eq(devices.id, command.deviceId));
            await tx
              .update(commands)
              .set({ status: "expired", error: "delivery unknown" })
              .where(
                and(
                  eq(commands.gardenId, input.gardenId),
                  eq(commands.status, "claimed")
                )
              );
          }
          await tx
            .update(gardens)
            .set(patch)
            .where(
              and(
                eq(gardens.id, input.gardenId),
                eq(gardens.userId, ctx.user.id)
              )
            );
        });
        return { success: true } as const;
      })
    ),

  profile: protectedProcedure
    .input(
      z.object({ name: z.string().trim().min(1, "Name is required").max(255) })
    )
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        await db
          .update(users)
          .set({ name: input.name })
          .where(eq(users.id, ctx.user.id));
        return { success: true } as const;
      })
    ),

  state: protectedProcedure
    .input(z.object({ gardenId: id }))
    .query(({ ctx, input }) =>
      withErrors(async () =>
        gardenState(await requireDb(), ctx.user.id, input.gardenId)
      )
    ),

  addPlant: protectedProcedure
    .input(
      z.object({
        gardenId: id,
        name: nonEmpty("Plant name", 160),
        species: nonEmpty("Species", 160),
        location: optionalText(255),
        deviceId: id.nullable().optional(),
        channel: optionalChannel,
      })
    )
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        return db.transaction(async tx => {
          const createdId = randomUUID();
          const deviceId = input.deviceId ?? null;
          const assignedChannel = input.channel ?? null;
          await ownerGarden(tx, ctx.user.id, input.gardenId);
          if (deviceId !== null) {
            await tx.execute(
              sql`SELECT id FROM devices WHERE id = ${deviceId} AND gardenId = ${input.gardenId} FOR UPDATE`
            );
            const device = await ownerDevice(
              tx,
              ctx.user.id,
              input.gardenId,
              deviceId
            );
            if (device.revoked) bad("Device is revoked", "CONFLICT");
            if (!assignedChannel)
              bad("Channel is required when assigning a device");
            const assigned = await tx
              .select()
              .from(plants)
              .where(
                and(
                  eq(plants.gardenId, input.gardenId),
                  eq(plants.deviceId, deviceId),
                  eq(plants.channel, assignedChannel),
                  isNull(plants.archivedAt)
                )
              )
              .limit(1);
            if (assigned.length)
              bad("That device channel is already assigned", "CONFLICT");
          } else if (assignedChannel)
            bad("Device is required when assigning a channel");
          await tx
            .insert(plants)
            .values({
              id: createdId,
              gardenId: input.gardenId,
              name: input.name,
              species: input.species,
              location: input.location ?? "",
              image: "",
              deviceId,
              channel: assignedChannel,
            });
          const row = (
            await tx
              .select()
              .from(plants)
              .where(eq(plants.id, createdId))
              .limit(1)
          )[0];
          if (!row) bad("Plant could not be created");
          return toLivePlant(row, undefined, undefined);
        });
      })
    ),

  updatePlant: protectedProcedure
    .input(
      z.object({
        gardenId: id,
        plantId: z.string().trim().min(1).max(64),
        name: optionalNonEmpty("Plant name", 160),
        location: optionalText(255),
        autoWater: z.boolean().optional(),
        threshold: z.number().finite().min(0).max(100).optional(),
        dose: z.number().int().min(10).max(500).optional(),
        deviceId: id.nullable().optional(),
        channel: optionalChannel,
      })
    )
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        await db.transaction(async tx => {
          const current = await ownerPlant(
            tx,
            ctx.user.id,
            input.gardenId,
            input.plantId
          );
          const nextDeviceId =
            input.deviceId === undefined ? current.deviceId : input.deviceId;
          const nextChannel =
            input.deviceId === null && input.channel === undefined
              ? null
              : input.channel === undefined
                ? current.channel
                : input.channel;
          if (
            (nextDeviceId === null) !== (nextChannel === null) ||
            (nextDeviceId !== null && !nextChannel)
          )
            bad("Device and channel must be assigned together");
          const lockIds = [
            ...new Set(
              [current.deviceId, nextDeviceId].filter(
                (value): value is number => value !== null
              )
            ),
          ].sort((a, b) => a - b);
          for (const deviceId of lockIds)
            await tx.execute(
              sql`SELECT id FROM devices WHERE id = ${deviceId} AND gardenId = ${input.gardenId} FOR UPDATE`
            );
          if (nextDeviceId !== null) {
            const device = await ownerDevice(
              tx,
              ctx.user.id,
              input.gardenId,
              nextDeviceId
            );
            if (device.revoked) bad("Device is revoked", "CONFLICT");
          }
          if (
            nextDeviceId !== null &&
            nextChannel !== null &&
            (nextDeviceId !== current.deviceId ||
              nextChannel !== current.channel)
          ) {
            const assigned = await tx
              .select()
              .from(plants)
              .where(
                and(
                  eq(plants.gardenId, input.gardenId),
                  eq(plants.deviceId, nextDeviceId),
                  eq(plants.channel, nextChannel),
                  isNull(plants.archivedAt)
                )
              )
              .limit(1);
            if (assigned.some(row => row.id !== input.plantId))
              bad("That device channel is already assigned", "CONFLICT");
          }
          const patch: Partial<typeof plants.$inferInsert> = {};
          if (input.name !== undefined) patch.name = input.name;
          if (input.location !== undefined) patch.location = input.location;
          if (input.autoWater !== undefined) patch.autoWater = input.autoWater;
          if (input.threshold !== undefined) patch.threshold = input.threshold;
          if (input.dose !== undefined) patch.dose = input.dose;
          if (input.deviceId !== undefined) patch.deviceId = input.deviceId;
          if (input.channel !== undefined || input.deviceId !== undefined)
            patch.channel = nextChannel;
          if (!Object.keys(patch).length)
            bad("At least one plant setting is required");
          if (input.deviceId !== undefined || input.channel !== undefined) {
            await tx
              .update(commands)
              .set({
                status: "canceled",
                error: "Plant device assignment changed",
              })
              .where(
                and(
                  eq(commands.plantId, input.plantId),
                  eq(commands.status, "queued")
                )
              );
          }
          await tx
            .update(plants)
            .set(patch)
            .where(
              and(
                eq(plants.id, input.plantId),
                eq(plants.gardenId, input.gardenId),
                isNull(plants.archivedAt)
              )
            );
        });
        return { success: true } as const;
      })
    ),

  removePlant: protectedProcedure
    .input(
      z.object({ gardenId: id, plantId: z.string().trim().min(1).max(64) })
    )
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        await db.transaction(async tx => {
          await ownerPlant(tx, ctx.user.id, input.gardenId, input.plantId);
          await tx
            .update(commands)
            .set({ status: "canceled", error: "Plant archived" })
            .where(
              and(
                eq(commands.plantId, input.plantId),
                eq(commands.status, "queued")
              )
            );
          await tx
            .update(plants)
            .set({ archivedAt: new Date(), deviceId: null, channel: null })
            .where(eq(plants.id, input.plantId));
        });
        return { success: true } as const;
      })
    ),

  water: protectedProcedure
    .input(
      z.object({
        gardenId: id,
        plantId: z.string().trim().min(1).max(64),
        amount: z.number().int().min(10).max(500),
      })
    )
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        const row = await db.transaction(async tx => {
          const plant = await ownerPlant(
            tx,
            ctx.user.id,
            input.gardenId,
            input.plantId
          );
          if (plant.deviceId === null || plant.channel === null)
            bad("Plant has no device channel assigned");
          const device = await ownerDevice(
            tx,
            ctx.user.id,
            input.gardenId,
            plant.deviceId
          );
          if (device.revoked) bad("Device is revoked", "CONFLICT");
          if (
            !device.lastSeenAt ||
            Date.now() - asDate(device.lastSeenAt)!.getTime() > 120_000
          )
            bad("Device is offline", "CONFLICT");
          return enqueueCommandTx(tx, {
            gardenId: input.gardenId,
            plantId: input.plantId,
            deviceId: plant.deviceId,
            channel: plant.channel,
            amountMl: input.amount,
            mode: "manual",
          });
        });
        return toLiveCommand(row);
      })
    ),

  cancelCommand: protectedProcedure
    .input(
      z.object({ gardenId: id, commandId: z.string().trim().min(1).max(64) })
    )
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        await db.transaction(async tx => {
          await ownerGarden(tx, ctx.user.id, input.gardenId);
          await tx.execute(
            sql`SELECT id FROM commands WHERE id = ${input.commandId} AND gardenId = ${input.gardenId} FOR UPDATE`
          );
          const command = (
            await tx
              .select()
              .from(commands)
              .where(
                and(
                  eq(commands.id, input.commandId),
                  eq(commands.gardenId, input.gardenId)
                )
              )
              .limit(1)
          )[0];
          if (!command) bad("Command not found", "NOT_FOUND");
          if (command.status !== "queued")
            bad("Only queued commands can be canceled", "CONFLICT");
          await tx
            .update(commands)
            .set({ status: "canceled", error: "Canceled by owner" })
            .where(
              and(
                eq(commands.id, input.commandId),
                eq(commands.status, "queued")
              )
            );
        });
        return { success: true } as const;
      })
    ),

  registerDevice: protectedProcedure
    .input(
      z.object({
        gardenId: id,
        name: nonEmpty("Device name", 160),
        type: nonEmpty("Device type", 80),
        capacity: z.number().int().positive().max(2_000_000_000),
      })
    )
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        await ownerGarden(db, ctx.user.id, input.gardenId);
        const token = newDeviceToken();
        const hash = tokenHash(token);
        await db
          .insert(devices)
          .values({
            gardenId: input.gardenId,
            name: input.name,
            type: input.type,
            capacity: input.capacity,
            tokenHash: hash,
          });
        const device = (
          await db
            .select()
            .from(devices)
            .where(eq(devices.tokenHash, hash))
            .limit(1)
        )[0];
        if (!device) bad("Device could not be registered");
        return { device: toLiveDevice(device), token };
      })
    ),

  rotateDeviceToken: protectedProcedure
    .input(z.object({ gardenId: id, deviceId: id }))
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        await ownerDevice(db, ctx.user.id, input.gardenId, input.deviceId);
        const token = newDeviceToken();
        await db
          .update(devices)
          .set({ tokenHash: tokenHash(token) })
          .where(
            and(
              eq(devices.id, input.deviceId),
              eq(devices.gardenId, input.gardenId)
            )
          );
        return { token };
      })
    ),

  revokeDevice: protectedProcedure
    .input(z.object({ gardenId: id, deviceId: id }))
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        await db.transaction(async tx => {
          await ownerDevice(tx, ctx.user.id, input.gardenId, input.deviceId);
          await tx.execute(
            sql`SELECT id FROM devices WHERE id = ${input.deviceId} AND gardenId = ${input.gardenId} FOR UPDATE`
          );
          await tx
            .update(devices)
            .set({ revoked: true, reservoir: null })
            .where(
              and(
                eq(devices.id, input.deviceId),
                eq(devices.gardenId, input.gardenId)
              )
            );
          await tx
            .update(commands)
            .set({ status: "canceled", error: "Device revoked" })
            .where(
              and(
                eq(commands.deviceId, input.deviceId),
                eq(commands.status, "queued")
              )
            );
          await tx
            .update(commands)
            .set({ status: "expired", error: "delivery unknown" })
            .where(
              and(
                eq(commands.deviceId, input.deviceId),
                eq(commands.status, "claimed")
              )
            );
        });
        return { success: true } as const;
      })
    ),

  updateDevice: protectedProcedure
    .input(
      z.object({
        gardenId: id,
        deviceId: id,
        name: optionalNonEmpty("Device name", 160),
        capacity: z.number().int().positive().max(2_000_000_000).optional(),
      })
    )
    .mutation(({ ctx, input }) =>
      withErrors(async () => {
        const db = await requireDb();
        await ownerDevice(db, ctx.user.id, input.gardenId, input.deviceId);
        const patch: Partial<typeof devices.$inferInsert> = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.capacity !== undefined) patch.capacity = input.capacity;
        if (!Object.keys(patch).length)
          bad("At least one device setting is required");
        await db
          .update(devices)
          .set(patch)
          .where(
            and(
              eq(devices.id, input.deviceId),
              eq(devices.gardenId, input.gardenId)
            )
          );
        return { success: true } as const;
      })
    ),
});
