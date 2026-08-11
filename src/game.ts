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
import {
  WORLD, ROOMS, WALKABLE, DOORS, EMERGENCY_BUTTON,
  SECURITY_CONSOLE, CAMERAS, moveWithCollision, rayDistance, type Door,
} from "./map";
import { taskById, type TaskDef } from "./tasks";
import { VENTS, ventById, type VentDef } from "./vents";
import { TaskUI } from "./taskui";
import type { Net } from "./net";
import type { GameRules, PeerId, PlayerInfo, PlayerState, Role } from "./protocol";

const SPEED = 190;
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
const VENT_RANGE = 34; // must be standing on top of the vent grate to drop in
const SECURITY_RANGE = 110; // must be this close to the camera console to watch
// Camera feeds are zoomed in, so you see ~25% less of the surroundings than if
// you were actually standing there (show ~75% of the extent → 1/0.75 zoom).
const CAMERA_ZOOM = 1 / 0.75;

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
  vented: boolean;
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

  // Rules (from the host, applied at match start).
  private killCooldownMs = 20_000;
  private emergencyCooldownMs = 20_000;
  private emergenciesPerPlayer = 1;
  private emergenciesUsed = 0;
  private emergencyReadyAt = 0;

  // Tasks (crew only).
  private taskUI = new TaskUI();
  private myTasks: TaskDef[] = [];
  private doneTasks = new Set<string>();
  private taskMarkers = new Map<string, Container>(); // in-world "!" markers
  private mapTaskGfx = new Map<string, Graphics>(); // markers on the E map

  // Vents (impostor-only movement). Rendered for everyone as map decor.
  private ventGfx = new Map<string, Graphics>();
  private vented = false;
  private currentVentId: string | null = null;
  private ventNav?: HTMLElement;
  private ventAnims: { g: Graphics; t: number }[] = []; // brief "lid pops open" tweens

  // Security cameras (open at the Security console, key C). Watching relocates
  // the viewport to a camera's spot; ← / → cycle feeds, one at a time.
  private camsOpen = false;
  private camIndex = 0;
  private camHud?: HTMLElement;

  // Action buttons (DOM).
  private btnKill?: HTMLButtonElement;
  private btnReport?: HTMLButtonElement;
  private btnEmergency?: HTMLButtonElement;
  private btnVent?: HTMLButtonElement;

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
    rules: GameRules,
  ) {
    this.role = role;
    this.impostors = new Set(impostors);
    this.killCooldownMs = rules.killCooldownMs;
    this.emergencyCooldownMs = rules.emergencyCooldownMs;
    this.emergenciesPerPlayer = rules.emergenciesPerPlayer;
    this.emergenciesUsed = 0;

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
    this.buildVents();

    this.buildMapOverlay();
    this.app.stage.addChild(this.map);
    this.showRoleBadge();
    this.wireActionButtons();

    this.killReadyAt = now() + this.killCooldownMs;
    this.emergencyReadyAt = now() + this.emergencyCooldownMs; // initial cooldown

    this.keyHandler = (e) => {
      if (e.repeat) return;
      // Don't let hotkeys fire while typing in a text field (e.g. meeting chat).
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // While watching cameras, arrow keys cycle between feeds.
      if (this.camsOpen && e.key.startsWith("Arrow")) {
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") this.switchCamera(-1);
        else if (e.key === "ArrowRight" || e.key === "ArrowDown") this.switchCamera(1);
        e.preventDefault();
        return;
      }
      if (e.key === "e" || e.key === "E") this.toggleMap();
      if (e.key === "k" || e.key === "K") this.tryKill();
      if (e.key === "r" || e.key === "R") this.tryReport();
      if (e.key === "f" || e.key === "F") this.tryEmergency();
      if (e.key === "q" || e.key === "Q") this.tryVent();
      if (e.key === "c" || e.key === "C") this.tryToggleCameras();
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
    this.drawSecurityConsole();
    this.drawCameraIcons();
  }

  /** The camera console in the Security room — stand next to it and press C to
   *  bring up the camera system. */
  private drawSecurityConsole() {
    const { x, y } = SECURITY_CONSOLE;
    const g = new Graphics();
    g.roundRect(x - 40, y - 22, 80, 44, 6).fill(0x14203a).stroke({ width: 4, color: 0x39456e });
    for (let i = -1; i <= 1; i++) {
      g.roundRect(x + i * 25 - 10, y - 14, 20, 16, 2).fill(0x0c3a2a).stroke({ width: 2, color: 0x3ddc84 });
    }
    this.scene.addChild(g);

    const label = new Text({
      text: "CAMERAS",
      style: { fill: 0x6fe3b0, fontSize: 12, fontWeight: "800", fontFamily: "system-ui, sans-serif", letterSpacing: 1 },
    });
    label.anchor.set(0.5);
    label.position.set(x, y + 34);
    this.scene.addChild(label);
  }

  /** Little wall-mounted cameras in the hallways, drawn as map decor: a bracket
   *  flush to the wall, an arm, and a body whose lens points into the hallway. */
  private drawCameraIcons() {
    for (const cam of CAMERAS) {
      const { x, y } = cam.eye;
      const dx = cam.dir.x;
      const dy = cam.dir.y;
      const g = new Graphics();
      const mx = x - dx * 12;
      const my = y - dy * 12;
      g.circle(mx, my, 5).fill(0x2a3358).stroke({ width: 2, color: 0x6f7bad }); // wall bracket
      g.moveTo(mx, my).lineTo(x, y).stroke({ width: 3, color: 0x6f7bad }); // arm
      g.roundRect(x - 8, y - 6, 16, 12, 3).fill(0x2a3358).stroke({ width: 2, color: 0x6f7bad }); // body
      g.circle(x + dx * 7, y + dy * 7, 3).fill(0xff5b6e); // lens, pointing inward
      this.scene.addChild(g);
    }
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
      vented: false,
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
    this.updateVentAnims(dt);
    if (this.mapOpen) this.updateMapMarker();
    // Dying closes the feed. (The player is held at the console while watching,
    // so they can't wander out of range.)
    if (this.camsOpen && !this.local.alive) this.closeCameras();
  }

  /** Ghosts (dead players) are visible only to other ghosts; a vented impostor
   *  is hidden from everyone else. A living player sees no ghosts and no vented
   *  players; a dead player sees everyone (except still-hidden vented ones). */
  private updateVisibility() {
    const ghostView = !this.local.alive;
    for (const av of this.avatars.values()) {
      if (av.isLocal) {
        // The local player fades while vented so they know they're hidden.
        av.container.alpha = this.vented ? 0.45 : av.alive ? 1 : 0.4;
        continue;
      }
      av.container.visible = !av.vented && (av.alive || ghostView);
    }
  }

  private simulateLocal(dt: number) {
    const held = this.frozen || this.vented || this.camsOpen; // no walking during meetings, in a vent, or while watching cameras
    let dirX = 0;
    let dirY = 0;
    if (!held) {
      const dir = this.input.direction();
      dirX = dir.x;
      dirY = dir.y;
    }
    const max = SPEED;
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
        this.net.sendInput(this.local.x, this.local.y, this.local.vx, this.local.vy, this.vented);
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
        vented: av.isLocal ? this.vented : av.vented,
      });
    }
    return out;
  }

  private updateCamera() {
    const halfW = this.app.screen.width / 2;
    const halfH = this.app.screen.height / 2;
    // When watching cameras, the viewport looks from the camera's spot instead
    // of following the local player, and zooms in so you see ~25% less.
    const scale = this.camsOpen ? CAMERA_ZOOM : 1;
    this.camera.scale.set(scale);
    const focus = this.camsOpen ? this.camEye() : this.local;
    let camX = halfW - focus.x * scale;
    let camY = halfH - focus.y * scale;
    camX = clamp(camX, Math.min(0, this.app.screen.width - WORLD.width * scale), 0);
    camY = clamp(camY, Math.min(0, this.app.screen.height - WORLD.height * scale), 0);
    this.camera.position.set(camX, camY);
  }

  private updateVision() {
    // Ghosts see the whole ship (no fog): drop the vision mask once dead. But
    // while watching cameras we always cast from the camera's spot, so the mask
    // stays on and re-attaches if it was dropped.
    if (!this.local.alive && !this.camsOpen) {
      if (this.scene.mask) {
        this.scene.mask = null;
        this.visionMask.visible = false;
      }
      return;
    }
    if (this.camsOpen && this.scene.mask !== this.visionMask) {
      this.scene.mask = this.visionMask;
      this.visionMask.visible = true;
    }
    // Sight is cast from the camera when watching, otherwise from the player.
    const origin = this.camsOpen ? this.camEye() : this.local;
    const px = origin.x;
    const py = origin.y;
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
    if (this.role !== "impostor" || !this.local.alive || this.frozen || this.vented) return;
    if (now() < this.killReadyAt) return;
    const victim = this.nearestKillTarget();
    if (!victim) return;
    this.net.requestKill(victim.info.id, victim.x, victim.y);
    this.killReadyAt = now() + this.killCooldownMs;
  }

  private tryReport() {
    if (!this.local.alive || this.frozen) return;
    const bodyId = this.nearestBody();
    if (bodyId) this.net.requestReport(bodyId);
  }

  private tryEmergency() {
    if (!this.local.alive || this.frozen || this.vented) return;
    if (this.emergenciesUsed >= this.emergenciesPerPlayer) return; // out of meetings
    if (now() < this.emergencyReadyAt) return; // still on cooldown
    if (!this.nearEmergencyButton()) return; // only at the cafeteria console
    this.emergenciesUsed++;
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

  // ---- vents (impostor only) ----

  /** Draw every vent grate in the world. Impostors can tap them to enter, hop,
   *  or exit; crew see them as inert scenery. */
  private buildVents() {
    for (const v of VENTS) {
      const g = new Graphics();
      g.position.set(v.x, v.y);
      if (this.role === "impostor") {
        g.eventMode = "static";
        g.cursor = "pointer";
        g.on("pointertap", () => this.onVentTap(v.id));
      }
      // Sit just above the floor/grid (which are drawn opaque over the whole
      // walkable area) but below avatars — same layer bodies use.
      this.scene.addChildAt(g, this.scene.getChildIndex(this.doorGfx) + 1);
      this.ventGfx.set(v.id, g);
    }
    this.refreshVents();
  }

  private refreshVents() {
    const links = this.currentVentId ? ventById(this.currentVentId)?.links ?? [] : [];
    for (const [id, g] of this.ventGfx) {
      // Reachable = the vent you're in, or one linked to it while vented.
      const active = this.vented && (id === this.currentVentId || links.includes(id));
      drawVent(g, active);
    }
  }

  private onVentTap(id: string) {
    if (this.role !== "impostor" || !this.local.alive || this.frozen) return;
    if (!this.vented) {
      if (this.ventInRange(id)) this.enterVent(id);
      return;
    }
    if (id === this.currentVentId) this.exitVent();
    else if (ventById(this.currentVentId!)?.links.includes(id)) this.moveVent(id);
  }

  /** Q key / Vent button: enter the nearest vent, or exit if already vented. */
  private tryVent() {
    if (this.role !== "impostor" || !this.local.alive || this.frozen) return;
    if (this.vented) { this.exitVent(); return; }
    const near = this.nearestVent();
    if (near) this.enterVent(near.id);
  }

  private nearestVent(): VentDef | null {
    let best: VentDef | null = null;
    let bestD = VENT_RANGE * VENT_RANGE;
    for (const v of VENTS) {
      const d = dist2(this.local.x, this.local.y, v.x, v.y);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  private ventInRange(id: string): boolean {
    const v = ventById(id);
    return !!v && dist2(this.local.x, this.local.y, v.x, v.y) <= VENT_RANGE * VENT_RANGE;
  }

  private enterVent(id: string) {
    const v = ventById(id);
    if (!v) return;
    this.vented = true;
    this.playVentAnim(id);
    this.moveToVent(v);
    this.refreshVents();
    this.buildVentNav();
  }

  private moveVent(id: string) {
    const v = ventById(id);
    if (!v) return;
    this.playVentAnim(id);
    this.moveToVent(v);
    this.refreshVents();
    this.buildVentNav();
  }

  private exitVent() {
    if (this.currentVentId) this.playVentAnim(this.currentVentId);
    this.vented = false;
    this.currentVentId = null;
    this.refreshVents();
    this.clearVentNav();
  }

  /** Kick off a quick "grate pops open" tween on a vent's graphic. */
  private playVentAnim(id: string) {
    const g = this.ventGfx.get(id);
    if (!g) return;
    if (!this.ventAnims.some((a) => a.g === g)) this.ventAnims.push({ g, t: 0 });
  }

  /** Advance the vent-open tweens: a brief pop (scale up) that settles back. */
  private updateVentAnims(dt: number) {
    const DURATION = 0.28;
    for (let i = this.ventAnims.length - 1; i >= 0; i--) {
      const anim = this.ventAnims[i]!;
      anim.t += dt;
      const p = Math.min(1, anim.t / DURATION);
      const pop = 1 + 0.45 * Math.sin(p * Math.PI); // 1 → 1.45 → 1
      anim.g.scale.set(pop);
      if (p >= 1) {
        anim.g.scale.set(1);
        this.ventAnims.splice(i, 1);
      }
    }
  }

  private moveToVent(v: VentDef) {
    this.currentVentId = v.id;
    this.local.x = v.x;
    this.local.y = v.y;
    this.local.vx = 0;
    this.local.vy = 0;
    this.local.container.position.set(v.x, v.y);
  }

  /** Build the on-screen vent-navigation panel: an Exit button plus one button
   *  per connected vent (labelled with a direction arrow + destination room). */
  private buildVentNav() {
    const v = this.currentVentId ? ventById(this.currentVentId) : undefined;
    if (!v) return this.clearVentNav();
    if (!this.ventNav) {
      this.ventNav = document.createElement("div");
      this.ventNav.id = "vent-nav";
      this.ventNav.className = "vent-nav";
      document.body.appendChild(this.ventNav);
    }
    this.ventNav.replaceChildren();

    for (const linkId of v.links) {
      const dest = ventById(linkId);
      if (!dest) continue;
      const btn = document.createElement("button");
      btn.className = "vent-btn";
      btn.textContent = `${arrow(v.x, v.y, dest.x, dest.y)}  ${dest.room}`;
      btn.addEventListener("click", () => this.moveVent(linkId));
      this.ventNav.appendChild(btn);
    }
    const exit = document.createElement("button");
    exit.className = "vent-btn exit";
    exit.textContent = "Exit Vent (Q)";
    exit.addEventListener("click", () => this.exitVent());
    this.ventNav.appendChild(exit);
  }

  private clearVentNav() {
    this.ventNav?.remove();
    this.ventNav = undefined;
  }

  // ---- security cameras (open at the console with C) ----
  //
  // A camera simply relocates the player's viewport to the camera's spot, so the
  // live scene renders from there (vision cast from the camera, not the player),
  // zoomed in so you see ~25% less. Only one feed shows at a time; ← / → cycle
  // between them. The player stays put at the console (frozen) while watching.

  /** C: toggle the cameras, but only at the Security console. */
  private tryToggleCameras() {
    if (this.camsOpen) { this.closeCameras(); return; }
    if (this.frozen || !this.local.alive) return;
    if (!this.nearSecurityConsole()) return;
    this.camsOpen = true;
    this.camIndex = 0;
    this.showCamHud();
    this.updateCamHud();
  }

  private closeCameras() {
    if (!this.camsOpen) return;
    this.camsOpen = false;
    this.camHud?.classList.add("hidden");
  }

  /** ← / → move to the previous / next camera feed (wraps around). */
  private switchCamera(dir: 1 | -1) {
    if (!this.camsOpen || CAMERAS.length === 0) return;
    this.camIndex = (this.camIndex + dir + CAMERAS.length) % CAMERAS.length;
    this.updateCamHud();
  }

  /** The current camera's eye — the world point the viewport looks from. */
  private camEye(): { x: number; y: number } {
    return CAMERAS[this.camIndex]?.eye ?? this.local;
  }

  private showCamHud() {
    if (!this.camHud) {
      this.camHud = document.createElement("div");
      this.camHud.id = "cam-hud";
      this.camHud.className = "cam-hud";
      this.camHud.innerHTML = `
        <div class="cam-scanlines"></div>
        <div class="cam-top">
          <span class="cam-rec">● REC</span>
          <span id="cam-name" class="cam-name">CAM</span>
        </div>
        <div class="cam-help">◄ ►  switch camera　·　C  exit</div>`;
      document.body.appendChild(this.camHud);
    }
    this.camHud.classList.remove("hidden");
  }

  private updateCamHud() {
    const nameEl = this.camHud?.querySelector("#cam-name");
    if (nameEl) {
      const cam = CAMERAS[this.camIndex];
      nameEl.textContent = `CAM ${this.camIndex + 1}/${CAMERAS.length} · ${cam?.name ?? ""}`;
    }
  }

  private nearSecurityConsole(): boolean {
    return dist2(this.local.x, this.local.y, SECURITY_CONSOLE.x, SECURITY_CONSOLE.y)
      <= SECURITY_RANGE * SECURITY_RANGE;
  }

  private updateActionButtons() {
    if (this.btnKill) {
      const show = this.role === "impostor" && this.local.alive && !this.vented;
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
      const show = this.local.alive && !this.vented;
      this.btnReport.style.display = show ? "" : "none";
      if (show) this.btnReport.disabled = this.frozen || this.nearestBody() === null;
    }
    if (this.btnEmergency) {
      const show = this.local.alive && !this.vented;
      this.btnEmergency.style.display = show ? "" : "none";
      if (show) {
        const outOfMeetings = this.emergenciesUsed >= this.emergenciesPerPlayer;
        const cooldown = Math.ceil((this.emergencyReadyAt - now()) / 1000);
        const near = this.nearEmergencyButton();
        this.btnEmergency.disabled =
          this.frozen || outOfMeetings || cooldown > 0 || !near;
        this.btnEmergency.textContent = outOfMeetings
          ? "No meetings"
          : cooldown > 0
            ? `Wait ${cooldown}s`
            : near
              ? "Emergency"
              : "Go to button";
      }
    }
    if (this.btnVent) {
      const show = this.role === "impostor" && this.local.alive;
      this.btnVent.style.display = show ? "" : "none";
      if (show) {
        const near = this.vented || this.nearestVent() !== null;
        this.btnVent.disabled = this.frozen || !near;
        this.btnVent.textContent = this.vented ? "Exit Vent" : "Vent";
      }
    }
  }

  private wireActionButtons() {
    this.btnKill = document.getElementById("btn-kill") as HTMLButtonElement | null ?? undefined;
    this.btnReport = document.getElementById("btn-report") as HTMLButtonElement | null ?? undefined;
    this.btnEmergency = document.getElementById("btn-emergency") as HTMLButtonElement | null ?? undefined;
    this.btnVent = document.getElementById("btn-vent") as HTMLButtonElement | null ?? undefined;
    document.getElementById("actions")?.classList.remove("hidden");
    this.btnKill?.addEventListener("click", () => this.tryKill());
    this.btnReport?.addEventListener("click", () => this.tryReport());
    this.btnEmergency?.addEventListener("click", () => this.tryEmergency());
    this.btnVent?.addEventListener("click", () => this.tryVent());
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

    // Crew: mark each task with a "!" on the minimap.
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
    if (this.vented) this.exitVent(); // meetings eject you from a vent
    this.closeCameras();
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
    this.killReadyAt = now() + this.killCooldownMs; // cooldowns reset after meetings
    this.emergencyReadyAt = now() + this.emergencyCooldownMs;
  }

  // ---- network callbacks ----

  applyState(players: PlayerState[]) {
    for (const p of players) {
      if (p.id === this.myId) continue;
      if (!this.roster.has(p.id)) this.roster.set(p.id, { id: p.id, name: p.name, color: p.color });
      const av = this.ensureAvatar(p.id);
      if (av) { av.targetX = p.x; av.targetY = p.y; av.vx = p.vx; av.vy = p.vy; av.vented = !!p.vented; }
    }
  }

  applyInput(id: PeerId, x: number, y: number, vx: number, vy: number, vented = false) {
    const av = this.ensureAvatar(id);
    if (av) { av.targetX = x; av.targetY = y; av.vx = vx; av.vy = vy; av.vented = vented; }
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
    if (this.vented) this.exitVent(); // can't stay in a vent once dead
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
    this.clearVentNav();
    this.camHud?.remove();
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

/** Draw a vent grate (a slatted cover) at the origin. `active` highlights vents
 *  you can currently hop into. */
function drawVent(g: Graphics, active: boolean) {
  const w = 44;
  const h = 34;
  g.clear();
  g.roundRect(-w / 2, -h / 2, w, h, 5)
    .fill(active ? 0x3a1620 : 0x0c1018)
    .stroke({ width: 3, color: active ? IMPOSTOR_COLOR : 0x6f7bad });
  const slat = active ? 0xff8391 : 0x8a93ad;
  for (let i = -1; i <= 1; i++) {
    g.roundRect(-w / 2 + 7, i * 9 - 3, w - 14, 6, 2).fill(slat);
  }
}

/** Pick an arrow glyph pointing from (ax,ay) toward (bx,by). */
function arrow(ax: number, ay: number, bx: number, by: number): string {
  const glyphs = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];
  let a = Math.atan2(by - ay, bx - ax); // -PI..PI, 0 = east, +y is down
  if (a < 0) a += Math.PI * 2;
  const idx = Math.round(a / (Math.PI / 4)) % 8;
  return glyphs[idx];
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
