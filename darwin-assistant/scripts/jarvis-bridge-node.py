#!/usr/bin/env python3
"""Hand-dispatch one hopper node NOW, bypassing the governor hold.

Interim tool until the provider-aware governor (tree-61ef8c24) ships: the
engine's dispatchTick holds ALL claims while Kevin is active, but Kevin has
greenlit codex/auggie workers running during his workday. This claims the
node exactly like dispatchTick would (running, attempts+1, lease, worker
thread) and sends the same worker prompt, so the normal finish contract and
reconciler still govern it.

Usage: python3 scripts/jarvis-bridge-node.py <node_id> [lease_minutes=45]
"""
import sys, json, sqlite3, secrets, urllib.request

DB = "/home/kevin/paperclip/darwin-assistant/jarvis.db"
BASE = "http://localhost:3201/api/v1"
KEY = next(l.split("=", 1)[1].strip() for l in open("/home/kevin/paperclip/jarvis-command-center/.env")
           if l.startswith("JARVIS_COCKPIT_KEY="))


def api(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Authorization": "Bearer " + KEY,
                                          **({"Content-Type": "application/json"} if data else {})})
    body = urllib.request.urlopen(req, timeout=20).read().decode()
    return json.loads(body) if body.strip() else {}


def main():
    node_id = int(sys.argv[1])
    lease_min = int(sys.argv[2]) if len(sys.argv) > 2 else 45
    db = sqlite3.connect(DB, timeout=20)
    n = db.execute("SELECT id,title,spec,depends_on,tree_id,adapter,model,status,answer,question,attempts"
                   " FROM hopper_nodes WHERE id=?", (node_id,)).fetchone()
    if not n:
        sys.exit(f"node {node_id} not found")
    if n[7] not in ("pending", "blocked"):
        sys.exit(f"node {node_id} is '{n[7]}' — only pending/blocked nodes can be bridged")
    for dep in json.loads(n[3] or "[]"):
        ds = db.execute("SELECT status FROM hopper_nodes WHERE id=?", (dep,)).fetchone()
        if ds and ds[0] not in ("done", "split"):
            sys.exit(f"dependency node {dep} is '{ds[0]}' — not ready")
    tree = db.execute("SELECT id,topic FROM hopper_trees WHERE id=?", (n[4],)).fetchone()
    deps = [db.execute("SELECT title,result FROM hopper_nodes WHERE id=?", (d,)).fetchone()
            for d in json.loads(n[3] or "[]")]

    adapter, model = n[5] or "claude", n[6]
    ext = f"cockpit:hopper-node-{node_id}-bridge{secrets.token_hex(3)}"

    lines = [
        "You are a SPAWNED HOPPER-ENGINE WORKER — an ephemeral JARVIS instance born to complete ONE task, report the result, and stop. You are not a conversation; nobody will reply to your messages. Kevin sees your work through the tree, not this thread.",
        "", f"**Project (tree {tree[0]}):** {tree[1]}", f"**Your task (node #{n[0]}):** {n[1]}"]
    if n[2]:
        lines += ["", "**Spec:**", n[2]]
    if n[8]:
        lines += ["", "**Kevin answered a previous blocking question on this task:**", f"Q: {n[9] or '(see spec)'}", f"A: {n[8]}"]
    real_deps = [d for d in deps if d and d[1]]
    if real_deps:
        lines += ["", "**Results from tasks this one depends on:**"]
        for t, r in real_deps:
            lines.append(f"- {t}: {r[:1500]}")
    lines += [
        "",
        "**Guardrails (hard):** no touching live production systems/databases, no merging to main, no external sends (Slack/email/PRs) under Kevin's identity, no new spend, and NO API KEYS for model calls — subscription CLI binaries only.",
        "",
        "**FINISH CONTRACT — mandatory.** Your final act MUST be exactly one curl to the hopper engine (bearer key = JARVIS_COCKPIT_KEY in /home/kevin/paperclip/jarvis-command-center/.env). Ending your turn without calling it counts as a failed attempt. DO NOT merely print the JSON — EXECUTE the curl and confirm the response shows the node status changed.",
        "```",
        "KEY=$(grep -E '^JARVIS_COCKPIT_KEY=' /home/kevin/paperclip/jarvis-command-center/.env | head -1 | cut -d= -f2)",
        f"curl -s -X POST http://localhost:3201/api/v1/hopper-nodes/{node_id}/finish -H \"Authorization: Bearer $KEY\" -H 'Content-Type: application/json' -d '<PAYLOAD>'",
        "```",
        "Pick ONE payload:",
        '- Task complete → {"outcome":"done","result":"<what you did + artifacts/paths/commits — dependents read this>"}',
        '- You need ONE decision only Kevin can make → {"outcome":"blocked_question","question":"<the single question, answerable cold>"} — then stop.',
        '- Genuinely stuck → {"outcome":"blocked","result":"<why, precisely>"}',
        "", "Work efficiently, verify what you build, and do not gold-plate. Begin now."]
    prompt = "\n".join(lines)

    api("POST", "/threads", {"external_id": ext, "label": f"⚙️ hopper n{node_id} · bridge · {adapter}/{model or 'default'}"})
    if model:
        api("PATCH", f"/threads/{urllib.request.quote(ext, safe='')}/model", {"adapter": adapter, "model": model})
    db.execute("UPDATE hopper_nodes SET status='running', attempts=attempts+1, worker_thread_ext=?,"
               " lease_expires_at=datetime('now', ?) WHERE id=?", (ext, f"+{lease_min} minutes", node_id))
    db.commit(); db.close()
    r = api("POST", f"/threads/{urllib.request.quote(ext, safe='')}/messages", {"text": prompt})
    print(f"node {node_id} bridged -> {ext} ({adapter}/{model}), attempt {n[10]+1}, lease {lease_min}m, message {r.get('message_id')}")


if __name__ == "__main__":
    main()
