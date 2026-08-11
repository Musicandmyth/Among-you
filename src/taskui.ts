/**
 * Task minigame overlay. `open(task, onComplete)` renders a small interactive
 * job; when the player finishes it, `onComplete` fires once and the overlay
 * closes. The X button (or clicking the backdrop) cancels without completing.
 *
 * The minigames are original, lightweight takes on the "do a job at a console"
 * idea — connect wires, swipe a card, download data, enter a code, start a
 * reactor. No external assets; everything is drawn with DOM + a little SVG.
 */

import type { TaskDef, TaskType } from "./tasks";

const WIRE_COLORS = ["#ff5b6e", "#ffd23d", "#5b8cff", "#3ddc84"];

export class TaskUI {
  private root: HTMLElement;
  private panel: HTMLElement;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private onComplete: (() => void) | null = null;
  private cleanup: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "taskui";
    this.root.className = "overlay hidden";
    this.root.innerHTML = `
      <div class="task-card">
        <div class="task-head">
          <span id="task-title">Task</span>
          <button id="task-close" class="task-close" aria-label="Close">✕</button>
        </div>
        <div id="task-body" class="task-body"></div>
      </div>`;
    document.body.appendChild(this.root);
    this.panel = this.root.querySelector(".task-card") as HTMLElement;
    this.titleEl = this.root.querySelector("#task-title") as HTMLElement;
    this.bodyEl = this.root.querySelector("#task-body") as HTMLElement;

    (this.root.querySelector("#task-close") as HTMLElement).addEventListener("click", () => this.close());
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close(); // click outside the card cancels
    });
  }

  isOpen(): boolean {
    return !this.root.classList.contains("hidden");
  }

  open(task: TaskDef, onComplete: () => void) {
    if (this.isOpen()) return;
    this.onComplete = onComplete;
    this.titleEl.textContent = `${task.name} · ${task.room}`;
    this.bodyEl.replaceChildren();
    this.root.classList.remove("hidden");
    this.render(task.type);
  }

  close() {
    this.cleanup?.();
    this.cleanup = null;
    this.onComplete = null;
    this.bodyEl.replaceChildren();
    this.root.classList.add("hidden");
  }

  /** Tear down the overlay's DOM (called when the match ends). */
  dispose() {
    this.cleanup?.();
    this.root.remove();
  }

  /** Called by a minigame when the player finishes it. */
  private finish() {
    const cb = this.onComplete;
    this.onComplete = null;
    // brief success flash before closing
    this.panel.classList.add("task-done");
    window.setTimeout(() => {
      this.panel.classList.remove("task-done");
      this.close();
      cb?.();
    }, 450);
  }

  private render(type: TaskType) {
    switch (type) {
      case "wires": return this.renderWires();
      case "swipe": return this.renderSwipe();
      case "download": return this.renderTransfer("download");
      case "upload": return this.renderTransfer("upload");
      case "keypad": return this.renderKeypad();
      case "reactor": return this.renderReactor();
    }
  }

  // ---- wires: connect each left node to the same-colored right node ----

  private renderWires() {
    const order = [0, 1, 2, 3];
    const right = shuffle([0, 1, 2, 3]);

    const wrap = document.createElement("div");
    wrap.className = "wires";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "wire-lines");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    const left = document.createElement("div");
    left.className = "wire-col left";
    const rightCol = document.createElement("div");
    rightCol.className = "wire-col right";
    wrap.append(svg, left, rightCol);
    this.bodyEl.appendChild(wrap);

    let selected: number | null = null;
    let connected = 0;
    const leftEls: HTMLElement[] = [];
    const rightEls: HTMLElement[] = [];

    const nodeY = (i: number) => 12.5 + i * 25; // in the 0..100 svg space

    order.forEach((c) => {
      const el = document.createElement("button");
      el.className = "wire-node";
      el.style.background = WIRE_COLORS[c];
      el.addEventListener("click", () => {
        if (el.dataset.done) return;
        selected = c;
        for (const n of leftEls) n.classList.remove("sel");
        el.classList.add("sel");
      });
      leftEls[c] = el;
      left.appendChild(el);
    });

    right.forEach((c, i) => {
      const el = document.createElement("button");
      el.className = "wire-node";
      el.style.background = WIRE_COLORS[c];
      el.addEventListener("click", () => {
        if (el.dataset.done || selected === null) return;
        if (selected === c) {
          // connect: draw a line from left node (color c) to this right slot
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", "2");
          line.setAttribute("y1", String(nodeY(order.indexOf(c))));
          line.setAttribute("x2", "98");
          line.setAttribute("y2", String(nodeY(i)));
          line.setAttribute("stroke", WIRE_COLORS[c]);
          line.setAttribute("stroke-width", "4");
          svg.appendChild(line);
          leftEls[c].dataset.done = "1";
          leftEls[c].classList.remove("sel");
          leftEls[c].classList.add("done");
          el.dataset.done = "1";
          el.classList.add("done");
          selected = null;
          if (++connected === 4) this.finish();
        } else {
          selected = null;
          for (const n of leftEls) n.classList.remove("sel");
        }
      });
      rightEls[i] = el;
      rightCol.appendChild(el);
    });

    this.hint("Connect each wire to the matching color.");
  }

  // ---- swipe: drag the card across the reader at the RIGHT speed ----

  private renderSwipe() {
    const track = document.createElement("div");
    track.className = "swipe-track";
    const reader = document.createElement("div");
    reader.className = "swipe-reader";
    const card = document.createElement("div");
    card.className = "swipe-card-el";
    card.textContent = "ID";
    track.append(reader, card);
    this.bodyEl.appendChild(track);
    const msg = this.hint("Swipe the card across — not too fast, not too slow.");

    // Acceptable time to cross the whole reader, in ms. Too quick or too slow
    // is rejected, so the player has to find a steady, moderate speed.
    const MIN_MS = 550;
    const MAX_MS = 1400;

    let dragging = false;
    let startX = 0;
    let cardX = 0;
    let t0 = 0;
    let reached = false;

    const maxX = () => track.clientWidth - card.clientWidth - 8;

    const reset = (text: string) => {
      msg.textContent = text;
      cardX = 0;
      reached = false;
      card.style.transform = "translateX(0px)";
    };

    const down = (e: PointerEvent) => {
      dragging = true;
      reached = false;
      startX = e.clientX - cardX;
      t0 = performance.now();
      card.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging || reached) return;
      cardX = Math.max(0, Math.min(maxX(), e.clientX - startX));
      card.style.transform = `translateX(${cardX}px)`;
      if (cardX >= maxX() - 3) {
        reached = true;
        const dt = performance.now() - t0;
        if (dt < MIN_MS) reset("Too fast — swipe slower.");
        else if (dt > MAX_MS) reset("Too slow — swipe faster.");
        else this.finish();
      }
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      if (!reached) reset("Bad read. Try again.");
    };
    card.addEventListener("pointerdown", down);
    card.addEventListener("pointermove", move);
    card.addEventListener("pointerup", up);
    this.cleanup = () => {
      card.removeEventListener("pointerdown", down);
      card.removeEventListener("pointermove", move);
      card.removeEventListener("pointerup", up);
    };
  }

  // ---- download / upload: start the transfer and let the long bar fill ----

  private renderTransfer(kind: "download" | "upload") {
    const wrap = document.createElement("div");
    wrap.className = "dl" + (kind === "upload" ? " up" : "");
    const bar = document.createElement("div");
    bar.className = "dl-bar";
    const fill = document.createElement("div");
    fill.className = "dl-fill";
    bar.appendChild(fill);
    const pct = document.createElement("div");
    pct.className = "dl-pct";
    pct.textContent = "0%";
    const btn = document.createElement("button");
    btn.className = "btn primary";
    btn.textContent = kind === "upload" ? "Upload" : "Download";
    wrap.append(bar, pct, btn);
    this.bodyEl.appendChild(wrap);
    this.hint(
      kind === "upload"
        ? "Start the upload and let it run — this one takes a while."
        : "Start the download and let it run — this one takes a while.",
    );

    // ~14 seconds total (0.5% every 70ms) so the transfer feels long.
    const STEP = 0.5;
    const TICK_MS = 70;
    let timer: ReturnType<typeof setInterval> | undefined;
    let p = 0;
    btn.addEventListener("click", () => {
      if (timer) return;
      btn.disabled = true;
      btn.textContent = kind === "upload" ? "Uploading…" : "Downloading…";
      timer = setInterval(() => {
        p = Math.min(100, p + STEP);
        fill.style.width = p + "%";
        pct.textContent = Math.floor(p) + "%";
        if (p >= 100) {
          clearInterval(timer);
          timer = undefined;
          this.finish();
        }
      }, TICK_MS);
    });
    this.cleanup = () => timer && clearInterval(timer);
  }

  // ---- keypad: enter the displayed code in order ----

  private renderKeypad() {
    const code = Array.from({ length: 5 }, () => Math.floor(Math.random() * 10));
    const wrap = document.createElement("div");
    wrap.className = "keypad";

    const display = document.createElement("div");
    display.className = "keypad-code";
    const digits = code.map((d) => {
      const s = document.createElement("span");
      s.textContent = String(d);
      display.appendChild(s);
      return s;
    });

    const pad = document.createElement("div");
    pad.className = "keypad-grid";
    let idx = 0;
    for (let n = 0; n <= 9; n++) {
      const b = document.createElement("button");
      b.className = "keypad-key";
      b.textContent = String(n);
      b.addEventListener("click", () => {
        if (n === code[idx]) {
          digits[idx].classList.add("ok");
          if (++idx === code.length) this.finish();
        } else {
          idx = 0;
          for (const s of digits) s.classList.remove("ok");
        }
      });
      pad.appendChild(b);
    }

    wrap.append(display, pad);
    this.bodyEl.appendChild(wrap);
    this.hint("Enter the code from left to right.");
  }

  // ---- reactor: repeat the growing light sequence (Simon) ----

  private renderReactor() {
    const wrap = document.createElement("div");
    wrap.className = "reactor";
    const pads: HTMLElement[] = [];
    for (let i = 0; i < 4; i++) {
      const b = document.createElement("button");
      b.className = "reactor-pad r" + i;
      wrap.appendChild(b);
      pads.push(b);
    }
    this.bodyEl.appendChild(wrap);
    const msg = this.hint("Watch, then repeat the sequence.");

    const seq: number[] = [];
    let step = 0;
    let accepting = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const flash = (i: number, ms = 320) => {
      pads[i].classList.add("lit");
      timers.push(setTimeout(() => pads[i].classList.remove("lit"), ms));
    };

    const playback = () => {
      accepting = false;
      msg.textContent = "Watch…";
      seq.forEach((v, k) => timers.push(setTimeout(() => flash(v), 500 + k * 520)));
      timers.push(setTimeout(() => {
        accepting = true;
        step = 0;
        msg.textContent = "Your turn.";
      }, 500 + seq.length * 520));
    };

    const nextRound = () => {
      seq.push(Math.floor(Math.random() * 4));
      playback();
    };

    pads.forEach((pad, i) => {
      pad.addEventListener("click", () => {
        if (!accepting) return;
        flash(i, 180);
        if (i === seq[step]) {
          if (++step === seq.length) {
            accepting = false;
            if (seq.length >= 3) {
              this.finish();
            } else {
              timers.push(setTimeout(nextRound, 600));
            }
          }
        } else {
          accepting = false;
          msg.textContent = "Wrong — starting over.";
          seq.length = 0;
          timers.push(setTimeout(nextRound, 800));
        }
      });
    });

    nextRound();
    this.cleanup = () => timers.forEach(clearTimeout);
  }

  private hint(text: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "task-hint";
    el.textContent = text;
    this.bodyEl.appendChild(el);
    return el;
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
