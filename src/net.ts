/**
 * PeerJS-based P2P transport in a star topology.
 *
 *   HOST   — its PeerJS id is derived from the room code. It accepts data-channel
 *            connections, owns the roster, and rebroadcasts world state.
 *   CLIENT — connects to the host, streams its own position up, and renders the
 *            state snapshots it receives back.
 *
 * `Net` hides the host/client asymmetry behind one small callback interface so
 * the rest of the game doesn't care which role it is running as.
 */

import { Peer } from "peerjs";
import type { DataConnection, PeerOptions } from "peerjs";
import {
  peerIdForRoom,
  DEFAULT_RULES,
  type GameRules,
  type MeetingPlayer,
  type NetMessage,
  type PeerId,
  type PlayerInfo,
  type PlayerState,
  type Role,
  type VoteTarget,
} from "./protocol";
import { assignTasks } from "./tasks";

export interface NetHandlers {
  /** Fired once the local peer is connected and has an identity. */
  onReady: (myId: PeerId) => void;
  /** Roster changed (someone joined/left). */
  onLobby: (players: PlayerInfo[]) => void;
  /** The host started the match; carries THIS peer's role, fellow impostors,
   *  and the total number of impostors (for the reveal). */
  onStart: (
    spawns: { x: number; y: number }[],
    role: Role,
    impostors: PeerId[],
    impostorCount: number,
    tasks: string[],
    rules: GameRules,
  ) => void;
  /** CLIENT ONLY: a fresh world snapshot arrived from the host. */
  onState: (players: PlayerState[]) => void;
  /** HOST ONLY: a client sent its latest position. */
  onInput: (id: PeerId, x: number, y: number, vx: number, vy: number, vented: boolean) => void;
  /** The set of currently-locked doors changed. `cooling` doors are open and
   *  cannot be closed again yet (close-cooldown). */
  onDoors: (locked: string[], cooling: string[]) => void;
  /** The match ended; `winner` is the winning team. */
  onGameOver: (winner: Role) => void;
  /** A player was killed; a body was placed at (x, y). */
  onKilled: (victim: PeerId, bodyId: string, x: number, y: number) => void;
  /** A meeting began (discussion phase). */
  onMeeting: (
    trigger: "report" | "emergency",
    calledBy: PeerId,
    players: MeetingPlayer[],
    discussionMs: number,
    votingMs: number,
  ) => void;
  /** Discussion ended; voting is open. */
  onVoting: () => void;
  /** A meeting chat message arrived (relayed by the host). */
  onChat: (from: PeerId, name: string, color: number, text: string) => void;
  /** Global task progress changed (done / total across all crew). */
  onTasks: (done: number, total: number) => void;
  /** The meeting resolved. */
  onMeetingResult: (
    ejected: PeerId | null,
    wasImpostor: boolean | null,
    tally: Record<string, number>,
  ) => void;
  /** Meeting closed; resume play. */
  onMeetingEnd: () => void;
  /** Host asked everyone to move to a new room code (host transfer / move-code).
   *  The peer whose id is `hostId` re-hosts `code`; everyone else rejoins it. */
  onMigrate: (code: string, hostId: PeerId) => void;
  /** The host removed you from the room. */
  onKicked: () => void;
  /** Fatal/soft networking error, surfaced to the UI. */
  onError: (message: string) => void;
}

/**
 * WebRTC ICE configuration built from Vite env vars.
 *
 * Always includes public STUN so direct connections work out of the box. If
 * TURN credentials are provided they are added as a fallback. Relay-only mode
 * (which hides IPs by routing everything through TURN) is OPT-IN via
 * VITE_ICE_RELAY_ONLY="true" — forcing it on without a working TURN server
 * silently breaks every connection, so it is never the default.
 *
 * Vars (prefixed VITE_ so Vite inlines them into the client bundle):
 *   VITE_TURN_URLS        comma-separated, e.g. "turns:host:5349?transport=tcp"
 *   VITE_TURN_USERNAME    TURN username
 *   VITE_TURN_CREDENTIAL  TURN credential
 *   VITE_ICE_RELAY_ONLY   set to "true" to force relay-only (needs a real TURN)
 */
function iceConfig(): RTCConfiguration {
  const env = import.meta.env;
  const iceServers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const turnUrls = (env.VITE_TURN_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: env.VITE_TURN_USERNAME ?? "",
      credential: env.VITE_TURN_CREDENTIAL ?? "",
    });
  }

  // Relay-only is explicit opt-in AND requires TURN to be present, otherwise it
  // would discard every candidate and connect to nobody.
  const relayOnly = turnUrls.length > 0 && env.VITE_ICE_RELAY_ONLY === "true";
  return relayOnly ? { iceServers, iceTransportPolicy: "relay" } : { iceServers };
}

/**
 * PeerJS options: the ICE config, plus an optional custom signaling server.
 * By default PeerJS uses its public cloud broker, which can be flaky; setting
 * VITE_PEER_HOST (and optionally PORT/PATH/KEY/SECURE) points at your own
 * PeerServer instead.
 */
function peerOptions(): PeerOptions {
  const env = import.meta.env;
  const opts: PeerOptions = { config: iceConfig() };
  const host = (env.VITE_PEER_HOST ?? "").trim();
  if (host) {
    opts.host = host;
    opts.secure = env.VITE_PEER_SECURE !== "false";
    if (env.VITE_PEER_PORT) opts.port = Number(env.VITE_PEER_PORT);
    if (env.VITE_PEER_PATH) opts.path = env.VITE_PEER_PATH;
    if (env.VITE_PEER_KEY) opts.key = env.VITE_PEER_KEY;
  }
  return opts;
}

/** How long a sabotaged door stays locked, in ms. */
const DOOR_LOCK_MS = 10_000;
/** After a door opens, it cannot be closed again for this long. */
const DOOR_CLOSE_COOLDOWN_MS = 20_000;
/** Meeting phase durations. Voting always runs the full minute — votes are not
 *  locked in until it ends, so players may change their mind until time's up. */
const DISCUSSION_MS = 30_000;
const VOTING_MS = 60_000;
const RESULT_MS = 5_000;

export class Net {
  readonly isHost: boolean;
  myId: PeerId = "";

  private peer: Peer;
  private handlers: NetHandlers;
  private me: PlayerInfo;

  /** HOST: roster keyed by peer id, including the host itself. */
  private roster = new Map<PeerId, PlayerInfo>();
  /** HOST: open connections keyed by the joiner's peer id. */
  private conns = new Map<PeerId, DataConnection>();
  /** CLIENT: the single connection to the host. */
  private hostConn: DataConnection | null = null;
  /** Set in dispose() so a torn-down Net stops firing handlers (important during
   *  a migration, where the old Net is disposed while a new one is coming up). */
  private disposed = false;
  /** Watchdog: if the peer never opens (e.g. the signaling server is down), fire
   *  a clear error instead of leaving the UI stuck on "Connecting…". */
  private openTimer?: ReturnType<typeof setTimeout>;

  private started = false;
  private lastSpawns: { x: number; y: number }[] = [];
  /** HOST: role assigned to each player at match start. */
  private roleMap = new Map<PeerId, Role>();
  /** HOST: ids of all impostors this match. */
  private impostorIds: PeerId[] = [];
  /** HOST: currently-locked doors and their auto-unlock timers. */
  private lockedDoors = new Set<string>();
  private doorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** HOST: doors that recently opened and are on a close-cooldown, with their
   *  cooldown-expiry timers. A door cannot be closed while it is cooling. */
  private coolingDoors = new Set<string>();
  private cooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** HOST: set once a win condition fires, to stop further evaluation. */
  private ended = false;

  /** HOST: dead players (killed or ejected). */
  private dead = new Set<PeerId>();
  /** HOST: outstanding bodies, keyed by body id. */
  private bodies = new Map<string, { victim: PeerId; x: number; y: number }>();
  private bodyCounter = 0;
  /** HOST: how many emergency meetings each player has called this match. */
  private emergencyCount = new Map<PeerId, number>();
  /** HOST: timestamp (ms) of the last meeting end / round start — emergencies are
   *  on cooldown until `emergencyCooldownMs` after this. */
  private lastMeetingAt = 0;
  /** Match rules. On the host these are authoritative and edited via the console;
   *  clients receive the host's copy in the start message. */
  private rules: GameRules = { ...DEFAULT_RULES };
  /** HOST: meeting state. */
  private meetingActive = false;
  private votingPhase = false;
  private votes = new Map<PeerId, VoteTarget>();
  private meetingTimers: ReturnType<typeof setTimeout>[] = [];
  /** HOST: assigned task ids per crew player (their personal sequence). */
  private taskAssign = new Map<PeerId, string[]>();
  /** HOST: completed task ids per crew player. */
  private taskDone = new Map<PeerId, Set<string>>();

  private constructor(
    isHost: boolean,
    peer: Peer,
    me: PlayerInfo,
    handlers: NetHandlers,
  ) {
    this.isHost = isHost;
    this.peer = peer;
    this.me = me;
    this.handlers = handlers;
  }

  // ---- factories ----

  static host(code: string, name: string, color: number, handlers: NetHandlers): Net {
    const peer = new Peer(peerIdForRoom(code), peerOptions());
    const me: PlayerInfo = { id: "", name, color };
    const net = new Net(true, peer, me, handlers);
    net.armOpenWatchdog();

    peer.on("open", (id) => {
      net.clearOpenWatchdog();
      net.myId = id;
      me.id = id;
      net.roster.set(id, me);
      handlers.onReady(id);
      handlers.onLobby(net.playerList());
    });
    peer.on("connection", (conn) => net.acceptConnection(conn));
    peer.on("error", (err) => { if (!net.disposed) net.reportPeerError(err); });
    return net;
  }

  static join(code: string, name: string, color: number, handlers: NetHandlers): Net {
    const peer = new Peer(peerOptions());
    const me: PlayerInfo = { id: "", name, color };
    const net = new Net(false, peer, me, handlers);
    net.armOpenWatchdog();

    peer.on("open", (id) => {
      net.clearOpenWatchdog();
      net.myId = id;
      me.id = id;
      const conn = peer.connect(peerIdForRoom(code), { reliable: true });
      net.hostConn = conn;
      conn.on("open", () => {
        conn.send({ t: "join", name, color });
        handlers.onReady(id);
      });
      conn.on("data", (data) => net.onClientData(data as NetMessage));
      conn.on("close", () => { if (!net.disposed) handlers.onError("Disconnected from host."); });
      conn.on("error", () => { if (!net.disposed) handlers.onError("Connection to host failed."); });
    });
    peer.on("error", (err) => { if (!net.disposed) net.reportPeerError(err); });
    return net;
  }

  private armOpenWatchdog() {
    this.openTimer = setTimeout(() => {
      if (this.disposed) return;
      this.handlers.onError("Couldn't reach the signaling server. Check your connection and try again.");
    }, 15_000);
  }

  private clearOpenWatchdog() {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = undefined;
  }

  // ---- host side ----

  private acceptConnection(conn: DataConnection) {
    conn.on("data", (data) => this.onHostData(conn, data as NetMessage));
    conn.on("close", () => { if (!this.disposed) this.removePlayer(conn.peer); });
    conn.on("error", () => { if (!this.disposed) this.removePlayer(conn.peer); });
  }

  private onHostData(conn: DataConnection, msg: NetMessage) {
    switch (msg.t) {
      case "join": {
        const info: PlayerInfo = { id: conn.peer, name: msg.name, color: msg.color };
        this.roster.set(conn.peer, info);
        this.conns.set(conn.peer, conn);
        // Greet the newcomer, then tell everyone about the new roster.
        conn.send({
          t: "welcome",
          you: conn.peer,
          hostId: this.myId,
          players: this.playerList(),
          started: this.started,
        });
        if (this.started) {
          // Late joiner: assign crew (with their own task sequence) and send
          // them into the running match.
          if (!this.roleMap.has(conn.peer)) this.roleMap.set(conn.peer, "crew");
          const role = this.roleMap.get(conn.peer)!;
          if (role === "crew" && !this.taskAssign.has(conn.peer)) {
            this.taskAssign.set(conn.peer, assignTasks(Math.random));
          }
          conn.send({
            t: "start",
            spawns: this.lastSpawns,
            role,
            impostors: role === "impostor" ? this.impostorIds : [],
            impostorCount: this.impostorIds.length,
            tasks: this.taskAssign.get(conn.peer) ?? [],
          });
          conn.send({ t: "doors", locked: [...this.lockedDoors], cooling: [...this.coolingDoors] });
          const { done, total } = this.taskCounts();
          conn.send({ t: "tasks", done, total });
        }
        this.broadcast({ t: "lobby", players: this.playerList() });
        // Also update the HOST's own view/roster — without this the host never
        // learns about joiners and spawns no avatars for them at match start.
        this.handlers.onLobby(this.playerList());
        break;
      }
      case "input": {
        // The host only honors a "vented" (hidden) flag from impostors.
        const vented = this.roleMap.get(conn.peer) === "impostor" && !!msg.vented;
        this.handlers.onInput(conn.peer, msg.x, msg.y, msg.vx, msg.vy, vented);
        break;
      }
      case "sabotage_door":
        // Only impostors may lock doors.
        if (this.roleMap.get(conn.peer) === "impostor") this.lockDoor(msg.doorId);
        break;
      case "kill":
        this.hostKill(conn.peer, msg.victim, msg.x, msg.y);
        break;
      case "report":
        this.hostReport(conn.peer, msg.bodyId);
        break;
      case "emergency":
        this.hostEmergency(conn.peer);
        break;
      case "vote":
        this.hostVote(conn.peer, msg.target);
        break;
      case "chat":
        this.hostChat(conn.peer, msg.text);
        break;
      case "task_done":
        this.hostTaskDone(conn.peer, msg.taskId);
        break;
      default:
        break; // hosts ignore other message kinds
    }
  }

  private removePlayer(id: PeerId) {
    if (!this.roster.has(id)) return;
    this.roster.delete(id);
    this.conns.delete(id);
    this.taskDone.delete(id);
    this.broadcast({ t: "leave", id });
    this.broadcast({ t: "lobby", players: this.playerList() });
    this.handlers.onLobby(this.playerList());
    if (this.started) this.broadcastTaskProgress();
    this.checkWinCondition();
  }

  /**
   * HOST: evaluate win conditions over the ALIVE roster.
   *   - crew win: every impostor is dead/gone.
   *   - impostor win: crew worn down to a 1:1 ratio (crew ≤ impostors).
   */
  private checkWinCondition() {
    if (!this.started || this.ended) return;
    let impostors = 0;
    let crew = 0;
    for (const id of this.roster.keys()) {
      if (this.dead.has(id)) continue;
      if (this.roleMap.get(id) === "impostor") impostors++;
      else crew++;
    }
    if (impostors === 0) this.endMatch("crew");
    else if (crew <= impostors) this.endMatch("impostor");
  }

  private endMatch(winner: Role) {
    if (this.ended) return;
    this.ended = true;
    this.broadcast({ t: "gameover", winner });
    this.handlers.onGameOver(winner);
  }

  // ---- kill / report / emergency / voting (public request API) ----

  /** Impostor: kill `victim`, who is at (x, y). */
  requestKill(victim: PeerId, x: number, y: number) {
    if (this.isHost) this.hostKill(this.myId, victim, x, y);
    else this.hostConn?.send({ t: "kill", victim, x, y });
  }

  /** Report a discovered body to trigger a meeting. */
  requestReport(bodyId: string) {
    if (this.isHost) this.hostReport(this.myId, bodyId);
    else this.hostConn?.send({ t: "report", bodyId });
  }

  /** Call an emergency meeting. */
  requestEmergency() {
    if (this.isHost) this.hostEmergency(this.myId);
    else this.hostConn?.send({ t: "emergency" });
  }

  /** Cast a vote during the voting phase. */
  requestVote(target: VoteTarget) {
    if (this.isHost) this.hostVote(this.myId, target);
    else this.hostConn?.send({ t: "vote", target });
  }

  /** Report a completed task. */
  requestTaskDone(taskId: string) {
    if (this.isHost) this.hostTaskDone(this.myId, taskId);
    else this.hostConn?.send({ t: "task_done", taskId });
  }

  /** Send a chat message during a meeting. */
  requestChat(text: string) {
    if (this.isHost) this.hostChat(this.myId, text);
    else this.hostConn?.send({ t: "chat", from: this.myId, name: this.me.name, color: this.me.color, text });
  }

  // ---- host authority for the above ----

  private hostKill(killer: PeerId, victim: PeerId, x: number, y: number) {
    if (!this.isHost || this.meetingActive || this.ended) return;
    if (this.roleMap.get(killer) !== "impostor") return; // only impostors kill
    if (!this.roster.has(victim) || this.dead.has(victim)) return;
    if (this.roleMap.get(victim) === "impostor") return; // no friendly fire

    this.dead.add(victim);
    const bodyId = "b" + this.bodyCounter++;
    this.bodies.set(bodyId, { victim, x, y });
    this.broadcast({ t: "body", bodyId, victim, x, y });
    this.handlers.onKilled(victim, bodyId, x, y);
    this.checkWinCondition();
  }

  private hostReport(reporter: PeerId, bodyId: string) {
    if (!this.isHost || this.meetingActive || this.ended) return;
    if (this.dead.has(reporter) || !this.bodies.has(bodyId)) return;
    this.startMeeting("report", reporter);
  }

  private hostEmergency(caller: PeerId) {
    if (!this.isHost || this.meetingActive || this.ended) return;
    if (this.dead.has(caller)) return;
    // Per-player emergency limit.
    const used = this.emergencyCount.get(caller) ?? 0;
    if (used >= this.rules.emergenciesPerPlayer) return;
    // Shared cooldown since the last meeting (and since round start).
    if (Date.now() - this.lastMeetingAt < this.rules.emergencyCooldownMs) return;
    this.emergencyCount.set(caller, used + 1);
    this.startMeeting("emergency", caller);
  }

  private hostVote(voter: PeerId, target: VoteTarget) {
    if (!this.isHost || !this.votingPhase) return;
    if (this.dead.has(voter)) return; // alive players only
    // Not locked in: overwrite freely until the voting timer expires. The tally
    // is taken only in finishVoting(), so there is no early finish here.
    this.votes.set(voter, target);
  }

  /** HOST: relay a meeting chat line to everyone, stamped with the sender's
   *  roster identity so names/colors can't be spoofed. */
  private hostChat(from: PeerId, text: string) {
    if (!this.isHost || !this.meetingActive) return;
    const info = this.roster.get(from);
    if (!info) return;
    const clean = text.trim().slice(0, 200);
    if (!clean) return;
    const msg = { t: "chat" as const, from, name: info.name, color: info.color, text: clean };
    this.broadcast(msg);
    this.handlers.onChat(from, info.name, info.color, clean);
  }

  /** HOST: record a crew task completion, then broadcast progress + check the
   *  crew win. Ghosts (dead crew) still count — they must finish their tasks. */
  private hostTaskDone(player: PeerId, taskId: string) {
    if (!this.isHost || !this.started || this.ended) return;
    if (this.roleMap.get(player) !== "crew") return; // only crew have real tasks
    if (!this.taskAssign.get(player)?.includes(taskId)) return; // must be one of theirs
    let set = this.taskDone.get(player);
    if (!set) this.taskDone.set(player, (set = new Set()));
    set.add(taskId);
    this.broadcastTaskProgress();
  }

  /** HOST: current global task counts across the living-or-dead crew, using
   *  each crewmate's personally-assigned task list. */
  private taskCounts(): { done: number; total: number } {
    let done = 0;
    let total = 0;
    for (const id of this.roster.keys()) {
      if (this.roleMap.get(id) !== "crew") continue;
      const assigned = this.taskAssign.get(id);
      if (!assigned) continue;
      total += assigned.length;
      const doneSet = this.taskDone.get(id);
      if (doneSet) done += assigned.filter((t) => doneSet.has(t)).length;
    }
    return { done, total };
  }

  private broadcastTaskProgress() {
    const { done, total } = this.taskCounts();
    this.broadcast({ t: "tasks", done, total });
    this.handlers.onTasks(done, total);
    if (this.started && !this.ended && total > 0 && done >= total) this.endMatch("crew");
  }

  // ---- host meeting state machine ----

  private startMeeting(trigger: "report" | "emergency", calledBy: PeerId) {
    this.meetingActive = true;
    this.votingPhase = false;
    this.votes.clear();
    this.bodies.clear(); // bodies are cleared when a meeting starts

    const players: MeetingPlayer[] = this.playerList().map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      alive: !this.dead.has(p.id),
    }));

    this.broadcast({
      t: "meeting", trigger, calledBy, players,
      discussionMs: DISCUSSION_MS, votingMs: VOTING_MS,
    });
    this.handlers.onMeeting(trigger, calledBy, players, DISCUSSION_MS, VOTING_MS);

    this.meetingTimers.push(setTimeout(() => this.openVoting(), DISCUSSION_MS));
  }

  private openVoting() {
    this.votingPhase = true;
    this.broadcast({ t: "voting" });
    this.handlers.onVoting();
    this.meetingTimers.push(setTimeout(() => this.finishVoting(), VOTING_MS));
  }

  private finishVoting() {
    if (!this.meetingActive || !this.votingPhase) return;
    this.votingPhase = false;
    this.clearMeetingTimers();

    // Tally.
    const tally: Record<string, number> = {};
    for (const target of this.votes.values()) tally[target] = (tally[target] ?? 0) + 1;

    // Highest unique target (excluding skip) is ejected; tie/skip → nobody.
    let ejected: PeerId | null = null;
    let top = 0;
    let tie = false;
    for (const [target, count] of Object.entries(tally)) {
      if (target === "skip") continue;
      if (count > top) { top = count; ejected = target; tie = false; }
      else if (count === top) tie = true;
    }
    const skip = tally["skip"] ?? 0;
    if (tie || ejected === null || top <= skip) ejected = null;

    let wasImpostor: boolean | null = null;
    if (ejected) {
      this.dead.add(ejected);
      wasImpostor = this.roleMap.get(ejected) === "impostor";
    }

    this.broadcast({ t: "meeting_result", ejected, ejectedWasImpostor: wasImpostor, tally });
    this.handlers.onMeetingResult(ejected, wasImpostor, tally);

    this.meetingTimers.push(setTimeout(() => this.endMeeting(), RESULT_MS));
  }

  private endMeeting() {
    this.meetingActive = false;
    this.clearMeetingTimers();
    this.lastMeetingAt = Date.now(); // emergency cooldown restarts after a meeting
    this.resetDoors(); // doors are open + immediately closable coming out of a meeting
    this.broadcast({ t: "meeting_end" });
    this.handlers.onMeetingEnd();
    this.checkWinCondition();
  }

  private clearMeetingTimers() {
    for (const t of this.meetingTimers) clearTimeout(t);
    this.meetingTimers = [];
  }

  /** HOST or CLIENT(impostor): request that a door be locked. */
  requestSabotageDoor(doorId: string) {
    if (this.isHost) this.lockDoor(doorId);
    else this.hostConn?.send({ t: "sabotage_door", doorId });
  }

  /** HOST: lock a door for a fixed duration, then auto-unlock. A door that is
   *  already closed, or still on its close-cooldown from a recent open, cannot
   *  be closed. */
  private lockDoor(doorId: string) {
    if (!this.isHost) return;
    if (this.lockedDoors.has(doorId) || this.coolingDoors.has(doorId)) return;
    this.lockedDoors.add(doorId);
    this.broadcastDoors();
    const prev = this.doorTimers.get(doorId);
    if (prev) clearTimeout(prev);
    this.doorTimers.set(
      doorId,
      setTimeout(() => {
        this.doorTimers.delete(doorId);
        this.openDoor(doorId);
      }, DOOR_LOCK_MS),
    );
  }

  /** HOST: open a door and start its close-cooldown (it cannot be closed again
   *  until the cooldown expires). */
  private openDoor(doorId: string) {
    this.lockedDoors.delete(doorId);
    this.coolingDoors.add(doorId);
    const prev = this.cooldownTimers.get(doorId);
    if (prev) clearTimeout(prev);
    this.cooldownTimers.set(
      doorId,
      setTimeout(() => {
        this.coolingDoors.delete(doorId);
        this.cooldownTimers.delete(doorId);
        this.broadcastDoors();
      }, DOOR_CLOSE_COOLDOWN_MS),
    );
    this.broadcastDoors();
  }

  private broadcastDoors() {
    const locked = [...this.lockedDoors];
    const cooling = [...this.coolingDoors];
    this.broadcast({ t: "doors", locked, cooling });
    this.handlers.onDoors(locked, cooling);
  }

  /**
   * HOST: assign roles and start the match. Picks `impostorCount` impostors at
   * random from the roster and sends each player a start message tailored to
   * their role (crew never learn who the impostors are).
   */
  startMatch(spawns: { x: number; y: number }[]) {
    if (!this.isHost) return;

    const ids = this.playerList().map((p) => p.id);
    const count = Math.max(1, Math.min(Math.floor(this.rules.impostorCount), ids.length));
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    this.impostorIds = shuffled.slice(0, count);
    const impSet = new Set(this.impostorIds);
    this.roleMap = new Map(ids.map((id) => [id, impSet.has(id) ? "impostor" : "crew"]));

    this.started = true;
    this.lastSpawns = spawns;

    // Reset emergency tracking; the round-start cooldown runs from now.
    this.emergencyCount.clear();
    this.lastMeetingAt = Date.now();

    // Deal each crewmate their own random task sequence.
    this.taskAssign.clear();
    this.taskDone.clear();
    for (const id of ids) {
      if (this.roleMap.get(id) === "crew") this.taskAssign.set(id, assignTasks(Math.random));
    }

    const impostorCount = this.impostorIds.length;
    for (const [id, conn] of this.conns) {
      const role = this.roleMap.get(id) ?? "crew";
      conn.send({
        t: "start",
        spawns,
        role,
        impostors: role === "impostor" ? this.impostorIds : [],
        impostorCount,
        tasks: this.taskAssign.get(id) ?? [],
        rules: this.rules,
      });
    }

    // Doors all start open and immediately closable (no start-of-match cooldown).
    this.resetDoors();

    const myRole = this.roleMap.get(this.myId) ?? "crew";
    this.handlers.onStart(
      spawns,
      myRole,
      myRole === "impostor" ? this.impostorIds : [],
      impostorCount,
      this.taskAssign.get(this.myId) ?? [],
      this.rules,
    );

    this.broadcastTaskProgress(); // initial 0 / total bar
  }

  /** HOST: update the match rules (from the host console). */
  setRules(rules: GameRules) {
    this.rules = { ...rules };
  }

  getRules(): GameRules {
    return this.rules;
  }

  // ---- host lobby controls: kick / migrate ----

  /** HOST: remove a player from the room. */
  kick(id: PeerId) {
    if (!this.isHost || id === this.myId) return;
    const conn = this.conns.get(id);
    if (conn && conn.open) conn.send({ t: "kicked" });
    this.removePlayer(id); // updates roster + broadcasts to everyone else
    if (conn) setTimeout(() => conn.close(), 150);
  }

  /** HOST: tell everyone to reconnect to a new room code. `hostId` becomes the
   *  new host. The caller then tears down this Net and reconnects (see main). */
  announceMigrate(code: string, hostId: PeerId) {
    if (!this.isHost) return;
    this.broadcast({ t: "migrate", code, hostId });
  }

  /** HOST: clear all door state so every door is open and immediately closable
   *  (no lingering lock or close-cooldown). Used at match start and after each
   *  meeting. */
  private resetDoors() {
    for (const t of this.doorTimers.values()) clearTimeout(t);
    this.doorTimers.clear();
    for (const t of this.cooldownTimers.values()) clearTimeout(t);
    this.cooldownTimers.clear();
    this.lockedDoors.clear();
    this.coolingDoors.clear();
    this.broadcastDoors();
  }

  /** Reset all per-match state so the room can start a fresh round. Keeps the
   *  peer connections and roster intact; the host can immediately start again.
   *  Each peer calls this locally (a few seconds after game-over). */
  resetMatch() {
    this.started = false;
    this.ended = false;
    this.roleMap.clear();
    this.impostorIds = [];
    this.dead.clear();
    this.bodies.clear();
    this.bodyCounter = 0;
    this.emergencyCount.clear();
    this.meetingActive = false;
    this.votingPhase = false;
    this.votes.clear();
    this.clearMeetingTimers();
    this.taskAssign.clear();
    this.taskDone.clear();
    this.lockedDoors.clear();
    for (const t of this.doorTimers.values()) clearTimeout(t);
    this.doorTimers.clear();
    this.coolingDoors.clear();
    for (const t of this.cooldownTimers.values()) clearTimeout(t);
    this.cooldownTimers.clear();
  }

  /** HOST: push the combined world snapshot to all clients. */
  broadcastState(players: PlayerState[]) {
    if (!this.isHost) return;
    this.broadcast({ t: "state", players });
  }

  private broadcast(msg: NetMessage) {
    for (const conn of this.conns.values()) {
      if (conn.open) conn.send(msg);
    }
  }

  // ---- client side ----

  private onClientData(msg: NetMessage) {
    switch (msg.t) {
      case "welcome":
        this.handlers.onLobby(msg.players);
        if (msg.started) this.started = true;
        break;
      case "lobby":
        this.handlers.onLobby(msg.players);
        break;
      case "start":
        this.started = true;
        this.handlers.onStart(msg.spawns, msg.role, msg.impostors, msg.impostorCount, msg.tasks, msg.rules);
        break;
      case "state":
        this.handlers.onState(msg.players);
        break;
      case "doors":
        this.handlers.onDoors(msg.locked, msg.cooling);
        break;
      case "gameover":
        this.handlers.onGameOver(msg.winner);
        break;
      case "body":
        this.handlers.onKilled(msg.victim, msg.bodyId, msg.x, msg.y);
        break;
      case "meeting":
        this.handlers.onMeeting(msg.trigger, msg.calledBy, msg.players, msg.discussionMs, msg.votingMs);
        break;
      case "voting":
        this.handlers.onVoting();
        break;
      case "chat":
        this.handlers.onChat(msg.from, msg.name, msg.color, msg.text);
        break;
      case "tasks":
        this.handlers.onTasks(msg.done, msg.total);
        break;
      case "meeting_result":
        this.handlers.onMeetingResult(msg.ejected, msg.ejectedWasImpostor, msg.tally);
        break;
      case "meeting_end":
        this.handlers.onMeetingEnd();
        break;
      case "migrate":
        this.handlers.onMigrate(msg.code, msg.hostId);
        break;
      case "kicked":
        this.handlers.onKicked();
        break;
      case "leave":
        break; // roster refresh arrives via the following "lobby"
      default:
        break;
    }
  }

  /** CLIENT: send our latest predicted position to the host. */
  sendInput(x: number, y: number, vx: number, vy: number, vented = false) {
    if (this.isHost || !this.hostConn || !this.hostConn.open) return;
    this.hostConn.send({ t: "input", x, y, vx, vy, vented });
  }

  // ---- shared ----

  /** Current roster in a stable order (host first). */
  playerList(): PlayerInfo[] {
    const list = [...this.roster.values()];
    list.sort((a, b) => (a.id === this.myId ? -1 : b.id === this.myId ? 1 : 0));
    return list;
  }

  me_(): PlayerInfo {
    return this.me;
  }

  private reportPeerError(err: unknown) {
    const type = (err as { type?: string })?.type;
    if (type === "unavailable-id") {
      this.handlers.onError("That room code is already in use. Try creating again.");
    } else if (type === "peer-unavailable") {
      this.handlers.onError("No game found with that room code.");
    } else {
      this.handlers.onError("Network error: " + (type ?? String(err)));
    }
  }

  dispose() {
    this.disposed = true;
    this.clearOpenWatchdog();
    for (const timer of this.doorTimers.values()) clearTimeout(timer);
    this.doorTimers.clear();
    for (const timer of this.cooldownTimers.values()) clearTimeout(timer);
    this.cooldownTimers.clear();
    this.clearMeetingTimers();
    for (const conn of this.conns.values()) conn.close();
    this.hostConn?.close();
    this.peer.destroy();
  }
}
