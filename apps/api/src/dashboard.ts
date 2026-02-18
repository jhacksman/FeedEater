import type { Request, Response } from "express";

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FeedEater — Module Health</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem}
h1{font-size:1.5rem;margin-bottom:.25rem}
.subtitle{color:#94a3b8;font-size:.875rem;margin-bottom:1.5rem}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:.5rem;overflow:hidden}
th{text-align:left;padding:.75rem 1rem;background:#334155;color:#cbd5e1;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em}
td{padding:.75rem 1rem;border-top:1px solid #334155;font-size:.875rem}
tr:hover td{background:#262f3f}
.dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;margin-right:.5rem}
.healthy .dot{background:#22c55e}
.stale .dot{background:#eab308}
.offline .dot{background:#ef4444}
.healthy .label{color:#22c55e}
.stale .label{color:#eab308}
.offline .label{color:#ef4444}
.status-cell{display:flex;align-items:center}
.empty{text-align:center;padding:2rem;color:#64748b}
.updated{color:#64748b;font-size:.75rem;margin-top:1rem;text-align:right}
.mono{font-family:"SF Mono",SFMono-Regular,Consolas,monospace;font-size:.8125rem}
.count{text-align:right}
</style>
</head>
<body>
<h1>FeedEater Module Health</h1>
<p class="subtitle">Auto-refreshes every 10 seconds</p>
<table>
<thead><tr><th>Module</th><th>Status</th><th>Last Message</th><th class="count">Messages</th></tr></thead>
<tbody id="tbody"><tr><td colspan="4" class="empty">Loading\u2026</td></tr></tbody>
</table>
<p class="updated" id="updated"></p>
<script>
async function refresh(){
  try{
    const r=await fetch("/api/health/modules");
    const d=await r.json();
    const tb=document.getElementById("tbody");
    if(!d.modules||d.modules.length===0){
      tb.innerHTML='<tr><td colspan="4" class="empty">No modules reporting yet</td></tr>';
    }else{
      tb.innerHTML=d.modules.map(function(m){
        var ago=m.lastMessage?timeAgo(new Date(m.lastMessage)):"\u2014";
        return '<tr><td class="mono">'+esc(m.module)+'</td>'
          +'<td><span class="status-cell '+esc(m.status)+'"><span class="dot"></span><span class="label">'+esc(m.status)+'</span></span></td>'
          +'<td>'+esc(ago)+'</td>'
          +'<td class="count">'+Number(m.messageCount).toLocaleString()+'</td></tr>';
      }).join("");
    }
    document.getElementById("updated").textContent="Updated "+new Date().toLocaleTimeString();
  }catch(e){
    console.error("refresh failed",e);
  }
}
function timeAgo(d){
  var s=Math.floor((Date.now()-d.getTime())/1000);
  if(s<60)return s+"s ago";
  var m=Math.floor(s/60);
  if(m<60)return m+"m ago";
  var h=Math.floor(m/60);
  if(h<24)return h+"h ago";
  return Math.floor(h/24)+"d ago";
}
function esc(t){return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
refresh();
setInterval(refresh,10000);
</script>
</body>
</html>`;

export function getDashboard(_req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(HTML);
}
