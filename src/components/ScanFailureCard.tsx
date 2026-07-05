import { basename } from "../utils/path";

/** One folder that failed to open during a batch scan (home / staged screens). */
export type ScanFailure = { path: string; msg: string; permanent: boolean };

/**
 * Collapse a raw backend scan error into a short row tag. The known permanent
 * shapes ("folder not found: <path>", "not a directory") repeat the path the
 * card already shows, so they carry no extra detail; anything unrecognised
 * keeps its raw message as the detail line.
 */
export function scanFailureTag(msg: string): { tag: string; detail: string | null } {
  if (/not found/i.test(msg)) return { tag: "not found", detail: null };
  if (/not a directory/i.test(msg)) return { tag: "not a folder", detail: null };
  return { tag: "failed", detail: msg };
}

/**
 * The designed replacement for the raw `<pre>` error dump: a quiet card with
 * one row per failed folder (name, tag, dimmed full path) and a footer that
 * explains what "not found" usually means and that dead entries left recents.
 */
export function ScanFailureCard({ failures }: { failures: readonly ScanFailure[] }) {
  const anyPermanent = failures.some((f) => f.permanent);
  return (
    <div className="cull-scanfail" role="alert">
      <div className="cull-scanfail__title">
        {failures.length === 1 ? "couldn't open folder" : `couldn't open ${failures.length} folders`}
      </div>
      <ul className="cull-scanfail__list">
        {failures.map((f) => {
          const { tag, detail } = scanFailureTag(f.msg);
          return (
            <li key={f.path} className="cull-scanfail__row">
              <div className="cull-scanfail__head">
                <span className="cull-scanfail__name">{basename(f.path)}</span>
                <span className="cull-scanfail__tag">{tag}</span>
              </div>
              <span className="cull-scanfail__path" title={f.path}>
                {f.path}
              </span>
              {detail && <span className="cull-scanfail__detail">{detail}</span>}
            </li>
          );
        })}
      </ul>
      {anyPermanent && (
        <div className="cull-scanfail__note">
          A missing folder was usually moved, renamed, or its drive isn't connected. Entries
          that can't open anymore were removed from recents.
        </div>
      )}
    </div>
  );
}
