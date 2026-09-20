import { modLabel } from "../utils/platform";

type Props = {
  keys: readonly string[];
  className?: string;
  mod?: string;
};

/**
 * "Ctrl" + key (or ⌘ + key on macOS) as separate keycaps, side by side on one
 * line. The literal `"mod"` in `keys` renders the platform modifier; every
 * other entry renders as its own text. Both the wrapper's layout and the
 * keycap's own geometry live in src/styles/primitives/kbd.css (`.keycombo`
 * and `.kbd`); `className` is for a surface's ink only.
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
