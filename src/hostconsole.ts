/**
 * Host console: a lobby overlay where the host tweaks the match rules
 * (impostor count, kill cooldown, emergency cooldown, emergencies per player).
 * It owns the authoritative `GameRules` object and notifies the host via
 * `onChange` so the value can be pushed to the Net layer.
 */

import { DEFAULT_RULES, type GameRules } from "./protocol";

export interface HostConsoleCallbacks {
  onChange: (rules: GameRules) => void;
}

interface Field {
  label: string;
  hint: string;
  /** current value in DISPLAY units (e.g. seconds), read from the rules. */
  get: () => number;
  /** write a DISPLAY-unit value back into the rules. */
  set: (v: number) => void;
  min: number;
  /** max in display units; a function so the impostor cap can track roster size. */
  max: () => number;
  step: number;
  unit: string;
}

export class HostConsole {
  private root: HTMLElement;
  private rulesState: GameRules = { ...DEFAULT_RULES };
  private playerCount = 1;
  private fields: Field[] = [];
  private valueEls = new Map<Field, HTMLElement>();

  constructor(private cb: HostConsoleCallbacks) {
    this.fields = [
      {
        label: "Impostors",
        hint: "How many impostors are assigned each round.",
        get: () => this.rulesState.impostorCount,
        set: (v) => (this.rulesState.impostorCount = v),
        min: 1,
        max: () => Math.min(3, Math.max(1, this.playerCount - 1)),
        step: 1,
        unit: "",
      },
      {
        label: "Kill cooldown",
        hint: "Seconds an impostor must wait between kills.",
        get: () => Math.round(this.rulesState.killCooldownMs / 1000),
        set: (v) => (this.rulesState.killCooldownMs = v * 1000),
        min: 5,
        max: () => 60,
        step: 5,
        unit: "s",
      },
      {
        label: "Emergency cooldown",
        hint: "Seconds after a meeting (and at round start) before an emergency can be called.",
        get: () => Math.round(this.rulesState.emergencyCooldownMs / 1000),
        set: (v) => (this.rulesState.emergencyCooldownMs = v * 1000),
        min: 0,
        max: () => 120,
        step: 5,
        unit: "s",
      },
      {
        label: "Emergencies / player",
        hint: "How many emergency meetings each player may call per match.",
        get: () => this.rulesState.emergenciesPerPlayer,
        set: (v) => (this.rulesState.emergenciesPerPlayer = v),
        min: 0,
        max: () => 5,
        step: 1,
        unit: "",
      },
    ];

    this.root = document.createElement("div");
    this.root.id = "host-console";
    this.root.className = "overlay hidden";
    const card = document.createElement("div");
    card.className = "console-card";
    card.innerHTML = `<div class="console-head"><span>Host Settings</span>
      <button id="console-close" class="task-close" aria-label="Close">✕</button></div>`;
    this.root.appendChild(card);

    for (const f of this.fields) {
      const row = document.createElement("div");
      row.className = "rule-row";

      const info = document.createElement("div");
      info.className = "rule-info";
      const name = document.createElement("div");
      name.className = "rule-name";
      name.textContent = f.label;
      const hint = document.createElement("div");
      hint.className = "rule-hint";
      hint.textContent = f.hint;
      info.append(name, hint);

      const stepper = document.createElement("div");
      stepper.className = "rule-stepper";
      const minus = document.createElement("button");
      minus.className = "btn step";
      minus.textContent = "−";
      const value = document.createElement("span");
      value.className = "rule-value";
      const plus = document.createElement("button");
      plus.className = "btn step";
      plus.textContent = "+";
      minus.addEventListener("click", () => this.bump(f, -f.step));
      plus.addEventListener("click", () => this.bump(f, +f.step));
      stepper.append(minus, value, plus);
      this.valueEls.set(f, value);

      row.append(info, stepper);
      card.appendChild(row);
    }

    document.body.appendChild(this.root);
    (card.querySelector("#console-close") as HTMLElement).addEventListener("click", () => this.close());
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });
    this.refresh();
  }

  open() {
    this.refresh();
    this.root.classList.remove("hidden");
  }

  close() {
    this.root.classList.add("hidden");
  }

  /** Current rules (a copy is fine; callers shouldn't mutate). */
  rules(): GameRules {
    return { ...this.rulesState };
  }

  /** Update the roster size so the impostor cap stays valid. */
  setPlayerCount(n: number) {
    this.playerCount = Math.max(1, n);
    const capped = this.clamp(this.fields[0], this.rulesState.impostorCount);
    if (capped !== this.rulesState.impostorCount) {
      this.rulesState.impostorCount = capped;
      this.cb.onChange(this.rules());
    }
    this.refresh();
  }

  private bump(f: Field, delta: number) {
    f.set(this.clamp(f, f.get() + delta));
    this.cb.onChange(this.rules());
    this.refresh();
  }

  private clamp(f: Field, v: number): number {
    return Math.max(f.min, Math.min(f.max(), v));
  }

  private refresh() {
    for (const f of this.fields) {
      const el = this.valueEls.get(f);
      if (el) el.textContent = f.get() + (f.unit ? f.unit : "");
    }
  }
}
