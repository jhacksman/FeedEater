import { JobsRunPanel } from "../../components/JobsRunPanel";

export default function JobsPage() {
  return (
    <div className="card">
      <div style={{ fontSize: 20, fontWeight: 700 }}>Jobs (BullBoard)</div>
      <div style={{ height: 8 }} />
      <div className="muted">Embedded management UI for BullMQ queues.</div>
      <div style={{ height: 12 }} />

      <JobsRunPanel />
      <div style={{ height: 12 }} />

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 16,
          overflow: "hidden",
          height: "72vh",
          background: "rgba(0,0,0,0.2)",
        }}
      >
        <iframe
          title="BullBoard"
          src="/bullboard"
          style={{ width: "100%", height: "100%", border: 0 }}
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}


