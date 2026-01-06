"use client";

import { useEffect, useMemo, useState } from "react";

type ModuleManifest = {
  name: string;
  version: string;
  namespace: string;
};

type ModuleJob = {
  name: string;
  queue: string;
  schedule?: string;
  triggeredBy?: string;
  description?: string;
};

type ModuleManifestWithJobs = ModuleManifest & { jobs?: ModuleJob[] };

type RunJobResponse = { ok: true; jobId: string | number; queue: string; job: string; module: string } | { ok: false; error: string };

export function JobsRunPanel() {
  const [modules, setModules] = useState<ModuleManifestWithJobs[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [result, setResult] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/modules", { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load modules (${res.status})`);
        const data = (await res.json()) as { modules: ModuleManifestWithJobs[] };
        if (cancelled) return;
        setModules(data.modules ?? []);
      } catch (e) {
        if (cancelled) return;
        setResult((p) => ({ ...p, __load: e instanceof Error ? e.message : String(e) }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const scheduled = useMemo(() => {
    const out: Array<{ module: string; job: ModuleJob }> = [];
    for (const m of modules ?? []) {
      for (const j of m.jobs ?? []) {
        if (j.schedule) out.push({ module: m.name, job: j });
      }
    }
    out.sort((a, b) => `${a.module}.${a.job.name}`.localeCompare(`${b.module}.${b.job.name}`));
    return out;
  }, [modules]);

  async function runNow(moduleName: string, jobName: string) {
    const key = `${moduleName}.${jobName}`;
    setRunning((p) => ({ ...p, [key]: true }));
    setResult((p) => ({ ...p, [key]: "" }));
    try {
      const res = await fetch("/api/jobs/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ module: moduleName, job: jobName }),
      });
      const json = (await res.json().catch(() => null)) as RunJobResponse | null;
      if (!res.ok || !json) {
        const body = await res.text().catch(() => "");
        throw new Error(`Run failed (${res.status}) ${body}`);
      }
      if (!json.ok) throw new Error(json.error);
      setResult((p) => ({ ...p, [key]: `Enqueued (jobId=${String(json.jobId)})` }));
    } catch (e) {
      setResult((p) => ({ ...p, [key]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRunning((p) => ({ ...p, [key]: false }));
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 12,
        background: "rgba(255,255,255,0.03)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <div style={{ fontWeight: 700 }}>Run now</div>
        <div className="muted" style={{ fontSize: 12 }}>
          Manual triggers are enabled for scheduled jobs only
        </div>
      </div>

      {result.__load ? (
        <div style={{ marginTop: 8, color: "rgba(255,120,120,0.9)", fontSize: 12 }}>{result.__load}</div>
      ) : null}

      <div style={{ height: 10 }} />

      {loading || !modules ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Loading…
        </div>
      ) : scheduled.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No scheduled jobs found.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {scheduled.map(({ module: moduleName, job }) => {
            const key = `${moduleName}.${job.name}`;
            const busy = Boolean(running[key]);
            const msg = result[key] ?? "";
            return (
              <div
                key={key}
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 14,
                  padding: 12,
                  background: "rgba(0,0,0,0.18)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                  <div style={{ fontWeight: 700 }}>
                    {moduleName}.{job.name}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    queue: <code>{job.queue}</code> · schedule: <code>{job.schedule}</code>
                  </div>
                </div>

                {job.description ? (
                  <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                    {job.description}
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
                  <button
                    onClick={() => void runNow(moduleName, job.name)}
                    disabled={busy}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid var(--border)",
                      background: "rgba(124,58,237,0.22)",
                      color: "var(--text)",
                      cursor: "pointer",
                      fontWeight: 700,
                    }}
                  >
                    {busy ? "Enqueuing…" : "Run now"}
                  </button>

                  {msg ? (
                    <div
                      className="muted"
                      style={{
                        fontSize: 12,
                        color: msg.startsWith("Enqueued") ? "rgba(170,255,200,0.9)" : "rgba(255,120,120,0.9)",
                      }}
                    >
                      {msg}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}


