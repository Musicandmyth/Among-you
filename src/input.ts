/** Keyboard movement input. Tracks held keys and yields a normalized direction. */

export class Input {
  private keys = new Set<string>();

  constructor() {
    window.addEventListener("keydown", this.onDown);
    window.addEventListener("keyup", this.onUp);
    // Release everything if the tab loses focus, so the avatar doesn't drift.
    window.addEventListener("blur", this.clear);
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

  /** Normalized [-1..1] direction vector; magnitude 0 or 1. */
  direction(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.keys.has("left")) x -= 1;
    if (this.keys.has("right")) x += 1;
    if (this.keys.has("up")) y -= 1;
    if (this.keys.has("down")) y += 1;
    if (x !== 0 && y !== 0) {
      const inv = 1 / Math.SQRT2;
      x *= inv;
      y *= inv;
    }
    return { x, y };
  }

  sprinting(): boolean {
    return this.keys.has("shift");
  }

  dispose() {
    window.removeEventListener("keydown", this.onDown);
    window.removeEventListener("keyup", this.onUp);
    window.removeEventListener("blur", this.clear);
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
