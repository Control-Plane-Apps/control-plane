#!/usr/bin/env python3
"""Two-server check of the Assistant's cross-server reach.

Drives real agent turns on two fresh test servers, linked both ways with
link.ts: the "mini" runs the user's Assistant, the "macbook" runs Projects
and their coordinators. Each step asks an agent to call one tool and reply
with its raw result, then prints that reply as the transcript.

Usage:
  e2e.py seed                 create the Assistant and the Projects
  e2e.py step <server> <thread> <prompt...>   run one turn, print the reply
  e2e.py read <server> <thread> [n]           print the last n messages

Env: REACH_E2E_DIR (default /tmp/cs-it) holds <server>.op operator tokens.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

DIR = os.environ.get("REACH_E2E_DIR", "/tmp/cs-it")
SERVERS = {"mini": "http://127.0.0.1:47781", "macbook": "http://127.0.0.1:47782"}
MODEL = {"instanceId": "claudeAgent", "model": "claude-sonnet-4-6"}
NOW = lambda: time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def token(server):
    with open(f"{DIR}/{server}.op") as handle:
        return handle.read().strip()


def http(server, method, path, body=None):
    request = urllib.request.Request(
        SERVERS[server] + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"authorization": f"Bearer {token(server)}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} -> {error.code}: {error.read()[:400]!r}")


def dispatch(server, command):
    command.setdefault("commandId", f"e2e:{uuid.uuid4()}")
    return http(server, "POST", "/api/orchestration/dispatch", command)


def project(server, project_id, title, root, coordinator=None, scope=None):
    dispatch(server, {"type": "project.create", "projectId": project_id, "title": title,
                      "workspaceRoot": root, "createdAt": NOW()})
    if coordinator is None:
        return
    thread(server, coordinator, project_id, title)
    marker = {"coordinatorThreadId": coordinator}
    if scope:
        marker["scope"] = scope
    dispatch(server, {"type": "project.meta.update", "projectId": project_id,
                      "defaultModelSelection": MODEL, "assistant": marker})


def thread(server, thread_id, project_id, title):
    dispatch(server, {"type": "thread.create", "threadId": thread_id, "projectId": project_id,
                      "title": title, "modelSelection": MODEL, "runtimeMode": "full-access",
                      "interactionMode": "default", "branch": None, "worktreePath": None,
                      "createdAt": NOW()})


def seed():
    project("mini", "assistant-home", "Assistant", f"{DIR}/ws-mini/assistant",
            coordinator="mini-assistant", scope="global")
    project("macbook", "ht-test", "Hometrace (test)", f"{DIR}/ws-macbook/hometrace",
            coordinator="ht-coord")
    project("macbook", "lu-test", "Lucive (test)", f"{DIR}/ws-macbook/lucive",
            coordinator="lu-coord")
    project("macbook", "scratch", "Scratch", f"{DIR}/ws-macbook/scratch")
    thread("macbook", "ws-thread", "scratch", "Scratch notes")
    print("seeded")


def messages(server, thread_id, limit=40):
    detail = http(server, "GET", f"/api/orchestration/threads/{thread_id}?turnLimit={limit}")
    return detail["thread"]["messages"], detail["thread"]


def busy(snapshot):
    session = snapshot.get("session") or {}
    return session.get("status") in ("starting", "running")


def step(server, thread_id, prompt, timeout=300):
    before = {message["id"] for message in messages(server, thread_id)[0]}
    message_id = f"e2e-msg:{uuid.uuid4()}"
    dispatch(server, {"type": "thread.turn.start", "threadId": thread_id,
                      "message": {"messageId": message_id, "role": "user", "text": prompt,
                                  "attachments": []},
                      "runtimeMode": "full-access", "interactionMode": "default",
                      "createdAt": NOW()})
    deadline = time.time() + timeout
    time.sleep(5)
    while time.time() < deadline:
        found, snapshot = messages(server, thread_id)
        if not busy(snapshot):
            replies = [m for m in found if m["id"] not in before and m["role"] == "assistant"]
            if replies and not replies[-1].get("streaming"):
                return replies[-1]["text"]
        time.sleep(3)
    raise SystemExit(f"timed out waiting for {thread_id} on {server}")


def wait_for(server, thread_id, needle, timeout=300):
    """Waits until a user message containing `needle` lands in the thread."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        for message in messages(server, thread_id)[0]:
            if message["role"] == "user" and needle in message["text"]:
                return message
        time.sleep(3)
    raise SystemExit(f"no message with {needle!r} in {thread_id} on {server}")


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "seed":
        seed()
    elif command == "step":
        server, thread_id = sys.argv[2], sys.argv[3]
        prompt = " ".join(sys.argv[4:])
        print(f"### {server}/{thread_id} <- {prompt}\n")
        print(step(server, thread_id, prompt))
    elif command == "read":
        server, thread_id = sys.argv[2], sys.argv[3]
        count = int(sys.argv[4]) if len(sys.argv) > 4 else 6
        for message in messages(server, thread_id)[0][-count:]:
            source = (message.get("source") or {}).get("threadTitle", "")
            print(f"--- {message['role']} {message['id']} {source}\n{message['text']}\n")
    elif command == "wait":
        server, thread_id, needle = sys.argv[2], sys.argv[3], sys.argv[4]
        found = wait_for(server, thread_id, needle)
        print(f"--- {found['id']}\n{found['text']}")
    else:
        raise SystemExit(__doc__)
