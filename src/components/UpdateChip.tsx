import type { UpdateState } from "../hooks/useUpdateCheck";

type Props = {
  state: UpdateState;
  onInstall: () => void;
};

/** One line on the home screen when a newer release exists. Nothing when
 *  there is none — the check is silent by design. Sentence case; the version
 *  comes straight from the release, so it reads "1.1.0", not "v1.1.0". */
export function UpdateChip({ state, onInstall }: Props) {
  if (state.status === "idle") return null;
  const label =
    state.status === "available"
      ? `Update ${state.version} is ready to install`
      : state.status === "downloading"
        ? `Downloading ${state.version} · ${state.percent}%`
        : state.status === "ready"
          ? `Restarting into ${state.version}…`
          : `Update ${state.version} could not be installed`;
  const canInstall = state.status === "available" || state.status === "failed";
  return (
    <span className="cull-update-chip" role="status">
      <span>{label}</span>
      {canInstall && (
        <button type="button" className="btn btn--sm" onClick={onInstall}>
          {state.status === "failed" ? "Try again" : "Install and restart"}
        </button>
      )}
    </span>
  );
}
