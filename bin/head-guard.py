#!/usr/bin/env python3
"""
@author Shakib
@since 08/10/26

PreToolUse hook (Command Code and CodeBuddy) for Hydra's Heads: denies a write or edit whose real path is outside the project
and the folders the Heads may also write to.
Usage: head-guard.py <project root> [<write dir> ...], with the hook's JSON on stdin.

Strict mode (Command Code on native Windows, where its path rules cannot name a drive): head-guard.py --policy <file>.
The hook then runs before every tool call and is the whole lockdown: a tool it does not know is denied, reads and writes
stay inside the folders the policy names, and `.env` files, credential folders and `.hydraignore` matches are never touched.
"""
import json
import os
import sys

WRITE_TOOLS = {"write_file", "edit_file", "Write", "Edit", "MultiEdit", "NotebookEdit"}
WRITE_NAMES = {"WRITE", "EDIT"}

# Strict mode: Command Code's own tool names. Everything else (shell, PowerShell, grep, subagents, web, MCP) is denied.
STRICT_WRITE = {"write_file", "edit_file"}
STRICT_READ = {"read_file", "read_directory", "glob"}
STRICT_FREE = {"todo_write", "search_tools", "tool_search"}
STRICT_WHY = {
    "grep": "search reads every file it walks, so it is off for Heads on Windows. Use glob to find files and read_file to read them.",
    "read_multiple_files": "it reads files by pattern, which Hydra cannot check. Read each file with read_file.",
    "shell_command": "Heads have no shell on Windows.",
    "powershell": "Heads have no shell on Windows.",
}
# Keys that hold file content or edit text, not a path (Command Code's aliases, compared without case or underscores).
CONTENT_KEYS = {
    "content", "text", "body", "data", "contents", "filecontent",
    "oldstring", "oldvalue", "old", "oldstr", "from", "oldtext", "oldcontent",
    "newstring", "newvalue", "new", "newstr", "to", "newtext", "newcontent",
}
GLOB_PATTERN_KEYS = {"pattern", "query", "glob", "expression", "search", "include"}
WILDCARDS = "*?[{"


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": f"{reason} Do not retry it: Heads write only inside the project and the folders the Lead granted.",
    }}))


def is_inside(path, root):
    # normcase makes the comparison case-insensitive and slash-agnostic on Windows, and is a no-op elsewhere.
    path, root = os.path.normcase(path), os.path.normcase(root)
    prefix = root if root.endswith(os.sep) else root + os.sep  # a drive root ("C:\") or "/" already ends with one
    return path == root or path.startswith(prefix)


def main():
    if sys.argv[1:2] == ["--policy"]:
        return strict(sys.argv[2])
    roots = [os.path.realpath(root) for root in sys.argv[1:]]
    root = roots[0]
    event = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))  # the hook's JSON is UTF-8, whatever the console code page
    if event.get("tool_name") not in WRITE_TOOLS and event.get("tool_display_name") not in WRITE_NAMES:
        return
    tool_input = event.get("tool_input") or {}
    raw = tool_input.get("file_path") or tool_input.get("path") or tool_input.get("notebook_path")
    if not isinstance(raw, str) or not raw.strip():
        deny("Hydra could not tell which file this call writes.")
        return
    path = os.path.realpath(os.path.join(event.get("cwd") or root, os.path.expanduser(raw)))
    if not any(is_inside(path, allowed) for allowed in roots):
        deny(f"Hydra: {raw} is outside the project.")


def spellings(paths):
    """Each folder as given and as its real path, so a link in either spelling cannot slip past."""
    out = []
    for path in paths:
        for spelling in (os.path.abspath(path), os.path.realpath(path)):
            if spelling not in out:
                out.append(spelling)
    return out


def load_policy(file):
    with open(file, encoding="utf-8") as handle:
        policy = json.load(handle)
    write = [p for p in policy.get("write") or [] if isinstance(p, str) and p]
    if not write:
        raise ValueError("the policy names no project")
    read = write + [p for p in policy.get("read") or [] if isinstance(p, str) and p]
    home = policy.get("home") or ""
    secrets = [os.path.join(home, rel) for rel in policy.get("secrets") or []] if home else []
    return {
        "project": os.path.abspath(write[0]),
        "write": spellings(write),
        "read": spellings(read),
        "guarded": spellings([p for p in policy.get("guarded") or [] if isinstance(p, str) and p]),
        "secrets": spellings(secrets),
    }


def parts(path):
    """A path's names as Windows opens them: trailing dots and spaces dropped (`.env.` and `.env ` open `.env`), lower case."""
    names = []
    for name in os.path.normcase(path).replace("\\", "/").split("/"):
        trimmed = name.rstrip(" .")
        names.append((trimmed or name).lower())
    return names


def is_env(name):
    return name == ".env" or name.startswith(".env.")


def path_refusal(raw, base, policy, writing):
    """Why a path may not be read (or written), or None. Both its spelling and its real location must pass."""
    if not isinstance(raw, str) or not raw.strip() or "\0" in raw:
        return "Hydra could not tell which file this call uses."
    if raw.replace("/", "\\").startswith(("\\\\?\\", "\\\\.\\")):
        return f"Hydra: {raw} is a device path, which a Head never uses."
    drive, rest = os.path.splitdrive(raw)
    if ":" in rest:
        return f"Hydra: {raw} names an alternate data stream, which a Head never uses."
    joined = os.path.join(base, os.path.expanduser(raw))
    allowed = policy["write"] if writing else policy["read"]
    for path in (os.path.abspath(joined), os.path.realpath(joined)):
        if not any(is_inside(path, root) for root in allowed):
            return f"Hydra: {raw} is outside the project."
        if any(is_inside(path, secret) for secret in policy["secrets"]):
            return f"Hydra: {raw} is a credential folder, which a Head never reads."
        if any(is_inside(path, guarded) for guarded in policy["guarded"]):
            return f"Hydra: {raw} is named in .hydraignore, which a Head never reads."
        names = parts(path)
        if any(is_env(name) for name in names):
            return f"Hydra: {raw} is a .env file, which a Head never reads."
        if writing:
            root = next(root for root in allowed if is_inside(path, root))
            below = parts(os.path.relpath(path, root)) if os.path.normcase(path) != os.path.normcase(root) else []
            if any(name in (".git", ".commandcode") for name in below) or (below and below[-1] == ".hydraignore"):
                return f"Hydra: {raw} is protected (.git, .commandcode and .hydraignore stay as they are)."
    return None


def glob_refusal(pattern, base, policy):
    """A glob may only look below the folder its fixed prefix names, and never climb out through `..` or an absolute brace."""
    if not isinstance(pattern, str):
        return None
    cut = min([pattern.index(c) for c in WILDCARDS if c in pattern] or [len(pattern)])
    head, tail = pattern[:cut], pattern[cut:]
    norm_tail = tail.replace("\\", "/")
    if ".." in norm_tail.split("/") or any(bad in norm_tail for bad in (":", "~", "{/", ",/", "/..")):
        return f"Hydra: the pattern {pattern} could reach outside the project."
    prefix = head[: max(head.replace("\\", "/").rfind("/"), 0)] if tail else head
    return path_refusal(prefix or ".", base, policy, writing=False)


def strings(value, key=""):
    """Every string in a tool's input with the key it sits under, skipping file content and edit text."""
    if isinstance(value, dict):
        for k, v in value.items():
            if str(k).replace("_", "").lower() not in CONTENT_KEYS:
                yield from strings(v, str(k))
    elif isinstance(value, list):
        for v in value:
            yield from strings(v, key)
    elif isinstance(value, str):
        yield key, value


def strict_refusal(event, policy):
    tool = event.get("tool_name")
    if tool in STRICT_FREE:
        return None
    if tool not in STRICT_READ and tool not in STRICT_WRITE:
        why = STRICT_WHY.get(tool, "Hydra does not know what it can reach, so Heads do not use it on Windows.")
        return f"Hydra: {tool or 'this tool'} is not available to a Head here: {why}"
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict):
        return "Hydra could not tell which file this call uses."
    base = event.get("cwd") or policy["project"]
    if base and not any(is_inside(os.path.realpath(base), root) for root in policy["read"]):
        base = policy["project"]
    writing = tool in STRICT_WRITE
    found = list(strings(tool_input))
    if tool == "read_file" or writing:
        if not any(v.strip() for _, v in found):
            return "Hydra could not tell which file this call uses."
    for key, value in found:
        if tool == "glob" and key.replace("_", "").lower() in GLOB_PATTERN_KEYS:
            refusal = glob_refusal(value, base, policy)
        elif not value.strip():
            continue
        else:
            refusal = path_refusal(value, base, policy, writing)
        if refusal:
            return refusal
    return None


def strict(policy_file):
    event = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    refusal = strict_refusal(event, load_policy(policy_file))
    if refusal:
        deny(refusal)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # A guard that cannot decide denies: the engine runs the tool when a hook fails.
        deny(f"Hydra's write guard failed ({error}).")
