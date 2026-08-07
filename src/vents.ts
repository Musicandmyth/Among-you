/**
 * Vents: hidden passages only impostors can use. Each vent sits at a fixed
 * world spot and links to one or more other vents; an impostor inside a vent is
 * invisible to everyone else and can hop between linked vents.
 *
 * The links form a few small networks across the ship (original layout, in the
 * spirit of the familiar vent system).
 */

import { ROOMS } from "./map";

export interface VentDef {
  id: string;
  room: string;
  x: number;
  y: number;
  /** ids of the vents this one connects to. */
  links: string[];
}

function at(roomName: string, fx: number, fy: number): { x: number; y: number } {
  const r = ROOMS.find((rm) => rm.name === roomName);
  if (!r) throw new Error("Unknown room: " + roomName);
  return { x: r.x + r.w * fx, y: r.y + r.h * fy };
}

export const VENTS: VentDef[] = [
  { id: "v-cafe", room: "Cafeteria", ...at("Cafeteria", 0.5, 0.2), links: ["v-admin", "v-nav"] },
  { id: "v-nav", room: "Navigation", ...at("Navigation", 0.72, 0.72), links: ["v-cafe"] },
  { id: "v-admin", room: "Admin", ...at("Admin", 0.72, 0.72), links: ["v-cafe", "v-storage"] },
  { id: "v-storage", room: "Storage", ...at("Storage", 0.22, 0.8), links: ["v-admin", "v-elec"] },
  { id: "v-elec", room: "Electrical", ...at("Electrical", 0.5, 0.85), links: ["v-storage", "v-med"] },
  { id: "v-med", room: "MedBay", ...at("MedBay", 0.8, 0.8), links: ["v-elec"] },
];

const BY_ID = new Map(VENTS.map((v) => [v.id, v]));

export function ventById(id: string): VentDef | undefined {
  return BY_ID.get(id);
}
