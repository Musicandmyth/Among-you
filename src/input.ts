/** Movement input. Tracks held keys (desktop) and, on touch devices, an on-screen
 *  thumbstick; `direction()` yields a normalized vector from whichever is active. */

export class Input {
  private keys = new Set<string>();
  private joystick: Joystick | null = null;

  constructor() {
    window.addEventListener("keydown", this.onDown);
    window.addEventListener("keyup", this.onUp);
    // Release everything if the tab loses focus, so the avatar doesn't drift.
    window.addEventListener("blur", this.clear);
    // On touch / coarse-pointer devices, add an on-screen movement stick.
    if (isCoarsePointer()) this.joystick = new Joystick();
  }

  private onDown = (e: KeyboardEvent) => {
    // Ignore movement keys while typing in a text field (e.g. meeting chat).
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const k = normalize(e.key);
    if (k) {
      this.keys.add(k);
      if (k !== "shift") e.preventDefault();
    }
  };

  private onUp = (e: KeyboardEvent) => {
    const k = normalize(e.key);
    if (k) this.keys.delete(k);
  };

  private clear = () => this.keys.clear();

  /** Normalized direction vector, magnitude 0..1. Keyboard takes priority; the
   *  thumbstick supplies analog movement when no movement key is held. */
  direction(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.keys.has("left")) x -= 1;
    if (this.keys.has("right")) x += 1;
    if (this.keys.has("up")) y -= 1;
    if (this.keys.has("down")) y += 1;
    if (x !== 0 || y !== 0) {
      if (x !== 0 && y !== 0) {
        const inv = 1 / Math.SQRT2;
        x *= inv;
        y *= inv;
      }
      return { x, y };
    }
    if (this.joystick) {
      const v = this.joystick.vector();
      const m = Math.hypot(v.x, v.y);
      return m > 1 ? { x: v.x / m, y: v.y / m } : v; // clamp magnitude to 1
    }
    return { x: 0, y: 0 };
  }

  sprinting(): boolean {
    return this.keys.has("shift");
  }

  dispose() {
    window.removeEventListener("keydown", this.onDown);
    window.removeEventListener("keyup", this.onUp);
    window.removeEventListener("blur", this.clear);
    this.joystick?.dispose();
  }
}

/** Coarse pointer = touchscreen (phone/tablet), where an on-screen stick is needed. */
function isCoarsePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window)
  );
}

/**
 * A fixed on-screen thumbstick (bottom-left). Drag the knob within the base ring;
 * `vector()` returns the offset normalized to [-1..1] on each axis (magnitude ≤ 1).
 * Uses pointer events so it works for touch and mouse alike.
 */
class Joystick {
  private base: HTMLElement;
  private knob: HTMLElement;
  private x = 0;
  private y = 0;
  private pointerId: number | null = null;
  private readonly radius = 46; // max knob travel from center, px

  constructor() {
    this.base = document.createElement("div");
    this.base.className = "joystick";
    this.knob = document.createElement("div");
    this.knob.className = "joystick-knob";
    this.base.appendChild(this.knob);
    document.body.appendChild(this.base);
    this.base.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onUp);
  }

  vector(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  private onDown = (e: PointerEvent) => {
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.moveTo(e.clientX, e.clientY);
    e.preventDefault();
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.moveTo(e.clientX, e.clientY);
    e.preventDefault();
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.x = 0;
    this.y = 0;
    this.knob.style.transform = "translate(0px, 0px)";
  };

  private moveTo(px: number, py: number) {
    const r = this.base.getBoundingClientRect();
    let dx = px - (r.left + r.width / 2);
    let dy = py - (r.top + r.height / 2);
    const dist = Math.hypot(dx, dy);
    if (dist > this.radius) {
      dx = (dx / dist) * this.radius;
      dy = (dy / dist) * this.radius;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    this.x = dx / this.radius;
    this.y = dy / this.radius;
  }

  dispose() {
    this.base.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onUp);
    this.base.remove();
  }
}

function normalize(key: string): string | null {
  switch (key) {
    case "ArrowLeft":
    case "a":
    case "A":
      return "left";
    case "ArrowRight":
    case "d":
    case "D":
      return "right";
    case "ArrowUp":
    case "w":
    case "W":
      return "up";
    case "ArrowDown":
    case "s":
    case "S":
      return "down";
    case "Shift":
      return "shift";
    default:
      return null;
  }
}
