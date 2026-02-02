import { LiveContextsFeed } from "../../components/LiveContextsFeed";

export default function ContextsPage() {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ fontSize: 20, fontWeight: 700 }}>Contexts</div>
      <LiveContextsFeed />
    </div>
  );
}
