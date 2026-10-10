// Derived from the pinned vendor/capture.mjs httpTransport (56f8f3b), which cannot be aborted.
// Only change: an AbortSignal; abort before the request is created sends nothing, abort later destroys the request.
import http from "node:http";
import https from "node:https";

export function abortableTransport(url, body, { timeoutMs, maxBytes, signal }) {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve({ kind: "aborted", httpStatus: null, bytes: Buffer.alloc(0), error: null, created: false }); return; }
    const chunks = [];
    let n = 0;
    let settled = false;
    let status = null;
    const onAbort = () => finish("aborted");
    const finish = (kind, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      req.destroy();
      resolve({ kind, httpStatus: status, bytes: Buffer.concat(chunks), error, created: true });
    };
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, { method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": body.length } }, (res) => {
      status = res.statusCode;
      res.on("data", (c) => {
        if (settled) return;
        const room = maxBytes - n;
        if (c.length > room) { chunks.push(c.subarray(0, room)); n += room; finish("oversize"); return; }
        chunks.push(c);
        n += c.length;
      });
      res.on("end", () => finish("complete"));
      res.on("error", (e) => finish("transport_error", e.code ?? "response_error"));
      res.on("aborted", () => finish("transport_error", "aborted"));
    });
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => finish("transport_error", e.code ?? "request_error"));
    req.end(body);
  });
}
