/**
 * Peer-to-peer message protocol.
 *
 * Topology: a star. One peer is the HOST (its PeerJS id is the room code);
 * every other peer connects directly to the host over a WebRTC data channel.
 * The host owns the roster and rebroadcasts world state. This keeps a single
 * consistent view without a dedicated server — good enough for the demo, and
 * a clean seam to later promote the host into an authoritative dedicated server.
 */

export type PeerId = string;

/** Which team a player is on. Assigned by the host at match start. */
export type Role = "crew" | "impostor";

/** Lobby-level info about a player. */
export interface PlayerInfo {
  id: PeerId;
  name: string;
  color: number;
}

/** A player's movement state, streamed during the match. */
export interface PlayerState {
  id: PeerId;
  name: string;
  color: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// ---- client (joiner) -> host ----

export interface JoinMsg {
  t: "join";
  name: string;
  color: number;
}

/** A joiner streaming its own predicted position up to the host. */
export interface InputMsg {
  t: "input";
  x: number;
  y: number;
  vx: number;
  vy: number;
}

// ---- host -> client ----

export interface WelcomeMsg {
  t: "welcome";
  you: PeerId;
  hostId: PeerId;
  players: PlayerInfo[];
  started: boolean;
}

export interface LobbyMsg {
  t: "lobby";
  players: PlayerInfo[];
}

export interface StartMsg {
  t: "start";
  /** Everyone spawns from this list, index by roster order. */
  spawns: { x: number; y: number }[];
  /** THIS recipient's secret role (tailored per connection). */
  role: Role;
  /** Fellow impostor ids — populated only when the recipient is an impostor. */
  impostors: PeerId[];
  /** How many impostors are in the match (shown to everyone in the reveal). */
  impostorCount: number;
  /** THIS recipient's assigned task ids, in order (crew only; empty for impostors). */
  tasks: string[];
}

/** Impostor -> host: request to lock a door via the sabotage map. */
export interface SabotageDoorMsg {
  t: "sabotage_door";
  doorId: string;
}

/** A vote target: a specific player, or an explicit skip. */
export type VoteTarget = PeerId | "skip";

/** A player as shown in the meeting UI. */
export interface MeetingPlayer {
  id: PeerId;
  name: string;
  color: number;
  alive: boolean;
}

/** Impostor -> host: kill request against a victim (with the victim's position
 *  so the host can place the body). */
export interface KillMsg {
  t: "kill";
  victim: PeerId;
  x: number;
  y: number;
}

/** Host -> clients: a kill happened; a body was placed. */
export interface BodyMsg {
  t: "body";
  bodyId: string;
  victim: PeerId;
  x: number;
  y: number;
}

/** Alive player -> host: report a discovered body. */
export interface ReportMsg {
  t: "report";
  bodyId: string;
}

/** Alive player -> host: call an emergency meeting. */
export interface EmergencyMsg {
  t: "emergency";
}

/** Host -> clients: a meeting has begun (discussion phase). */
export interface MeetingMsg {
  t: "meeting";
  trigger: "report" | "emergency";
  calledBy: PeerId;
  players: MeetingPlayer[];
  discussionMs: number;
  votingMs: number;
}

/** Host -> clients: discussion over, voting is open. */
export interface VotingMsg {
  t: "voting";
}

/** Alive player -> host: cast a vote. */
export interface VoteMsg {
  t: "vote";
  target: VoteTarget;
}

/** Meeting text chat. Sent up by a player (host stamps identity), then relayed
 *  by the host to everyone. */
export interface ChatMsg {
  t: "chat";
  from: PeerId;
  name: string;
  color: number;
  text: string;
}

/** Host -> clients: the meeting result. */
export interface MeetingResultMsg {
  t: "meeting_result";
  ejected: PeerId | null;
  ejectedWasImpostor: boolean | null;
  tally: Record<string, number>;
}

/** Host -> clients: meeting closed, resume play. */
export interface MeetingEndMsg {
  t: "meeting_end";
}

/** Crewmate -> host: a task was completed. */
export interface TaskDoneMsg {
  t: "task_done";
  taskId: string;
}

/** Host -> clients: global task progress (done / total across all crew). */
export interface TaskProgressMsg {
  t: "tasks";
  done: number;
  total: number;
}

/** Host -> clients: the current set of locked door ids, plus doors on a
 *  close-cooldown (recently opened; cannot be closed again yet). */
export interface DoorsMsg {
  t: "doors";
  locked: string[];
  cooling: string[];
}

/** Host -> clients: the match has ended. */
export interface GameOverMsg {
  t: "gameover";
  winner: Role;
}

/** Host's periodic snapshot of everyone's positions. */
export interface StateMsg {
  t: "state";
  players: PlayerState[];
}

export interface LeaveMsg {
  t: "leave";
  id: PeerId;
}

export type NetMessage =
  | JoinMsg
  | InputMsg
  | WelcomeMsg
  | LobbyMsg
  | StartMsg
  | StateMsg
  | LeaveMsg
  | SabotageDoorMsg
  | DoorsMsg
  | GameOverMsg
  | KillMsg
  | BodyMsg
  | ReportMsg
  | EmergencyMsg
  | MeetingMsg
  | VotingMsg
  | VoteMsg
  | ChatMsg
  | MeetingResultMsg
  | MeetingEndMsg
  | TaskDoneMsg
  | TaskProgressMsg;

/** Fixed palette of selectable player colors. */
export const PLAYER_COLORS = [
  0xff5b6e, // red
  0x5b8cff, // blue
  0x3ddc84, // green
  0xffd23d, // yellow
  0xc45bff, // purple
  0xff9f3d, // orange
  0x3ddce0, // cyan
  0xff8ad1, // pink
] as const;

/** Room codes are short + human-readable. Excludes ambiguous chars (0/O/1/I). */
export function generateRoomCode(rand: () => number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return code;
}

/** PeerJS id used for a given room code (namespaced to avoid broker collisions). */
export function peerIdForRoom(code: string): string {
  return `amongourselves-${code.toLowerCase()}`;
}
