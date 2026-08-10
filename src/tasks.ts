/**
 * Crewmate tasks scattered around the ship. Each task has a fixed world
 * location (anchored to a room) and a minigame `type` that the task UI renders.
 *
 * There is a shared POOL of tasks; each crewmate is dealt a different random
 * sequence of them at match start (see assignTasks). The crew wins once every
 * crewmate has completed all of their assigned tasks. The minigames are simple,
 * original takes on the familiar "do a little job at a console" idea.
 */

import { ROOMS } from "./map";

export type TaskType = "wires" | "swipe" | "download" | "upload" | "keypad" | "reactor" | "scan";

export interface TaskDef {
  id: string;
  name: string;
  room: string;
  type: TaskType;
  x: number;
  y: number;
  /** VISUAL tasks play an animation everyone nearby can see, so honestly doing
   *  one clears you as a real crewmate. Rare — only the MedBay scan for now. */
  visual?: boolean;
}

function at(roomName: string, fx: number, fy: number): { x: number; y: number } {
  const r = ROOMS.find((rm) => rm.name === roomName);
  if (!r) throw new Error("Unknown room: " + roomName);
  return { x: r.x + r.w * fx, y: r.y + r.h * fy };
}

/** The full pool of tasks in the ship. */
export const TASKS: TaskDef[] = [
  { id: "t-wires-e", name: "Fix Wiring", room: "Electrical", type: "wires", ...at("Electrical", 0.35, 0.62) },
  { id: "t-reactor-e", name: "Prime Engines", room: "Electrical", type: "reactor", ...at("Electrical", 0.7, 0.35) },
  { id: "t-keypad-e", name: "Divert Power", room: "Electrical", type: "keypad", ...at("Electrical", 0.3, 0.28) },
  { id: "t-swipe", name: "Swipe Card", room: "Admin", type: "swipe", ...at("Admin", 0.5, 0.55) },
  { id: "t-keypad-a", name: "Clear Codes", room: "Admin", type: "keypad", ...at("Admin", 0.28, 0.3) },
  { id: "t-download-a", name: "Record Temperature", room: "Admin", type: "download", ...at("Admin", 0.72, 0.3) },
  { id: "t-download", name: "Download Data", room: "Cafeteria", type: "download", ...at("Cafeteria", 0.2, 0.82) },
  { id: "t-upload-c", name: "Upload Data", room: "Cafeteria", type: "upload", ...at("Cafeteria", 0.8, 0.82) },
  { id: "t-wires-c", name: "Fix Comms", room: "Cafeteria", type: "wires", ...at("Cafeteria", 0.5, 0.85) },
  { id: "t-keypad-n", name: "Enter ID Code", room: "Navigation", type: "keypad", ...at("Navigation", 0.5, 0.62) },
  { id: "t-upload-n", name: "Chart Course", room: "Navigation", type: "upload", ...at("Navigation", 0.3, 0.3) },
  { id: "t-reactor-n", name: "Stabilize Steering", room: "Navigation", type: "reactor", ...at("Navigation", 0.72, 0.32) },
  { id: "t-reactor-s", name: "Start Reactor", room: "Storage", type: "reactor", ...at("Storage", 0.5, 0.55) },
  { id: "t-wires-s", name: "Calibrate Wiring", room: "Storage", type: "wires", ...at("Storage", 0.8, 0.3) },
  { id: "t-upload-s", name: "Fuel Engines", room: "Storage", type: "upload", ...at("Storage", 0.2, 0.3) },
  { id: "t-scan", name: "Submit Scan", room: "MedBay", type: "scan", visual: true, ...at("MedBay", 0.5, 0.62) },
  { id: "t-wires-m", name: "Inspect Sample", room: "MedBay", type: "wires", ...at("MedBay", 0.25, 0.32) },
  { id: "t-keypad-sec", name: "Reset Breakers", room: "Security", type: "keypad", ...at("Security", 0.5, 0.35) },
];

/** How many tasks each crewmate is dealt from the pool. */
export const TASKS_PER_PLAYER = 5;

/** Deal a crewmate a random sequence of `TASKS_PER_PLAYER` distinct task ids. */
export function assignTasks(rand: () => number): string[] {
  const ids = TASKS.map((t) => t.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.min(TASKS_PER_PLAYER, ids.length));
}

/** Look up a task by id. */
export function taskById(id: string): TaskDef | undefined {
  return TASKS.find((t) => t.id === id);
}

/** True if `id` is a visual task (one others can watch you complete). */
export function isVisualTask(id: string): boolean {
  return !!taskById(id)?.visual;
}
