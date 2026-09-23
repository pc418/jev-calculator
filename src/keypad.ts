// Keypad UI. All grammar decisions come from shared/expression.ts; this file only draws buttons.
import { type Expression, type Key, isComplete, press, pressAfterRun } from "../shared/expression";

type KeyDef = { key: Key | "="; label: string; cls?: string; title?: string };

const LAYOUT: KeyDef[] = [
  { key: "7", label: "7" }, { key: "8", label: "8" }, { key: "9", label: "9" }, { key: "/", label: "÷", cls: "op" },
  { key: "4", label: "4" }, { key: "5", label: "5" }, { key: "6", label: "6" }, { key: "*", label: "×", cls: "op" },
  { key: "1", label: "1" }, { key: "2", label: "2" }, { key: "3", label: "3" }, { key: "-", label: "−", cls: "op" },
  { key: "0", label: "0" }, { key: ".", label: "." }, { key: "back", label: "⌫", cls: "fn", title: "Backspace" }, { key: "+", label: "+", cls: "op" },
  { key: "clear", label: "C", cls: "fn", title: "Clear (Esc)" }, { key: "sqrt", label: "√", cls: "op" }, { key: "mod", label: "mod", cls: "op wide" },
  { key: "=", label: "=", cls: "eq", title: "Ask Jev (Enter)" },
];

const KEYBOARD: Record<string, Key | "="> = {
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
  ".": ".", "+": "+", "-": "-", "*": "*", "/": "/", "%": "mod", "r": "sqrt",
  Enter: "=", "=": "=", Backspace: "back", Escape: "clear",
};

export interface KeypadHandlers {
  onKey: (key: Key) => void;
  onEquals: () => void;
}

export class Keypad {
  readonly el: HTMLElement;
  private buttons = new Map<Key | "=", HTMLButtonElement>();

  constructor(private handlers: KeypadHandlers) {
    this.el = document.createElement("div");
    this.el.className = "keypad";
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", "Calculator keypad");
    for (const def of LAYOUT) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = def.label;
      b.className = `key ${def.cls ?? ""}`.trim();
      if (def.title) b.title = def.title;
      b.addEventListener("click", () => this.fire(def.key));
      this.buttons.set(def.key, b);
      this.el.appendChild(b);
    }
    window.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = KEYBOARD[e.key];
      if (!k) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      this.fire(k);
    });
  }

  private fire(key: Key | "=") {
    const b = this.buttons.get(key);
    if (b?.disabled) return;
    if (key === "=") this.handlers.onEquals();
    else this.handlers.onKey(key);
  }

  /**
   * Enables exactly the keys the grammar allows next; `=` only for a complete expression when idle.
   * After a finished run (`afterRun`) keys follow pressAfterRun, so a digit that starts a new expression is enabled.
   */
  update(expr: Expression, locked: boolean, afterRun: boolean) {
    const next = afterRun ? pressAfterRun : press;
    for (const [key, b] of this.buttons) {
      if (key === "=") b.disabled = locked || !isComplete(expr);
      else b.disabled = locked || next(expr, key) === null;
    }
  }
}
