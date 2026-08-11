/**
 * Entry point. Wires the lobby UI to the P2P transport and, once the match
 * starts, hands control to the Pixi game scene. The Net handlers are defined
 * once here and forward into whichever `Game` instance is live.
 */

import { Game } from "./game";
import { Lobby } from "./lobby";
import { Meeting } from "./meeting";
import { HostConsole } from "./hostconsole";
import { Net, type NetHandlers } from "./net";
import { MAP } from "./map";
import { generateRoomCode, type GameRules, type PeerId, type PlayerInfo, type Role } from "./protocol";

let net: Net | null = null;
let game: Game | null = null;
let myId = "";
let roomCode = "";
let isHost = false;
let roster: PlayerInfo[] = [];
let lastVotingMs = 30_000;

// Identity is preserved across a lobby migration (reconnecting to a new code).
let localName = "";
let localColor = 0;

// Migration state: while `migrating`, a transient disconnect is expected and we
// retry the join a few times rather than bailing to the menu.
let migrating = false;
let migrateJoinTries = 0;

const meeting = new Meeting({
  onVote: (target) => net?.requestVote(target),
  onChat: (text) => net?.requestChat(text),
});

const hostConsole = new HostConsole({
  onChange: (rules) => net?.setRules(rules),
});

const lobby = new Lobby({
  onHost: (name, color) => {
    localName = name;
    localColor = color;
    roomCode = generateRoomCode(Math.random);
    isHost = true;
    net = Net.host(roomCode, name, color, handlers);
  },
  onJoin: (code, name, color) => {
    localName = name;
    localColor = color;
    roomCode = code;
    isHost = false;
    net = Net.join(code, name, color, handlers);
  },
  onStart: () => {
    // Host only: push the latest rules, then kick off the match for everyone.
    net?.setRules(hostConsole.rules());
    net?.startMatch(MAP.spawns);
  },
  onOpenSettings: () => hostConsole.open(),
  onMoveRoom: () => startMigration(generateRoomCode(Math.random), myId),
  onNominate: (id) => startMigration(generateRoomCode(Math.random), id),
  onKick: (id) => net?.kick(id),
});

const handlers: NetHandlers = {
  onReady: (id) => {
    myId = id;
    migrating = false;
    migrateJoinTries = 0;
    if (isHost) net?.setRules(hostConsole.rules());
    lobby.enterRoom(roomCode, isHost);
  },
  onLobby: (players) => {
    roster = players;
    lobby.setPlayers(players);
    hostConsole.setPlayerCount(players.length);
    game?.updateRoster(players);
  },
  onStart: (spawns, role, impostors, impostorCount, tasks, rules) => {
    void startMatch(spawns, role, impostors, impostorCount, tasks, rules);
  },
  onState: (players) => game?.applyState(players),
  onInput: (id, x, y, vx, vy, vented) => game?.applyInput(id, x, y, vx, vy, vented),
  onDoors: (locked, cooling) => game?.setDoors(locked, cooling),
  onLights: (out, switches) => game?.setLights(out, switches),
  onCameras: (watched) => game?.setCamerasWatched(watched),
  onGameOver: (winner) => {
    meeting.close();
    showGameOver(winner);
    window.setTimeout(resetToLobby, 5000); // back to the room after 5s
  },
  onKilled: (victim, bodyId, x, y) => game?.applyKilled(victim, bodyId, x, y),
  onMeeting: (trigger, calledBy, players, discussionMs, votingMs) => {
    lastVotingMs = votingMs;
    game?.onMeetingStart();
    const name = roster.find((p) => p.id === calledBy)?.name ?? "Someone";
    meeting.startDiscussion(players, myId, trigger, name, discussionMs);
  },
  onVoting: () => meeting.startVoting(lastVotingMs),
  onChat: (_from, name, color, text) => meeting.addChat(name, color, text),
  onTasks: (done, total) => updateTaskbar(done, total),
  onMeetingResult: (ejected, wasImpostor, tally) => {
    game?.applyEject(ejected);
    meeting.showResult(ejected, wasImpostor, tally);
  },
  onMeetingEnd: () => {
    game?.onMeetingEnd();
    meeting.close();
  },
  onMigrate: (code, hostId) => reconnect(code, hostId),
  onKicked: () => {
    migrating = false;
    net?.dispose();
    net = null;
    lobby.resetMenu();
    lobby.status("You were removed from the room by the host.");
  },
  onError: (message) => {
    // During a migration a "no game found" is just the new host not being up
    // yet — retry the join a few times before giving up.
    if (migrating && !isHost && migrateJoinTries > 0) {
      migrateJoinTries--;
      net?.dispose();
      net = null;
      window.setTimeout(() => {
        net = Net.join(roomCode, localName, localColor, handlers);
      }, 1200);
      return;
    }
    migrating = false;
    lobby.status(message);
    lobby.resetMenu();
    net?.dispose();
    net = null;
  },
};

/** Host-initiated lobby migration: tell everyone to reconnect to `code` with
 *  `hostId` as the new host, then reconnect this peer too. */
function startMigration(code: string, hostId: PeerId) {
  if (!net?.isHost) return;
  net.announceMigrate(code, hostId);
  // Let the broadcast flush, then this peer tears down and reconnects as well.
  window.setTimeout(() => reconnect(code, hostId), 250);
}

/** Tear down the current Net and reconnect to `code`. The peer whose (current)
 *  id equals `hostId` re-hosts; everyone else rejoins after a short delay. */
function reconnect(code: string, hostId: PeerId) {
  migrating = true;
  roomCode = code;
  const asHost = myId === hostId;
  isHost = asHost;
  net?.dispose();
  net = null;
  lobby.status(asHost ? "Opening the new room…" : "Moving to the new room…");
  if (asHost) {
    net = Net.host(code, localName, localColor, handlers);
  } else {
    migrateJoinTries = 5;
    window.setTimeout(() => {
      net = Net.join(code, localName, localColor, handlers);
    }, 1200); // give the new host time to register with the broker first
  }
}

async function startMatch(
  spawns: { x: number; y: number }[],
  role: Role,
  impostors: PeerId[],
  impostorCount: number,
  tasks: string[],
  rules: GameRules,
) {
  if (game || !net) return; // guard against a duplicate start
  lobby.hideForMatch();
  game = new Game(net, myId);
  const mount = document.getElementById("game")!;
  await game.start(roster, spawns, mount, role, impostors, tasks, rules);
  showReveal(role, impostorCount);
}

/** Match-start reveal: your role + how many impostors are in the game. */
function showReveal(role: Role, impostorCount: number) {
  const el = document.getElementById("reveal")!;
  const roleEl = document.getElementById("reveal-role")!;
  const subEl = document.getElementById("reveal-sub")!;
  roleEl.textContent = role === "impostor" ? "IMPOSTOR" : "CREWMATE";
  roleEl.style.color = role === "impostor" ? "#ff5b6e" : "#5b8cff";
  subEl.textContent =
    impostorCount === 1
      ? "There is 1 impostor among us"
      : `There are ${impostorCount} impostors among us`;

  el.classList.remove("hidden");
  const hide = () => {
    el.classList.add("hidden");
    el.removeEventListener("click", hide);
    clearTimeout(timer);
  };
  const timer = setTimeout(hide, 4500);
  el.addEventListener("click", hide);
}

/** Tear down the finished match and return to the room so another round can
 *  start. Runs on every peer ~5s after game-over. */
function resetToLobby() {
  document.getElementById("gameover")?.classList.add("hidden");
  game?.dispose();
  game = null;
  net?.resetMatch();
  lobby.returnToLobby();
}

/** Update the global task progress bar shown at the top of the screen. */
function updateTaskbar(done: number, total: number) {
  const bar = document.getElementById("taskbar");
  const fill = document.getElementById("taskbar-fill");
  const label = document.getElementById("taskbar-label");
  if (!bar || !fill || !label) return;
  bar.classList.remove("hidden");
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  fill.style.width = pct + "%";
  label.textContent = `Total Tasks  ${done} / ${total}`;
}

function showGameOver(winner: Role) {
  document.getElementById("taskbar")?.classList.add("hidden");
  const el = document.getElementById("gameover")!;
  const title = document.getElementById("go-title")!;
  const sub = document.getElementById("go-sub")!;
  title.textContent = winner === "impostor" ? "IMPOSTORS WIN" : "CREW WIN";
  title.style.color = winner === "impostor" ? "#ff5b6e" : "#5b8cff";
  sub.textContent =
    winner === "impostor"
      ? "Crew were worn down to a 1:1 ratio"
      : "All impostors were defeated";
  el.classList.remove("hidden");
}
