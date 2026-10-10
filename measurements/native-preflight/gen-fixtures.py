#!/usr/bin/env python3
"""Regenerates fixtures/*.json deterministically. Synthetic pins are sha1 of labels: not real heads."""
import copy, hashlib, json, subprocess
h1 = lambda s: hashlib.sha1(s.encode()).hexdigest()
h2 = lambda s: hashlib.sha256(s.encode()).hexdigest()
def tree(c): return subprocess.check_output(["git", "rev-parse", c + "^{tree}"]).decode().strip()
PM="0x498581ff718922c3f8e6a244956af099b2652b2b"
TI="0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"
TS="0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
FAC=sorted(["0xe3ab924c72463c1ac8d1d8352ee640b89eb1ea64","0xa52ad458ce0282a971ecc71c051a32f28946bb9f","0x1de58a6769526a03a504d9d59b8757cd8097dc57","0xff70918ef17a2d74d683a8297813b177bafad1f4","0x1176122eb77ad6a2339322cda7c4d7ea9bfa63dc","0xb9e5910043353717af54d8dd34b6ee57ffe49c35"])
FILT=[{"address":[PM],"topics":[[TI,TS]]},{"address":FAC}]
DIG="8b5e28aa1ca300ea4b70d2f338c79a0800196823bc0dcac224a36ab7a36146ca"
C173="5206f9035ad1c057d78990b294941221e936f895"; J54="54ba98a98bce1eb307852861deb394ef196638ae"; MAIN="56fde238e85ac34268d958578bed291802ed99f7"
S={k:h1("synthetic-"+k) for k in ["collector","nativePath","reference","rawWriter"]}
ST={k:h1("synthetic-tree-"+k) for k in S}; SM={k:h2("synthetic-manifest-"+k) for k in S}
BOOT="0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"
fresh={"source":"operator_supplied","maxAgeS":5,"maxEvidenceAgeS":300,
 "http":{"observedAtUtc":"2026-10-10T05:35:41Z","head":52410596,"ageS":2.12},
 "ws":{"observedAtUtc":"2026-10-10T05:36:21Z","heads":[52410615,52410616,52410617],"ageS":0.40},"recovery":"complete"}
win={"startNs":"1000000000000","endNs":"4600000000000","clock":"mono_ns"}
clk={"host_id":"lab-host-1","boot_id":BOOT,"unit":"ns","clock_uncert_ms":0.05,"clock_uncert_evidence":{"method":"synthetic chrony tracking excerpt","ref":"lab/clock-2026-10-10.txt"}}
ok={"schema":"native-preflight-input/2","fixture":"SYNTHETIC corrected, fully supplied; sha1-label pins are not real heads; READY only with the test-only synthetic registry","asOfUtc":"2026-10-10T05:36:30Z",
 "claimScope":["native_collector_run"],
 "pins":{k:{"commit":S[k],"tree":ST[k],"manifestSha256":SM[k]} for k in ["collector","nativePath","reference"]},
 "filters":{"collector":{"digest":DIG,"filters":FILT},"reference":{"digest":DIG,"filters":copy.deepcopy(FILT)}},
 "window":{"collector":dict(win),"reference":dict(win)},"clock":{"collector":dict(clk),"reference":dict(clk)},
 "provenance":{"source_id":"base-node-lab","capture_source":"live_ws","endpoint":"ws://127.0.0.1:8546","client_version":"lab/v0","decoder_version":"dec/1","registry_version":"reg/1","license_class":"own_node","partition":"base/2026-10-10","rawWriter":{"location":"/lab/tier0","pin":S["rawWriter"]}},
 "caps":{"reconnect":1,"wsMessages":1000000,"wsBytes":1073741824,"backfillBlocks":1900,"enforcedInSource":True,"enforcementPin":S["collector"]},
 "freshness":copy.deepcopy(fresh),
 "defects":{k:{"state":"resolved"} for k in ["M1","M2","provenance","inSourceCaps","jointIntegration"]}}
current={"schema":"native-preflight-input/2","fixture":"current manifest: #173 5206f90, joint 54ba98a (unwired); latest supplied 05:47:11Z HTTP + 05:36 WS; Aromer stale","asOfUtc":"2026-10-10T05:47:20Z",
 "claimScope":["native_collector_run"],
 "pins":{"collector":{"commit":C173,"tree":tree(C173),"manifestSha256":"unknown"},"nativePath":{"commit":J54,"tree":tree(J54),"manifestSha256":"e10b83697a6842524d3e2eba2d1e9e55c44837c2e97b30ac94f2ddde0dd6809f"},"reference":{"commit":C173,"tree":tree(C173),"manifestSha256":"unknown"}},
 "filters":{"collector":{"digest":DIG,"filters":FILT},"reference":{"digest":DIG,"filters":FILT}},
 "window":{"collector":None,"reference":None},"clock":{"collector":None,"reference":None},
 "provenance":{"source_id":None,"capture_source":"unknown","endpoint":None,"client_version":None,"decoder_version":None,"registry_version":None,"license_class":"unknown","partition":None,"rawWriter":None},
 "caps":{"reconnect":None,"wsMessages":None,"wsBytes":None,"backfillBlocks":43200,"enforcedInSource":False,"enforcementPin":None},
 "freshness":{"source":"operator_supplied","maxAgeS":5,"maxEvidenceAgeS":300,"http":{"observedAtUtc":"2026-10-10T05:47:11Z","head":52410942,"ageS":0.72},"ws":{"observedAtUtc":"2026-10-10T05:36:21Z","heads":[52410615,52410616,52410617],"ageS":0.40},"recovery":"complete"},
 "aromer":{"observedAtUtc":"2026-10-10T05:47:11Z","pid":18507,"head":52318772,"ageS":184340.7,"processed":86352,"feedState":"down"},
 "defects":{k:{"state":"unresolved"} for k in ["M1","M2","provenance","inSourceCaps","jointIntegration"]}}
fx={"current-0547":current,"corrected-full":ok}
def mut(name, desc, f):
    x=copy.deepcopy(ok); x["fixture"]="SYNTHETIC "+desc; f(x); fx[name]=x
mut("invalid-asof","asOfUtc 2026-99-99T99:99:99Z",lambda x:x.update(asOfUtc="2026-99-99T99:99:99Z"))
mut("invalid-observedat","http observedAtUtc 2026-13-45T00:00:00Z",lambda x:x["freshness"]["http"].update(observedAtUtc="2026-13-45T00:00:00Z"))
mut("feb30","ws observedAtUtc 2026-02-30",lambda x:x["freshness"]["ws"].update(observedAtUtc="2026-02-30T05:36:21Z"))
def fm(x):
    x["pins"]["collector"]={"commit":MAIN,"tree":tree(MAIN),"manifestSha256":h2("x")}; x["caps"]["enforcementPin"]=MAIN
mut("forkmain-collector","fork main 56fde238 as collector with resolved flags",fm)
mut("nativepath-173","nativePath 5206f90 with jointIntegration resolved",lambda x:x["pins"].update(nativePath={"commit":C173,"tree":tree(C173),"manifestSha256":h2("y")}))
mut("nativepath-54","nativePath 54ba98a (unwired) with jointIntegration resolved",lambda x:x["pins"].update(nativePath={"commit":J54,"tree":tree(J54),"manifestSha256":"e10b83697a6842524d3e2eba2d1e9e55c44837c2e97b30ac94f2ddde0dd6809f"}))
mut("tree-mismatch","collector tree differs from reviewed binding",lambda x:x["pins"]["collector"].update(tree=h1("other")))
mut("one-ns-window","1 ns window",lambda x:[x["window"][a].update(endNs="1000000000001") for a in ("collector","reference")])
mut("window-over-int64","endNs above int64",lambda x:[x["window"][a].update(endNs="9223372036854775808") for a in ("collector","reference")])
mut("window-over-24h","25 h window",lambda x:[x["window"][a].update(endNs=str(1000000000000+25*3600*10**9)) for a in ("collector","reference")])
mut("noncanonical-identical","both arms identical but drop one factory",lambda x:[x["filters"][a]["filters"][1]["address"].pop() for a in ("collector","reference")])
mut("mismatched-filters","reference drops one factory, digest differs",lambda x:(x["filters"]["reference"]["filters"][1]["address"].pop(),x["filters"]["reference"].update(digest=h2("d"))))
mut("mismatched-clock","reference other boot_id and ms unit",lambda x:x["clock"]["reference"].update(boot_id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",unit="ms"))
mut("unbounded-threshold","maxAgeS 1e9, maxEvidenceAgeS 1e12",lambda x:x["freshness"].update(maxAgeS=1e9,maxEvidenceAgeS=1e12))
mut("stale","http evidence 66 min old, head age 30 s",lambda x:x["freshness"]["http"].update(observedAtUtc="2026-10-10T04:30:00Z",ageS=30))
mut("partial-recovery","recovery partial, ws head gap",lambda x:(x["freshness"].update(recovery="partial"),x["freshness"]["ws"].update(heads=[52410615,52410617])))
mut("http-ws-inconsistent","ws heads 1000 blocks behind http",lambda x:x["freshness"]["ws"].update(heads=[52409615,52409616]))
mut("placeholder-values","pending/placeholder strings and repeated-char pin",lambda x:(x["provenance"].update(client_version="pending",decoder_version="PLACEHOLDER-v1"),x["pins"]["reference"].update(commit="a"*40)))
mut("unknown-proof","client_version unknown, writer location null, M2 flag absent",lambda x:(x["provenance"].update(client_version="unknown"),x["provenance"]["rawWriter"].update(location=None),x["defects"].pop("M2")))
mut("raw-ref-supplied","raw_ref and t_ingest pre-supplied",lambda x:x["provenance"].update(raw_ref={"file":"f","offset":0,"sha256":h2("r")},t_ingest="1"))
mut("stale-aromer-native","stale Aromer observation, claimScope native only",lambda x:x.update(aromer=copy.deepcopy(current["aromer"]),asOfUtc="2026-10-10T05:47:20Z") or x["freshness"].update(http={"observedAtUtc":"2026-10-10T05:47:11Z","head":52410942,"ageS":0.72},ws={"observedAtUtc":"2026-10-10T05:47:15Z","heads":[52410943,52410944],"ageS":0.4}))
mut("stale-aromer-claimed","stale Aromer with aromer_measurement claimed",lambda x:x.update(aromer=copy.deepcopy(current["aromer"]),claimScope=["native_collector_run","aromer_measurement"]))
A_FRESH={"observedAtUtc":"2026-10-10T05:47:11Z","pid":18507,"head":52410942,"ageS":0.5,"processed":90000,"feedState":"up"}
def aro(desc, a, scope=("native_collector_run","aromer_measurement")):
    def f(x):
        fx["stale-aromer-native"]  # base on native-only fresh node at 05:47
        x.update(copy.deepcopy({k:v for k,v in fx["stale-aromer-native"].items() if k in ("asOfUtc","freshness")}))
        x["aromer"]=a; x["claimScope"]=list(scope)
    return f
mut("aromer-fresh-claimed","Aromer head consistent with node, aromer_measurement claimed",aro("",A_FRESH))
mut("aromer-future","Aromer observedAtUtc after asOfUtc",aro("",{**A_FRESH,"observedAtUtc":"2026-10-10T06:00:00Z"}))
mut("aromer-lagging-age04","Aromer head 52318772 paired with ageS 0.4, feed up",aro("",{**A_FRESH,"head":52318772,"ageS":0.4}))
mut("aromer-ahead-age04","Aromer head node+1e6 paired with ageS 0.4",aro("",{**A_FRESH,"head":52410942+1000000,"ageS":0.4}))
mut("aromer-lagging-native","lagging Aromer reported, native-only scope",aro("",{**A_FRESH,"head":52318772,"ageS":0.4},("native_collector_run",)))
mut("clock-uncert-zero","clock_uncert_ms 0 with evidence",lambda x:[x["clock"][a].update(clock_uncert_ms=0) for a in ("collector","reference")])
mut("clock-uncert-no-evidence","clock_uncert_ms without evidence",lambda x:[x["clock"][a].pop("clock_uncert_evidence") for a in ("collector","reference")])
mut("nested-raw-ref","provenance.extra.raw_ref, provenance.rawRef, provenance.fields.t_ingest",lambda x:x["provenance"].update(extra={"raw_ref":"r"},rawRef="r",fields={"t_ingest":"1"}))
mut("forbidden-alias-family","nested outcome-family aliases",lambda x:x["caps"].update(extra=[{"latencyAddedMs":1},{"p99AddedMs":1},{"DAT_SRC_011_RESULT":1},{"admission_result":1},{"admissionResult":1},{"outcomeSummary":1},{"passRate":1},{"readyState":1},{"verdictText":1},{"successRate":1}]))
def claim(x):
    x.clear(); x.update(copy.deepcopy(current)); x["fixture"]="current manifest; operator claims M1 resolved at 5206f90"; x["defects"]["M1"]={"state":"resolved"}
mut("claim-resolved-on-173","",claim)
mut("forbidden-outcome","dat_src_011 outcome",lambda x:x.update(dat_src_011={"pass":True}))
mut("forbidden-alias-nested","nested Latency_ms and DAT-SRC-011 aliases",lambda x:x["provenance"].update(notes={"Latency_ms":3,"DAT-SRC-011":"ok"}))
mut("self-attested-registry","operator supplies reviewedPins and ownerRecords",lambda x:x.update(reviewedPins={"collector":[x["pins"]["collector"]]},ownerRecords={"Q1":{"decision":"x","ref":"y"}}))
mut("old-schema","schema native-preflight-input/1",lambda x:x.update(schema="native-preflight-input/1"))
for n,x in fx.items():
    with open(f"fixtures/{n}.json","w") as f: json.dump(x,f,indent=2); f.write("\n")
with open("fixtures/SYNTHETIC-REGISTRY.test-only.json.txt","w") as f:
    json.dump({"registry":{k:[{"commit":S[k],"tree":ST[k],"manifestSha256":SM[k],"resolves":({"collector":["M1","M2","provenance","inSourceCaps"],"nativePath":["jointIntegration"]}.get(k,[]))}] for k in S},
               "ownerRecords":{"Q1":{"decision":"synthetic","ref":"synthetic"},"Q2":{"decision":"synthetic","ref":"synthetic"}}},f,indent=2); f.write("\n")
print(len(fx))
