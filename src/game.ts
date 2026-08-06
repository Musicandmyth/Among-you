/**
 * The in-match scene. Responsibilities:
 *   - render the map, avatars, and bodies
 *   - simulate the LOCAL player (acceleration + wall/door collision)
 *   - reconcile remote players from network snapshots (interpolation)
 *   - VISION: exact analytic raycast so the player only sees what light reaches
 *   - MAP (toggle E): one shared map; impostors additionally get door-lock
 *     (sabotage) controls layered on the SAME map
 *   - actions: kill (impostor), report body, call emergency meeting
 *   - freeze/teleport during meetings
 */

import { Application, Container, Graphics, Text } from "pixi.js";
import { Input } from "./input";
import { WORLD, ROOMS, WALKABLE, DOORS, EMERGENCY_BUTTON, moveWithCollision, rayDistance, type Door } from "./map";
import { taskById, type TaskDef } from "./tasks";
import { TaskUI } from "./taskui";
import type { Net } from "./net";
import type { PeerId, PlayerInfo, PlayerState, Role } from "./protocol";

const SPEED = 190;
const SPRINT = 1.6;
const ACCEL = 1800;
const DECEL = 2200;
const RADIUS = 18;

const SEND_INTERVAL = 1 / 30;
const BROADCAST_INTERVAL = 1 / 20;

const WALL = 12;
const VISION_RAYS = 200; // beams reach until they hit a wall — smooth + high-FPS

const KILL_RANGE = 90; // world px — tightened so you must be right next to a target
const REPORT_RANGE = 90;
const EMERGENCY_RANGE = 90; // must be this close to the cafeteria button
const TASK_RANGE = 90; // must be this close to a task console to use it
const KILL_COOLDOWN_MS = 20_000;

const CREW_COLOR = 0x5b8cff;
const IMPOSTOR_COLOR = 0xff5b6e;

interface Avatar {
  info: PlayerInfo;
  container: Container;
  body: Graphics;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  targetX: number;
  targetY: number;
  isLocal: boolean;
  alive: boolean;
}

interface Body {
  container: Container;
  x: number;
  y: number;
}

export class Game {
  private app = new Application();
  private camera = new Container();
  private scene = new Container();
  private visionMask = new Graphics();
  private input = new Input();

  private avatars = new Map<PeerId, Avatar>();
  private roster = new Map<PeerId, PlayerInfo>();
  private local!: Avatar;

  private role: Role = "crew";
  private impostors = new Set<PeerId>();

  // Doors.
  private doorGfx = new Graphics();
  private lockedDoors = new Set<string>();
  private coolingDoors = new Set<string>(); // open, cannot be closed yet
  private blockers: Door[] = [];

  // Bodies.
  private bodies = new Map<string, Body>();

  // Single map overlay (E). Impostors get interactive door locks on it.
  private map = new Container();
  private mapPanel = new Container();
  private mapBackdrop = new Graphics();
  private mapMarker = new Graphics();
  private mapDoorGfx = new Map<string, Graphics>();
  private mapDoorRects = new Map<string, [number, number, number, number]>();
  private mapOpen = false;
  private mmBounds = { minX: 0, minY: 0, scale: 1, w: 0, h: 0 };

  // Meeting freeze / teleport.
  private frozen = false;
  private killReadyAt = 0;
  private emergencyUsed = false;

  // Tasks (crew only).
  private taskUI = new TaskUI();
  private myTasks: TaskDef[] = [];
  private doneTasks = new Set<string>();
  private taskMarkers = new Map<string, Container>(); // in-world "!" markers
  private mapTaskGfx = new Map<string, Graphics>(); // markers on the E map

  // Action buttons (DOM).
  private btnKill?: HTMLButtonElement;
  private btnReport?: HTMLButtonElement;
  private btnEmergency?: HTMLButtonElement;

  private sendAcc = 0;
  private broadcastAcc = 0;
  private keyHandler?: (e: KeyboardEvent) => void;

  constructor(
    private net: Net,
    private myId: PeerId,
  ) {}

  async start(
    roster: PlayerInfo[],
    spawns: { x: number; y: number }[],
    mount: HTMLElement,
    role: Role,
    impostors: PeerId[],
    tasks: string[],
  ) {
    this.role = role;
    this.impostors = new Set(impostors);

    await this.app.init({ background: 0x05070f, antialias: true, resizeTo: window });
    mount.appendChild(this.app.canvas);

    this.app.stage.addChild(this.camera);
    this.camera.addChild(this.scene);
    this.camera.addChild(this.visionMask);
    this.scene.mask = this.visionMask;

    this.drawMap();

    roster.forEach((info) => this.roster.set(info.id, info));
    roster.forEach((info, i) => {
      const spawn = spawns[i % spawns.length]!;
      this.spawnAvatar(info, spawn.x, spawn.y);
    });
    this.local = this.avatars.get(this.myId)!;

    // Each crewmate gets their own dealt task sequence; impostors get none.
    this.myTasks = tasks.map(taskById).filter((t): t is TaskDef => !!t);
    this.buildTaskMarkers();

    this.buildMapOverlay();
    this.app.stage.addChild(this.map);
    this.showRoleBadge();
    this.wireActionButtons();

    this.killReadyAt = now() + KILL_COOLDOWN_MS;

    this.keyHandler = (e) => {
      if (e.repeat) return;
      // Don't let hotkeys fire while typing in a text field (e.g. meeting chat).
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "e" || e.key === "E") this.toggleMap();
      if (e.key === "k" || e.key === "K") this.tryKill();
      if (e.key === "r" || e.key === "R") this.tryReport();
      if (e.key === "f" || e.key === "F") this.tryEmergency();
    };
    window.addEventListener("keydown", this.keyHandler);

    this.app.ticker.add((t) => this.update(Math.min(t.deltaMS / 1000, 0.05)));
  }

  // ---- world + avatars ----

  private drawMap() {
    const space = new Graphics();
    space.rect(0, 0, WORLD.width, WORLD.height).fill(0x05070f);
    this.scene.addChild(space);

    const walls = new Graphics();
    for (const a of WALKABLE) walls.rect(a.x - WALL, a.y - WALL, a.w + WALL * 2, a.h + WALL * 2);
    walls.fill(0x39456e);
    this.scene.addChild(walls);

    const floor = new Graphics();
    for (const a of WALKABLE) floor.rect(a.x, a.y, a.w, a.h);
    floor.fill(0x1c2547);
    this.scene.addChild(floor);

    const grid = new Graphics();
    for (const a of WALKABLE) {
      for (let gx = a.x; gx <= a.x + a.w; gx += 48) grid.moveTo(gx, a.y).lineTo(gx, a.y + a.h);
      for (let gy = a.y; gy <= a.y + a.h; gy += 48) grid.moveTo(a.x, gy).lineTo(a.x + a.w, gy);
    }
    grid.stroke({ width: 1, color: 0x27325c, alpha: 0.5 });
    this.scene.addChild(grid);

    this.scene.addChild(this.doorGfx);
    this.redrawDoors();

    for (const room of ROOMS) {
      const label = new Text({
        text: room.name ?? "",
        style: { fill: 0x6f7bad, fontSize: 20, fontWeight: "700", fontFamily: "system-ui, sans-serif" },
      });
      label.anchor.set(0.5);
      label.position.set(room.x + room.w / 2, room.y + 26);
      this.scene.addChild(label);
    }

    this.drawEmergencyButton();
  }

  /** The emergency-meeting console at the center of the Cafeteria — the only
   *  place a player can call a meeting. */
  private drawEmergencyButton() {
    const { x, y } = EMERGENCY_BUTTON;
    const g = new Graphics();
    g.circle(x, y, 38).fill(0x2a3358).stroke({ width: 4, color: 0x39456e }); // console base
    g.circle(x, y, 24).fill(0xff5b6e).stroke({ width: 4, color: 0x7a1622 }); // red button
    g.roundRect(x - 12, y - 4, 24, 8, 3).fill(0xffd23d); // ! bar
    g.circle(x, y + 12, 3).fill(0xffd23d); // ! dot
    this.scene.addChild(g);

    const label = new Text({
      text: "EMERGENCY",
      style: { fill: 0xff8391, fontSize: 12, fontWeight: "800", fontFamily: "system-ui, sans-serif", letterSpacing: 1 },
    });
    label.anchor.set(0.5);
    label.position.set(x, y + 54);
    this.scene.addChild(label);
  }

  private spawnAvatar(info: PlayerInfo, x: number, y: number) {
    const container = new Container();

    const body = new Graphics();
    drawCrewmate(body, info.color);
    container.addChild(body);

    const isFellowImpostor =
      this.role === "impostor" && info.id !== this.myId && this.impostors.has(info.id);

    const label = new Text({
      text: info.name,
      style: {
        fill: isFellowImpostor ? IMPOSTOR_COLOR : 0xffffff,
        fontSize: 13,
        fontWeight: isFellowImpostor ? "700" : "400",
        fontFamily: "system-ui, sans-serif",
        stroke: { color: 0x05070f, width: 4 },
      },
    });
    label.anchor.set(0.5, 1);
    label.y = -34;
    container.addChild(label);

    container.position.set(x, y);
    this.scene.addChild(container);

    this.avatars.set(info.id, {
      info, container, body,
      x, y, vx: 0, vy: 0, facing: 1,
      targetX: x, targetY: y,
      isLocal: info.id === this.myId,
      alive: true,
    });
  }

  private ensureAvatar(id: PeerId): Avatar | null {
    const existing = this.avatars.get(id);
    if (existing) return existing;
    const info = this.roster.get(id);
    if (!info) return null;
    this.spawnAvatar(info, WORLD.width / 2, WORLD.height / 2);
    return this.avatars.get(id)!;
  }

  // ---- per-frame update ----

  private update(dt: number) {
    this.simulateLocal(dt);
    this.interpolateRemotes(dt);
    this.syncNetwork(dt);
    this.updateCamera();
    this.updateVision();
    this.updateVisibility();
    this.updateActionButtons();
    this.updateTaskMarkers();
    if (this.mapOpen) this.updateMapMarker();
  }

  /** Ghosts (dead players) are visible only to other ghosts. A living player
   *  sees no ghosts at all; a dead player sees everyone. */
  private updateVisibility() {
    const ghostView = !this.local.alive;
    for (const av of this.avatars.values()) {
      if (av.isLocal) continue;
      av.container.visible = av.alive || ghostView;
    }
  }

  private simulateLocal(dt: number) {
    let dirX = 0;
    let dirY = 0;
    if (!this.frozen) {
      const dir = this.input.direction();
      dirX = dir.x;
      dirY = dir.y;
    }
    const max = SPEED * (this.input.sprinting() && !this.frozen ? SPRINT : 1);
    const rate = (dirX === 0 && dirY === 0 ? DECEL : ACCEL) * dt;
    this.local.vx = approach(this.local.vx, dirX * max, rate);
    this.local.vy = approach(this.local.vy, dirY * max, rate);

    const next = moveWithCollision(
      this.local.x, this.local.y,
      this.local.x + this.local.vx * dt,
      this.local.y + this.local.vy * dt,
      RADIUS,
      this.blockers,
    );
    this.local.x = next.x;
    this.local.y = next.y;
    this.faceBy(this.local, this.local.vx);
    this.local.container.position.set(next.x, next.y);
  }

  private interpolateRemotes(dt: number) {
    const a = 1 - Math.exp(-dt * 14);
    for (const av of this.avatars.values()) {
      if (av.isLocal) continue;
      const dx = av.targetX - av.x;
      av.x += dx * a;
      av.y += (av.targetY - av.y) * a;
      this.faceBy(av, dx);
      av.container.position.set(av.x, av.y);
    }
  }

  private faceBy(av: Avatar, dx: number) {
    if (dx > 1) av.facing = 1;
    else if (dx < -1) av.facing = -1;
    av.body.scale.x = av.facing;
  }

  private syncNetwork(dt: number) {
    if (this.net.isHost) {
      this.broadcastAcc += dt;
      if (this.broadcastAcc >= BROADCAST_INTERVAL) {
        this.broadcastAcc = 0;
        this.net.broadcastState(this.snapshot());
      }
    } else {
      this.sendAcc += dt;
      if (this.sendAcc >= SEND_INTERVAL) {
        this.sendAcc = 0;
        this.net.sendInput(this.local.x, this.local.y, this.local.vx, this.local.vy);
      }
    }
  }

  private snapshot(): PlayerState[] {
    const out: PlayerState[] = [];
    for (const av of this.avatars.values()) {
      out.push({
        id: av.info.id, name: av.info.name, color: av.info.color,
        x: av.isLocal ? av.x : av.targetX,
        y: av.isLocal ? av.y : av.targetY,
        vx: av.vx, vy: av.vy,
      });
    }
    return out;
  }

  private updateCamera() {
    const halfW = this.app.screen.width / 2;
    const halfH = this.app.screen.height / 2;
    let camX = halfW - this.local.x;
    let camY = halfH - this.local.y;
    camX = clamp(camX, Math.min(0, this.app.screen.width - WORLD.width), 0);
    camY = clamp(camY, Math.min(0, this.app.screen.height - WORLD.height), 0);
    this.camera.position.set(camX, camY);
  }

  private updateVision() {
    // Ghosts see the whole ship (no fog): drop the vision mask once dead.
    if (!this.local.alive) {
      if (this.scene.mask) {
        this.scene.mask = null;
        this.visionMask.visible = false;
      }
      return;
    }
    const px = this.local.x;
    const py = this.local.y;
    const pts: number[] = [];
    for (let i = 0; i < VISION_RAYS; i++) {
      const ang = (i / VISION_RAYS) * Math.PI * 2;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const dist = rayDistance(px, py, dx, dy, this.blockers);
      pts.push(px + dx * dist, py + dy * dist);
    }
    this.visionMask.clear();
    this.visionMask.poly(pts).fill(0xffffff);
  }

  // ---- doors (in-world) ----

  setDoors(locked: string[], cooling: string[] = []) {
    this.lockedDoors = new Set(locked);
    this.coolingDoors = new Set(cooling);
    this.blockers = DOORS.filter((d) => this.lockedDoors.has(d.id));
    this.redrawDoors();
    this.refreshMapDoors();
  }

  private redrawDoors() {
    this.doorGfx.clear();
    for (const d of DOORS) {
      if (this.lockedDoors.has(d.id)) {
        this.doorGfx.rect(d.x, d.y, d.w, d.h).fill(0xff5b6e).stroke({ width: 3, color: 0x7a1622 });
      } else {
        this.doorGfx.rect(d.x, d.y, d.w, d.h).fill({ color: 0x2c3862, alpha: 0.5 });
      }
    }
  }

  // ---- bodies ----

  private addBody(bodyId: string, x: number, y: number, victim: PeerId) {
    if (this.bodies.has(bodyId)) return;
    const info = this.roster.get(victim);
    const color = info?.color ?? 0xffffff;
    const container = new Container();
    const g = new Graphics();
    drawCrewmate(g, color);
    g.rotation = Math.PI / 2; // toppled over
    container.addChild(g);
    const bone = new Graphics();
    bone.circle(10, -6, 4).fill(0xffffff);
    container.addChild(bone);
    container.position.set(x, y);
    this.scene.addChildAt(container, this.scene.getChildIndex(this.doorGfx) + 1);
    this.bodies.set(bodyId, { container, x, y });
  }

  private clearBodies() {
    for (const b of this.bodies.values()) {
      this.scene.removeChild(b.container);
      b.container.destroy({ children: true });
    }
    this.bodies.clear();
  }

  // ---- actions ----

  private tryKill() {
    if (this.role !== "impostor" || !this.local.alive || this.frozen) return;
    if (now() < this.killReadyAt) return;
    const victim = this.nearestKillTarget();
    if (!victim) return;
    this.net.requestKill(victim.info.id, victim.x, victim.y);
    this.killReadyAt = now() + KILL_COOLDOWN_MS;
  }

  private tryReport() {
    if (!this.local.alive || this.frozen) return;
    const bodyId = this.nearestBody();
    if (bodyId) this.net.requestReport(bodyId);
  }

  private tryEmergency() {
    if (!this.local.alive || this.frozen || this.emergencyUsed) return;
    if (!this.nearEmergencyButton()) return; // only at the cafeteria console
    this.emergencyUsed = true;
    this.net.requestEmergency();
  }

  private nearEmergencyButton(): boolean {
    return dist2(this.local.x, this.local.y, EMERGENCY_BUTTON.x, EMERGENCY_BUTTON.y) <= EMERGENCY_RANGE * EMERGENCY_RANGE;
  }

  private nearestKillTarget(): Avatar | null {
    let best: Avatar | null = null;
    let bestD = KILL_RANGE * KILL_RANGE;
    for (const av of this.avatars.values()) {
      if (av.isLocal || !av.alive) continue;
      if (this.impostors.has(av.info.id)) continue; // don't target fellow impostors
      const d = dist2(this.local.x, this.local.y, av.x, av.y);
      if (d < bestD) { bestD = d; best = av; }
    }
    return best;
  }

  private nearestBody(): string | null {
    let best: string | null = null;
    let bestD = REPORT_RANGE * REPORT_RANGE;
    for (const [id, b] of this.bodies) {
      const d = dist2(this.local.x, this.local.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best;
  }

  // ---- tasks ----

  /** Build the in-world "!" markers for this crewmate's incomplete tasks. */
  private buildTaskMarkers() {
    for (const task of this.myTasks) {
      const marker = new Container();
      const g = new Graphics();
      drawBang(g);
      marker.addChild(g);
      marker.position.set(task.x, task.y);
      marker.eventMode = "static";
      marker.cursor = "pointer";
      marker.on("pointertap", () => this.tryOpenTask(task));
      this.scene.addChild(marker);
      this.taskMarkers.set(task.id, marker);
    }
  }

  private tryOpenTask(task: TaskDef) {
    if (this.doneTasks.has(task.id) || this.frozen || this.taskUI.isOpen()) return;
    if (dist2(this.local.x, this.local.y, task.x, task.y) > TASK_RANGE * TASK_RANGE) return;
    this.taskUI.open(task, () => this.completeTask(task.id));
  }

  private completeTask(taskId: string) {
    if (this.doneTasks.has(taskId)) return;
    this.doneTasks.add(taskId);
    // Remove the world + map markers for this task.
    const marker = this.taskMarkers.get(taskId);
    if (marker) {
      this.scene.removeChild(marker);
      marker.destroy({ children: true });
      this.taskMarkers.delete(taskId);
    }
    const mg = this.mapTaskGfx.get(taskId);
    if (mg) { mg.visible = false; }
    this.net.requestTaskDone(taskId);
  }

  /** Pulse markers that are in reach so the player knows they can interact. */
  private updateTaskMarkers() {
    for (const task of this.myTasks) {
      const marker = this.taskMarkers.get(task.id);
      if (!marker) continue;
      const inRange = dist2(this.local.x, this.local.y, task.x, task.y) <= TASK_RANGE * TASK_RANGE;
      marker.scale.set(inRange ? 1.25 : 1);
      marker.alpha = inRange ? 1 : 0.85;
    }
  }

  private updateActionButtons() {
    if (this.btnKill) {
      const show = this.role === "impostor" && this.local.alive;
      this.btnKill.style.display = show ? "" : "none";
      if (show) {
        const remain = Math.ceil((this.killReadyAt - now()) / 1000);
        const ready = remain <= 0 && !this.frozen;
        const hasTarget = this.nearestKillTarget() !== null;
        this.btnKill.disabled = !(ready && hasTarget);
        this.btnKill.textContent = remain > 0 ? `Kill ${remain}s` : "Kill";
      }
    }
    if (this.btnReport) {
      const show = this.local.alive;
      this.btnReport.style.display = show ? "" : "none";
      if (show) this.btnReport.disabled = this.frozen || this.nearestBody() === null;
    }
    if (this.btnEmergency) {
      const show = this.local.alive;
      this.btnEmergency.style.display = show ? "" : "none";
      if (show) {
        this.btnEmergency.disabled = this.frozen || this.emergencyUsed || !this.nearEmergencyButton();
        this.btnEmergency.textContent = this.emergencyUsed
          ? "Used"
          : this.nearEmergencyButton()
            ? "Emergency"
            : "Go to button";
      }
    }
  }

  private wireActionButtons() {
    this.btnKill = document.getElementById("btn-kill") as HTMLButtonElement | null ?? undefined;
    this.btnReport = document.getElementById("btn-report") as HTMLButtonElement | null ?? undefined;
    this.btnEmergency = document.getElementById("btn-emergency") as HTMLButtonElement | null ?? undefined;
    document.getElementById("actions")?.classList.remove("hidden");
    this.btnKill?.addEventListener("click", () => this.tryKill());
    this.btnReport?.addEventListener("click", () => this.tryReport());
    this.btnEmergency?.addEventListener("click", () => this.tryEmergency());
  }

  // ---- single map overlay (E) with impostor sabotage ----

  private buildMapOverlay() {
    this.map.addChild(this.mapBackdrop);
    this.map.addChild(this.mapPanel);
    this.map.visible = false;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const a of WALKABLE) {
      minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x + a.w); maxY = Math.max(maxY, a.y + a.h);
    }
    const pad = 60;
    const panelW = 560;
    const scale = panelW / (maxX - minX);
    const panelH = (maxY - minY) * scale;
    this.mmBounds = { minX, minY, scale, w: panelW, h: panelH };

    const impostor = this.role === "impostor";
    const tint = impostor ? IMPOSTOR_COLOR : CREW_COLOR;

    const bg = new Graphics();
    bg.roundRect(-pad / 2, -pad / 2, panelW + pad, panelH + pad, 18)
      .fill({ color: 0x05070f, alpha: 0.93 })
      .stroke({ width: 2, color: tint, alpha: 0.85 });
    this.mapPanel.addChild(bg);

    const shape = new Graphics();
    for (const a of WALKABLE) shape.rect((a.x - minX) * scale, (a.y - minY) * scale, a.w * scale, a.h * scale);
    shape.fill({ color: tint, alpha: 0.2 }).stroke({ width: 1.5, color: tint, alpha: 0.9 });
    this.mapPanel.addChild(shape);

    for (const room of ROOMS) {
      const t = new Text({
        text: room.name ?? "",
        style: { fill: tint, fontSize: 11, fontFamily: "system-ui, sans-serif", fontWeight: "600" },
      });
      t.anchor.set(0.5);
      t.position.set((room.x + room.w / 2 - minX) * scale, (room.y + room.h / 2 - minY) * scale);
      t.alpha = 0.85;
      this.mapPanel.addChild(t);
    }

    // Doors on the SAME map. Impostors can tap them to lock (sabotage).
    for (const d of DOORS) {
      const dx = (d.x - minX) * scale;
      const dy = (d.y - minY) * scale;
      const dw = Math.max(8, d.w * scale);
      const dh = Math.max(8, d.h * scale);
      this.mapDoorRects.set(d.id, [dx, dy, dw, dh]);
      const g = new Graphics();
      if (impostor) {
        g.eventMode = "static";
        g.cursor = "pointer";
        // A door on close-cooldown (recently opened) can't be closed yet.
        g.on("pointertap", () => {
          if (this.coolingDoors.has(d.id)) return;
          this.net.requestSabotageDoor(d.id);
        });
      }
      this.mapPanel.addChild(g);
      this.mapDoorGfx.set(d.id, g);
    }
    this.refreshMapDoors();

    // Crew: mark each task with a "!" on the map / minimap.
    for (const task of this.myTasks) {
      const g = new Graphics();
      drawBang(g, 7);
      g.position.set((task.x - minX) * scale, (task.y - minY) * scale);
      this.mapPanel.addChild(g);
      this.mapTaskGfx.set(task.id, g);
    }

    const heading = new Text({
      text: impostor ? "MAP · IMPOSTOR (tap a door to lock)" : "MAP · CREWMATE",
      style: { fill: tint, fontSize: 15, fontWeight: "800", fontFamily: "system-ui, sans-serif", letterSpacing: 1.5 },
    });
    heading.anchor.set(0.5, 1);
    heading.position.set(panelW / 2, -pad / 2 - 8);
    this.mapPanel.addChild(heading);

    this.mapPanel.addChild(this.mapMarker);
  }

  private refreshMapDoors() {
    const impostor = this.role === "impostor";
    for (const [id, g] of this.mapDoorGfx) {
      const rect = this.mapDoorRects.get(id);
      if (!rect) continue;
      const [dx, dy, dw, dh] = rect;
      const locked = this.lockedDoors.has(id);
      const cooling = this.coolingDoors.has(id);
      const p = 4;
      g.clear();
      // locked = red; cooling (can't close yet) = dim amber; otherwise closable.
      const fill = locked
        ? { color: 0xff5b6e, alpha: 1 }
        : cooling && impostor
          ? { color: 0xffd23d, alpha: 0.22 }
          : { color: 0xffffff, alpha: impostor ? 0.28 : 0.14 };
      const stroke = locked
        ? 0x7a1622
        : cooling && impostor
          ? 0x7a5b00
          : impostor
            ? IMPOSTOR_COLOR
            : 0x39456e;
      g.roundRect(dx - p, dy - p, dw + p * 2, dh + p * 2, 4)
        .fill(fill)
        .stroke({ width: 1.5, color: stroke });
    }
  }

  private toggleMap() {
    if (this.frozen && !this.mapOpen) return; // no opening the map mid-meeting
    this.mapOpen = !this.mapOpen;
    this.map.visible = this.mapOpen;
    if (!this.mapOpen) return;
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
    this.mapBackdrop.clear();
    this.mapBackdrop.rect(0, 0, sw, sh).fill({ color: 0x000000, alpha: 0.55 });
    this.mapPanel.position.set((sw - this.mmBounds.w) / 2, (sh - this.mmBounds.h) / 2);
    this.updateMapMarker();
  }

  private updateMapMarker() {
    const { minX, minY, scale } = this.mmBounds;
    const mx = (this.local.x - minX) * scale;
    const my = (this.local.y - minY) * scale;
    this.mapMarker.clear();
    this.mapMarker.circle(mx, my, 5).fill(0xffffff).stroke({ width: 2, color: 0x05070f });
  }

  private showRoleBadge() {
    const hud = document.getElementById("hud");
    if (!hud) return;
    const badge = document.createElement("span");
    badge.id = "role-badge";
    badge.textContent = this.role === "impostor" ? "IMPOSTOR" : "CREWMATE";
    badge.style.fontWeight = "800";
    badge.style.letterSpacing = "1px";
    badge.style.color = this.role === "impostor" ? "#ff5b6e" : "#5b8cff";
    hud.prepend(badge);
  }

  // ---- meeting hooks (called from main.ts handlers) ----

  onMeetingStart() {
    this.frozen = true;
    this.clearBodies();
    this.taskUI.close();
    // Everyone gathers in a ring around the emergency button in the Cafeteria.
    const spot = this.meetingSpot();
    this.local.x = spot.x;
    this.local.y = spot.y;
    this.local.vx = 0;
    this.local.vy = 0;
    this.local.container.position.set(this.local.x, this.local.y);
    if (this.mapOpen) this.toggleMap();
  }

  /** A slot on a ring around the emergency button, chosen from this player's
   *  index in the (id-sorted) roster so players spread out instead of stacking. */
  private meetingSpot(): { x: number; y: number } {
    const ids = [...this.avatars.keys()].sort();
    const n = Math.max(1, ids.length);
    const idx = Math.max(0, ids.indexOf(this.myId));
    const angle = (idx / n) * Math.PI * 2 - Math.PI / 2;
    const r = 170;
    return {
      x: EMERGENCY_BUTTON.x + Math.cos(angle) * r,
      y: EMERGENCY_BUTTON.y + Math.sin(angle) * r,
    };
  }

  onMeetingEnd() {
    this.frozen = false;
    this.killReadyAt = now() + KILL_COOLDOWN_MS; // cooldown resets after meetings
  }

  // ---- network callbacks ----

  applyState(players: PlayerState[]) {
    for (const p of players) {
      if (p.id === this.myId) continue;
      if (!this.roster.has(p.id)) this.roster.set(p.id, { id: p.id, name: p.name, color: p.color });
      const av = this.ensureAvatar(p.id);
      if (av) { av.targetX = p.x; av.targetY = p.y; av.vx = p.vx; av.vy = p.vy; }
    }
  }

  applyInput(id: PeerId, x: number, y: number, vx: number, vy: number) {
    const av = this.ensureAvatar(id);
    if (av) { av.targetX = x; av.targetY = y; av.vx = vx; av.vy = vy; }
  }

  /** A kill happened: ghost the victim and drop a body. */
  applyKilled(victim: PeerId, bodyId: string, x: number, y: number) {
    const av = this.avatars.get(victim);
    if (av) this.setGhost(av);
    this.addBody(bodyId, x, y, victim);
  }

  /** A meeting ejected `ejected` (or null). Ghost them. */
  applyEject(ejected: PeerId | null) {
    if (!ejected) return;
    const av = this.avatars.get(ejected);
    if (av) this.setGhost(av);
  }

  private setGhost(av: Avatar) {
    av.alive = false;
    av.container.alpha = 0.4;
    if (av.isLocal) this.onLocalDeath();
  }

  /** The local player just became a ghost: reveal the badge as a ghost and let
   *  them roam. Vision/visibility switch over automatically on the next frame
   *  (updateVision drops the mask, updateVisibility reveals fellow ghosts).
   *  Ghosts keep their tasks — the crew still needs them finished. */
  private onLocalDeath() {
    const badge = document.getElementById("role-badge");
    if (badge) {
      badge.textContent = "GHOST";
      badge.style.color = "#8a93ad";
    }
  }

  updateRoster(list: PlayerInfo[]) {
    const ids = new Set(list.map((p) => p.id));
    for (const p of list) this.roster.set(p.id, p);
    for (const [id, av] of this.avatars) {
      if (!ids.has(id) && !av.isLocal) {
        this.scene.removeChild(av.container);
        av.container.destroy({ children: true });
        this.avatars.delete(id);
      }
    }
  }

  dispose() {
    this.input.dispose();
    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler);
    document.getElementById("actions")?.classList.add("hidden");
    document.getElementById("role-badge")?.remove();
    this.taskUI.dispose();
    this.app.destroy(true, { children: true });
  }
}

/** Draw a stylized Among Us crewmate facing right around a local origin. */
function drawCrewmate(g: Graphics, color: number) {
  const outline = 0x05070f;
  const dark = darken(color, 0.72);
  g.roundRect(-21, -8, 13, 24, 6).fill(dark).stroke({ width: 2, color: outline });
  g.roundRect(-11, 14, 9, 10, 3).fill(color).stroke({ width: 2, color: outline });
  g.roundRect(2, 14, 9, 10, 3).fill(color).stroke({ width: 2, color: outline });
  g.roundRect(-13, -22, 26, 40, 12).fill(color).stroke({ width: 2, color: outline });
  g.ellipse(5, -8, 10, 7).fill(0xbfe3f2).stroke({ width: 2, color: outline });
  g.ellipse(2, -10, 3, 2).fill(0xffffff);
}

/** Draw a task "!" marker (yellow disc with an exclamation mark) at the origin. */
function drawBang(g: Graphics, r = 16) {
  g.circle(0, 0, r).fill(0xffd23d).stroke({ width: 3, color: 0x7a5b00 });
  g.roundRect(-2.5, -r + 5, 5, r - 4, 2).fill(0x3a2b00);
  g.circle(0, r - 6, 2.6).fill(0x3a2b00);
}

function darken(c: number, f: number): number {
  const r = Math.round(((c >> 16) & 0xff) * f);
  const g = Math.round(((c >> 8) & 0xff) * f);
  const b = Math.round((c & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  if (current > target) return Math.max(current - maxDelta, target);
  return current;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

function now(): number {
  return performance.now();
}
