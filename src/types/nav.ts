/** The three "sites" of the app — mutually exclusive at any moment. */
export type NavSite = "loupe" | "compare" | "grid";

/**
 * One entry in the navigation back-stack. Compare entries snapshot the
 * champion/challenger so ESC back into compare resumes the same pair (the
 * stack is what makes browser-back-style navigation work across sites).
 */
export type NavEntry =
  { site: "loupe" | "grid" } | { site: "compare"; champ: number; chall: number };

/** Which mode's keybinds the help overlay should show. */
export type HelpMode = NavSite;

/** One drawn shortcut. `keys` are keycap labels in order; the literal "mod"
 *  renders the platform modifier (Ctrl / ⌘) via KeyCombo. */
export type HelpRow = {
  keys: readonly string[];
  /** Draw the two keys as a range — `1` – `4` — with a muted en dash. */
  range?: boolean;
  /** A modifier that applies to BOTH ends of a `range`, drawn on each cap
   *  (`Shift` `1` – `Shift` `5`) rather than once in front, so neither end can
   *  be read as the bare key. Ignored without `range`. */
  mod?: string;
  /** Muted word after the caps. "hold" is never inside a cap. */
  hold?: boolean;
  /** A muted parenthetical after `desc` — a qualifier that only applies
   *  sometimes (e.g. a rule that's live only under one filter), so it can't
   *  just be baked into `desc` itself. */
  note?: string;
  desc: string;
};

/** A grouped block of bindings within the help overlay. */
export type HelpGroup = { title: string; rows: readonly HelpRow[] };
