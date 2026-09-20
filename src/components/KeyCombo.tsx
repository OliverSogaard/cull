import { modLabel } from "../utils/platform";

type Props = {
  keys: readonly string[];
  className?: string;
  mod?: string;
};

/**
 * "Ctrl" + key (or ⌘ + key on macOS) as separate keycaps, side by side on one
 * line. The literal `"mod"` in `keys` renders the platform modifier; every
 * other entry renders as its own text. Layout for the wrapper lives in
 * `.keycombo` (src/styles/primitives/kbd.css) — keycap geometry itself is a
 * later task's concern.
 */
export function KeyCombo({ keys, className, mod = modLabel }: Props) {
  const kbdClassName = className ? `kbd ${className}` : "kbd";
  return (
    <span className="keycombo">
      {keys.map((key, i) => (
        <kbd key={i} className={kbdClassName}>
          {key === "mod" ? mod : key}
        </kbd>
      ))}
    </span>
  );
}
