import {
  demoCommentThreads,
  demoPagelet,
  demoPublishConfig,
  demoVersions
} from "@pagelet/shared";

const phaseRows = [
  ["0", "Repo and tooling skeleton", "active"],
  ["1", "Shared contracts and fixtures", "active"],
  ["2", "Local publish skeleton", "next"]
] as const;

export function HomePage() {
  const latestVersion = demoVersions.find(
    (version) => version.id === demoPagelet.latestVersionId
  );

  return (
    <main className="app-shell">
      <section className="status-header" aria-labelledby="page-title">
        <div>
          <p className="product-name">Pagelet</p>
          <h1 id="page-title">Build Status</h1>
        </div>
        <div className="status-pill">Walking skeleton</div>
      </section>

      <section className="summary-grid" aria-label="Current fixture summary">
        <StatusMetric label="Demo pagelet" value={demoPagelet.shareId} />
        <StatusMetric
          label="Latest version"
          value={latestVersion ? `v${latestVersion.versionNumber}` : "none"}
        />
        <StatusMetric
          label="Open threads"
          value={String(demoCommentThreads.length)}
        />
        <StatusMetric
          label="Upload policy"
          value={`${Math.round(demoPublishConfig.maxUploadBytes / 1024 / 1024)} MB`}
        />
      </section>

      <section className="phase-panel" aria-labelledby="phase-title">
        <div className="section-heading">
          <h2 id="phase-title">Implementation Phases</h2>
          <p>Current slice: scaffold the workspace and freeze contracts.</p>
        </div>
        <div className="phase-list">
          {phaseRows.map(([number, title, state]) => (
            <div className="phase-row" key={number}>
              <span className="phase-number">{number}</span>
              <span className="phase-title">{title}</span>
              <span className={`phase-state phase-state-${state}`}>
                {state === "active" ? "in progress" : state}
              </span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function StatusMetric({
  label,
  value
}: Readonly<{ label: string; value: string }>) {
  return (
    <div className="status-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
