export interface Garden {
  id: number;
  name: string;
  location: string;
  timezone: string;
  notifications: boolean;
  enabled: boolean;
  createdAt: string;
}
export interface LivePlant {
  id: string;
  gardenId: number;
  name: string;
  species: string;
  location: string;
  image: string;
  deviceId: number | null;
  channel: string | null;
  autoWater: boolean;
  threshold: number;
  dose: number;
  moisture: number | null;
  temperature: number | null;
  humidity: number | null;
  light: number | null;
  battery: number | null;
  lastReadingAt: string | null;
  lastWatered: string | null;
  addedAt: string;
}
export interface LiveDevice {
  id: number;
  gardenId: number;
  name: string;
  type: string;
  capacity: number;
  reservoir: number | null;
  lastSeenAt: string | null;
  firmware: string | null;
  revoked: boolean;
  createdAt: string;
}
export interface LiveWaterEvent {
  id: string;
  plantId: string;
  amount: number;
  timestamp: string;
  mode: "automatic" | "manual";
  status: "completed" | "partial";
}
export interface LiveReading {
  plantId: string;
  timestamp: string;
  moisture: number;
  temperature: number | null;
  humidity: number | null;
  light: number | null;
}
export interface LiveCommand {
  id: string;
  plantId: string;
  deviceId: number;
  channel: string;
  amount: number;
  mode: "automatic" | "manual";
  status:
    | "queued"
    | "claimed"
    | "completed"
    | "failed"
    | "canceled"
    | "expired";
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  error: string | null;
}
export interface LiveGardenState {
  garden: Garden;
  plants: LivePlant[];
  devices: LiveDevice[];
  events: LiveWaterEvent[];
  readings: LiveReading[];
  commands: LiveCommand[];
}
