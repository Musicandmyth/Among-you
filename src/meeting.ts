/**
 * Meeting overlay: renders the discussion and voting phases and the result.
 * Phase transitions are driven by the host (via main.ts handlers); this class
 * only manages the DOM, relays the local player's chat + vote, and shows the
 * final tally.
 *
 * Voting is NOT locked in on the first click: the player may change their choice
 * freely until the voting timer runs out, at which point the host tallies and
 * showResult() displays the per-player vote counts and who (if anyone) was
 * ejected.
 */

import type { MeetingPlayer, VoteTarget } from "./protocol";

export interface MeetingCallbacks {
  onVote: (target: VoteTarget) => void;
  onChat: (text: string) => void;
}

interface Card {
  el: HTMLButtonElement;
  countEl: HTMLSpanElement;
  target: VoteTarget;
  alive: boolean;
}

export class Meeting {
  private root: HTMLElement;
  private title: HTMLElement;
  private timerEl: HTMLElement;
  private subEl: HTMLElement;
  private grid: HTMLElement;
  private statusEl: HTMLElement;
  private logEl: HTMLElement;
  private inputEl: HTMLInputElement;
  private sendEl: HTMLButtonElement;

  private cards: Card[] = [];
  private canVote = false;
  private voting = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private cb: MeetingCallbacks) {
    this.root = must("meeting");
    this.root.innerHTML = `
      <div class="meeting-card">
        <div class="meeting-head">
          <span id="meeting-title">Discussion</span>
          <span id="meeting-timer">--</span>
        </div>
        <div id="meeting-sub" class="meeting-sub"></div>
        <div id="meeting-grid" class="meeting-grid"></div>
        <div class="meeting-chat">
          <div id="meeting-log" class="meeting-log"></div>
          <div class="meeting-chat-row">
            <input id="meeting-input" type="text" maxlength="200" placeholder="Type a message…" autocomplete="off" />
            <button id="meeting-send" class="btn">Send</button>
          </div>
        </div>
        <div id="meeting-status" class="meeting-status"></div>
      </div>`;
    this.title = must("meeting-title");
    this.timerEl = must("meeting-timer");
    this.subEl = must("meeting-sub");
    this.grid = must("meeting-grid");
    this.statusEl = must("meeting-status");
    this.logEl = must("meeting-log");
    this.inputEl = must("meeting-input") as HTMLInputElement;
    this.sendEl = must("meeting-send") as HTMLButtonElement;

    this.sendEl.addEventListener("click", () => this.sendChat());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.sendChat();
    });
  }

  startDiscussion(
    players: MeetingPlayer[],
    myId: string,
    trigger: "report" | "emergency",
    calledByName: string,
    discussionMs: number,
  ) {
    this.voting = false;
    this.canVote = players.some((p) => p.id === myId && p.alive);

    this.subEl.textContent =
      trigger === "report" ? `${calledByName} reported a body` : `${calledByName} called an emergency meeting`;

    this.logEl.replaceChildren();
    this.renderCards(players);
    this.title.textContent = "Discussion";
    this.statusEl.textContent = this.canVote ? "Discuss — voting opens soon…" : "You are dead — spectating";
    this.setCardsEnabled(false);
    this.setChatEnabled(this.canVote);
    this.startCountdown(discussionMs);
    this.root.classList.remove("hidden");
  }

  startVoting(votingMs: number) {
    this.voting = true;
    this.title.textContent = "Voting";
    if (this.canVote) {
      this.statusEl.textContent = "Cast your vote — you can change it until time runs out";
      this.setCardsEnabled(true);
    }
    this.startCountdown(votingMs);
  }

  showResult(ejected: string | null, wasImpostor: boolean | null, tally: Record<string, number>) {
    this.voting = false;
    this.stopCountdown();
    this.timerEl.textContent = "";
    this.title.textContent = "Result";
    this.setCardsEnabled(false);
    this.setChatEnabled(false);

    for (const card of this.cards) {
      const n = tally[card.target] ?? 0;
      card.countEl.textContent = n > 0 ? String(n) : "";
      card.el.classList.toggle("ejected", ejected !== null && card.target === ejected);
    }

    if (!ejected) {
      this.statusEl.textContent = "No one was ejected.";
    } else {
      const name = this.cards.find((c) => c.target === ejected)?.el.dataset.name ?? "A player";
      const roleText = wasImpostor === null ? "" : wasImpostor ? " was an Impostor." : " was not an Impostor.";
      this.statusEl.textContent = `${name} was ejected.${roleText}`;
    }
  }

  /** Append a chat line to the meeting log. */
  addChat(name: string, color: number, text: string) {
    const line = document.createElement("div");
    line.className = "chat-line";
    const who = document.createElement("span");
    who.className = "chat-who";
    who.style.color = "#" + color.toString(16).padStart(6, "0");
    who.textContent = name + ": ";
    const body = document.createElement("span");
    body.textContent = text;
    line.append(who, body);
    this.logEl.appendChild(line);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  close() {
    this.stopCountdown();
    this.root.classList.add("hidden");
  }

  // ---- internals ----

  private sendChat() {
    const text = this.inputEl.value.trim();
    if (!text || !this.canVote) return;
    this.cb.onChat(text);
    this.inputEl.value = "";
  }

  private setChatEnabled(enabled: boolean) {
    this.inputEl.disabled = !enabled;
    this.sendEl.disabled = !enabled;
    this.inputEl.placeholder = enabled ? "Type a message…" : "Chat closed";
  }

  private renderCards(players: MeetingPlayer[]) {
    this.grid.replaceChildren();
    this.cards = [];

    for (const p of players) {
      const btn = document.createElement("button");
      btn.className = "vote-card" + (p.alive ? "" : " dead");
      btn.dataset.name = p.name;

      const dot = document.createElement("span");
      dot.className = "vote-dot";
      dot.style.background = "#" + p.color.toString(16).padStart(6, "0");

      const name = document.createElement("span");
      name.className = "vote-name";
      name.textContent = p.name + (p.alive ? "" : " (dead)");

      const count = document.createElement("span");
      count.className = "vote-count";

      btn.append(dot, name, count);
      btn.addEventListener("click", () => this.cast(p.id, p.alive));
      this.grid.appendChild(btn);
      this.cards.push({ el: btn, countEl: count, target: p.id, alive: p.alive });
    }

    // Skip vote.
    const skip = document.createElement("button");
    skip.className = "vote-card skip";
    skip.dataset.name = "Skip";
    const label = document.createElement("span");
    label.className = "vote-name";
    label.textContent = "Skip vote";
    const count = document.createElement("span");
    count.className = "vote-count";
    skip.append(label, count);
    skip.addEventListener("click", () => this.cast("skip", true));
    this.grid.appendChild(skip);
    this.cards.push({ el: skip, countEl: count, target: "skip", alive: true });
  }

  private cast(target: VoteTarget, targetAlive: boolean) {
    if (!this.voting || !this.canVote) return;
    if (!targetAlive) return; // can't vote for dead players
    this.cb.onVote(target); // may be called repeatedly — the host overwrites
    for (const card of this.cards) card.el.classList.toggle("chosen", card.target === target);
    const name = target === "skip" ? "Skip" : this.cards.find((c) => c.target === target)?.el.dataset.name ?? "";
    this.statusEl.textContent = `Voting for ${name} — you can change until time runs out`;
  }

  private setCardsEnabled(enabled: boolean) {
    const allow = enabled && this.canVote;
    for (const card of this.cards) {
      card.el.disabled = !allow || !card.alive;
    }
  }

  private startCountdown(ms: number) {
    this.stopCountdown();
    const end = performance.now() + ms;
    const tick = () => {
      const remain = Math.max(0, Math.ceil((end - performance.now()) / 1000));
      this.timerEl.textContent = remain + "s";
      if (remain <= 0) this.stopCountdown();
    };
    tick();
    this.timer = setInterval(tick, 250);
  }

  private stopCountdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function must(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}
