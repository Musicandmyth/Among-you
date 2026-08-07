/**
 * Entry point. Wires the lobby UI to the P2P transport and, once the match
 * starts, hands control to the Pixi game scene. The Net handlers are defined
 * once here and forward into whichever `Game` instance is live.
 */

import { Game } from "./game";
import { Lobby } from "./lobby";
import { Meeting } from "./meeting";
import { Net, type NetHandlers } from "./net";
import { MAP } from "./map";
import { generateRoomCode, type PeerId, type PlayerInfo, type Role } from "./protocol";

let net: Net | null = null;
let game: Game | null = null;
let myId = "";
let roomCode = "";
let isHost = false;
let roster: PlayerInfo[] = [];
let lastVotingMs = 30_000;

const meeting = new Meeting({
  onVote: (target) => net?.requestVote(target),
  onChat: (text) => net?.requestChat(text),
});

const lobby = new Lobby({
  onHost: (name, color) => {
    roomCode = generateRoomCode(Math.random);
    isHost = true;
    net = Net.host(roomCode, name, color, handlers);
  },
  onJoin: (code, name, color) => {
    roomCode = code;
    isHost = false;
    net = Net.join(code, name, color, handlers);
  },
  onStart: () => {
    // Host only: kick off the match for everyone with the chosen impostor count.
    net?.startMatch(MAP.spawns, lobby.impostorCount());
  },
});

const handlers: NetHandlers = {
  onReady: (id) => {
    myId = id;
    lobby.enterRoom(roomCode, isHost);
  },
  onLobby: (players) => {
    roster = players;
    lobby.setPlayers(players);
    game?.updateRoster(players);
  },
  onStart: (spawns, role, impostors, impostorCount, tasks) => {
    void startMatch(spawns, role, impostors, impostorCount, tasks);
  },
  onState: (players) => game?.applyState(players),
  onInput: (id, x, y, vx, vy, vented) => game?.applyInput(id, x, y, vx, vy, vented),
  onDoors: (locked, cooling) => game?.setDoors(locked, cooling),
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
  onError: (message) => {
    lobby.status(message);
    lobby.resetMenu();
    net?.dispose();
    net = null;
  },
};

async function startMatch(
  spawns: { x: number; y: number }[],
  role: Role,
  impostors: PeerId[],
  impostorCount: number,
  tasks: string[],
) {
  if (game || !net) return; // guard against a duplicate start
  lobby.hideForMatch();
  game = new Game(net, myId);
  const mount = document.getElementById("game")!;
  await game.start(roster, spawns, mount, role, impostors, tasks);
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
      ? "Crew were worn down to a 1:2 ratio"
      : "All impostors were defeated";
  el.classList.remove("hidden");
}
