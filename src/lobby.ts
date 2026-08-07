/** Lobby screen: name/color selection, host/join actions, and the roster view.
 *  The host also gets per-player controls (make host / kick) and buttons for the
 *  host console and moving the lobby to a new code. */

import { PLAYER_COLORS, type PeerId, type PlayerInfo } from "./protocol";

export interface LobbyCallbacks {
  onHost: (name: string, color: number) => void;
  onJoin: (code: string, name: string, color: number) => void;
  onStart: () => void;
  onOpenSettings: () => void;
  onMoveRoom: () => void;
  onNominate: (id: PeerId) => void;
  onKick: (id: PeerId) => void;
}

export class Lobby {
  private selectedColor: number = PLAYER_COLORS[0];

  private el = {
    lobby: byId("lobby"),
    name: byId<HTMLInputElement>("name"),
    colors: byId("colors"),
    menu: byId("menu"),
    hostBtn: byId<HTMLButtonElement>("host-btn"),
    joinCode: byId<HTMLInputElement>("join-code"),
    joinBtn: byId<HTMLButtonElement>("join-btn"),
    room: byId("room"),
    codeValue: byId("code-value"),
    copyBtn: byId<HTMLButtonElement>("copy-btn"),
    playerList: byId("player-list"),
    hostControls: byId("host-controls"),
    settingsBtn: byId<HTMLButtonElement>("settings-btn"),
    moveRoomBtn: byId<HTMLButtonElement>("move-room-btn"),
    startBtn: byId<HTMLButtonElement>("start-btn"),
    waitMsg: byId("wait-msg"),
    status: byId("status"),
    hud: byId("hud"),
    hudRoom: byId("hud-room"),
  };

  private roomCode = "";
  private isHost = false;

  constructor(private cb: LobbyCallbacks) {
    this.el.name.value = randomName();
    this.renderSwatches();

    this.el.hostBtn.addEventListener("click", () => {
      const name = this.name();
      if (!name) return this.status("Enter a name first.");
      this.disableMenu();
      this.cb.onHost(name, this.selectedColor);
    });

    this.el.joinBtn.addEventListener("click", () => {
      const name = this.name();
      const code = this.el.joinCode.value.trim().toUpperCase();
      if (!name) return this.status("Enter a name first.");
      if (!code) return this.status("Enter a room code to join.");
      this.disableMenu();
      this.cb.onJoin(code, name, this.selectedColor);
    });

    this.el.joinCode.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.el.joinBtn.click();
    });

    this.el.copyBtn.addEventListener("click", () => {
      void navigator.clipboard?.writeText(this.roomCode);
      this.status("Room code copied.", true);
    });

    this.el.startBtn.addEventListener("click", () => this.cb.onStart());
    this.el.settingsBtn.addEventListener("click", () => this.cb.onOpenSettings());
    this.el.moveRoomBtn.addEventListener("click", () => this.cb.onMoveRoom());
  }

  private renderSwatches() {
    PLAYER_COLORS.forEach((color, i) => {
      const sw = document.createElement("div");
      sw.className = "swatch" + (i === 0 ? " selected" : "");
      sw.style.background = hex(color);
      sw.addEventListener("click", () => {
        this.selectedColor = color;
        this.el.colors
          .querySelectorAll(".swatch")
          .forEach((n) => n.classList.remove("selected"));
        sw.classList.add("selected");
      });
      this.el.colors.appendChild(sw);
    });
  }

  private name(): string {
    return this.el.name.value.trim();
  }

  private disableMenu() {
    this.el.hostBtn.disabled = true;
    this.el.joinBtn.disabled = true;
    this.status("Connecting…");
  }

  /** Called once we're connected: show the room + roster. */
  enterRoom(code: string, isHost: boolean) {
    this.roomCode = code;
    this.isHost = isHost;
    this.el.codeValue.textContent = code;
    this.el.menu.classList.add("hidden");
    this.el.room.classList.remove("hidden");
    this.applyHostView();
    this.status("");
  }

  private applyHostView() {
    this.el.hostControls.classList.toggle("hidden", !this.isHost);
    this.el.startBtn.classList.toggle("hidden", !this.isHost);
    this.el.waitMsg.classList.toggle("hidden", this.isHost);
  }

  setPlayers(players: PlayerInfo[]) {
    this.el.playerList.replaceChildren();
    players.forEach((p, i) => {
      const li = document.createElement("li");

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = hex(p.color);

      const label = document.createElement("span");
      label.className = "player-name";
      label.textContent = p.name;

      li.append(dot, label);

      if (i === 0) {
        const tag = document.createElement("span");
        tag.className = "host-tag";
        tag.textContent = "Host";
        li.append(tag);
      } else if (this.isHost) {
        // The host can promote or remove any other player. (Row 0 is the host.)
        const actions = document.createElement("span");
        actions.className = "player-actions";
        const makeHost = document.createElement("button");
        makeHost.className = "btn tiny";
        makeHost.textContent = "Make host";
        makeHost.addEventListener("click", () => this.cb.onNominate(p.id));
        const kick = document.createElement("button");
        kick.className = "btn tiny danger";
        kick.textContent = "Kick";
        kick.addEventListener("click", () => this.cb.onKick(p.id));
        actions.append(makeHost, kick);
        li.append(actions);
      }
      this.el.playerList.appendChild(li);
    });
  }

  status(msg: string, ok = false) {
    this.el.status.textContent = msg;
    this.el.status.classList.toggle("ok", ok);
  }

  /** Re-enable the menu after a failed connection / kick so the user can retry. */
  resetMenu() {
    this.el.hostBtn.disabled = false;
    this.el.joinBtn.disabled = false;
    this.el.menu.classList.remove("hidden");
    this.el.room.classList.add("hidden");
  }

  /** Hide the lobby and show the in-game HUD. */
  hideForMatch() {
    this.el.lobby.classList.add("hidden");
    this.el.hud.classList.remove("hidden");
    this.el.hudRoom.textContent = "Room " + this.roomCode;
  }

  /** After a match ends: hide the HUD and bring back the room/roster view so
   *  the host can tweak rules and start another round. */
  returnToLobby() {
    this.el.hud.classList.add("hidden");
    this.el.lobby.classList.remove("hidden");
    this.el.menu.classList.add("hidden");
    this.el.room.classList.remove("hidden");
    this.applyHostView();
    this.status("");
  }
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in the DOM`);
  return el as T;
}

function hex(color: number): string {
  return "#" + color.toString(16).padStart(6, "0");
}

const NAMES = ["Red", "Cyan", "Sage", "Nova", "Pip", "Bolt", "Echo", "Wisp", "Zinc", "Moss"];
function randomName(): string {
  // Math.random is fine here — cosmetic only, not gameplay/seeded.
  return NAMES[Math.floor(Math.random() * NAMES.length)]!;
}
