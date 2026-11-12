import { describe, expect, it } from "vitest";
import {
  newDeviceToken,
  ownerGarden,
  safeTokenEquals,
  tokenHash,
  toGarden,
  toLiveCommand,
  toLiveDevice,
  isCommandActive,
  validateMeasurement,
} from "./common";

function emptySelectDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [] }),
      }),
    }),
  } as any;
}

describe("garden backend safety primitives", () => {
  it("generates high-entropy tokens and stores only their SHA-256 digest", () => {
    const first = newDeviceToken();
    const second = newDeviceToken();
    expect(first).not.toEqual(second);
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(tokenHash(first)).toHaveLength(64);
    expect(tokenHash(first)).not.toContain(first);
    expect(safeTokenEquals(tokenHash(first), tokenHash(first))).toBe(true);
    expect(safeTokenEquals(tokenHash(first), tokenHash(second))).toBe(false);
  });

  it("rejects non-finite and out-of-range measurements", () => {
    expect(validateMeasurement("moisture", 42, 0, 100)).toBe(42);
    expect(() => validateMeasurement("moisture", Number.NaN, 0, 100)).toThrow();
    expect(() => validateMeasurement("moisture", 101, 0, 100)).toThrow();
  });

  it("keeps live timestamps ISO formatted and omits device token hashes", () => {
    const garden = toGarden({
      id: 7,
      userId: 3,
      name: "Roof",
      location: "Dhaka",
      timezone: "Asia/Dhaka",
      notifications: true,
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(garden.createdAt).toBe("2026-01-01T00:00:00.000Z");
    const device = toLiveDevice({
      id: 9,
      gardenId: 7,
      name: "Pump",
      type: "controller",
      capacity: 1000,
      reservoir: null,
      lastSeenAt: null,
      firmware: null,
      tokenHash: tokenHash("secret"),
      revoked: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(device).not.toHaveProperty("tokenHash");
  });

  it("rejects a garden lookup when the authenticated owner does not own it", async () => {
    await expect(ownerGarden(emptySelectDb(), 99, 7)).rejects.toThrow(
      "Garden not found"
    );
  });

  it("does not reserve water for lost or expired command leases", () => {
    const now = Date.now();
    const expiresAt = new Date(now + 300_000);
    expect(
      isCommandActive(
        { status: "claimed", expiresAt, claimExpiresAt: new Date(now - 1) },
        now
      )
    ).toBe(false);
    expect(
      isCommandActive(
        { status: "claimed", expiresAt, claimExpiresAt: null },
        now
      )
    ).toBe(false);
    expect(
      isCommandActive(
        {
          status: "claimed",
          expiresAt,
          claimExpiresAt: new Date(now + 60_000),
        },
        now
      )
    ).toBe(true);
    expect(
      isCommandActive(
        {
          status: "queued",
          expiresAt: new Date(now - 1),
          claimExpiresAt: null,
        },
        now
      )
    ).toBe(false);
  });

  it("shows unknown delivery for expired claims rather than endless watering", () => {
    const claimExpiresAt = new Date(Date.now() - 1);
    const row = {
      id: "lost",
      gardenId: 7,
      plantId: "plant",
      deviceId: 9,
      channel: "ch1",
      amountMl: 100,
      mode: "manual",
      status: "claimed",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 300_000),
      claimedAt: new Date(Date.now() - 60_000),
      claimExpiresAt,
      completedAt: null,
      deliveredMl: null,
      error: null,
    } as const;
    const output = toLiveCommand(row);
    expect(output.status).toBe("expired");
    expect(output.error).toBe("delivery unknown");
    expect(output.expiresAt).toBe(claimExpiresAt.toISOString());
  });
});
