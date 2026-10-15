import { z } from "zod";

export const RideStatusEnum = z.enum([
  "REQUESTED",
  "ACCEPTED",
  "ARRIVED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);
export type RideStatus = z.infer<typeof RideStatusEnum>;

export const VehicleTypeEnum = z.enum([
  "Veloce X",
  "Veloce Black",
  "Veloce Grand",
]);
export type VehicleType = z.infer<typeof VehicleTypeEnum>;

export const UserRoleEnum = z.enum(["RIDER", "DRIVER", "ADMIN"]);
export type UserRole = z.infer<typeof UserRoleEnum>;

// API Request Schemas
export const EstimateFareSchema = z.object({
  pickup: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
  drop: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
  vehicleType: z.string().optional().default("Veloce X"),
});
export type EstimateFareInput = z.infer<typeof EstimateFareSchema>;

export const CreateRideSchema = z.object({
  pickupLat: z.number(),
  pickupLng: z.number(),
  pickupAddress: z.string().min(1),
  dropLat: z.number(),
  dropLng: z.number(),
  dropAddress: z.string().min(1),
  vehicleType: z.string().optional().default("Veloce X"),
});
export type CreateRideInput = z.infer<typeof CreateRideSchema>;

export const DriverOnlineSchema = z.object({
  lat: z.number().optional().default(28.6315),
  lng: z.number().optional().default(77.2167),
  vehicleType: z.string().optional().default("Veloce X"),
});
export type DriverOnlineInput = z.infer<typeof DriverOnlineSchema>;

export const DriverLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});
export type DriverLocationInput = z.infer<typeof DriverLocationSchema>;

// Data Interfaces
export interface DriverDetails {
  id: string;
  name: string;
  phone: string;
  vehicleType: string;
  vehicleModel: string;
  plateNumber: string;
  avgRating: number;
}

export interface RideData {
  id: string;
  riderId: string;
  driverId: string | null;
  status: RideStatus;
  vehicleType: string;
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  dropLat: number;
  dropLng: number;
  dropAddress: string;
  distanceMeters: number;
  durationSeconds: number;
  fareEstimatePaise: number;
  fareFinalPaise?: number | null;
  surgeMultiplier: number;
  cancelledBy?: string | null;
  cancellationFeePaise?: number | null;
  requestedAt: string | Date;
  acceptedAt?: string | Date | null;
  startedAt?: string | Date | null;
  completedAt?: string | Date | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  driver?: DriverDetails | null;
}

export interface ApiResponse<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}
