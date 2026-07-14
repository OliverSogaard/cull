import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Two-step inline confirm state: stage 1 arms (button click), stage 2 fires
 * the real action. Auto-disarms after `disarmMs` so a confirmed-then-walked-
 * away dialog doesn't sit primed. Shared by the finish dialog's move-rejects
 * row and the settings reset row.
 */
export function useArmedConfirm(disarmMs = 4000): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), disarmMs);
    return () => window.clearTimeout(t);
  }, [armed, disarmMs]);

  return [armed, setArmed];
}
