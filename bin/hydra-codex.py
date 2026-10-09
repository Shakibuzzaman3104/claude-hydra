#!/usr/bin/env python3
"""Run a guarded Command Code Head from Codex CLI (stdlib only)."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid


ROOT = Path(__file__).resolve().parent.parent
RULES = Path('.commandcode/settings.local.json')
OWNER = 'hydra'
MODEL = 'deepseek/deepseek-v4.1-flash'
DONE = 'HEAD DONE'
EFFORTS = ('off', 'low', 'medium', 'high', 'xhigh', 'max')
HEAD_RULES = ("\n\nRules for this run: never answer with text alone until the whole task is "
              "finished. Every reply before then must make a tool call. A denied tool call stays "
              "denied: do not retry it, work around it or name it as a blocker. When everything "
              f"is done, end your final message with a short report and the line {DONE}.")
DANGEROUS_SHELL = [
    'Shell(git commit*)', 'Shell(git push*)', 'Shell(git reset*)', 'Shell(git checkout*)',
    'Shell(git switch*)', 'Shell(git restore*)', 'Shell(git stash*)', 'Shell(git clean*)',
    'Shell(git rebase*)', 'Shell(git merge*)', 'Shell(git branch -D*)', 'Shell(git tag*)',
    'Shell(gh *)', 'Shell(rm -r*)', 'Shell(rm -f*)', 'Shell(rm -R*)', 'Shell(sudo*)',
    'Shell(su *)', 'Shell(chmod*)', 'Shell(chown*)', 'Shell(curl*)', 'Shell(wget*)',
    'Shell(ssh*)', 'Shell(scp*)', 'Shell(rsync*)', 'Shell(nc *)', 'Shell(open *)',
    'Shell(osascript*)', 'Shell(launchctl*)', 'Shell(defaults write*)',
    'Shell(security *)', 'Shell(kill*)', 'Shell(pkill*)', 'Shell(xcodebuild*)',
    'Shell(swift build*)', 'Shell(swift test*)', 'Shell(npm publish*)',
    'Shell(npm install*)', 'Shell(pip install*)', 'Shell(brew *)',
]
PROJECT_DENY = [
    'Edit(/.git/**)', 'Edit(/.commandcode/**)', 'Read(.env)', 'Read(.env.*)',
    'Edit(.env)', 'Edit(.env.*)', 'Shell(* .env*)', 'Shell(*/.env*)', 'Shell(*=.env*)',
]


def within(path, root):
    return path == root or path.startswith(root.rstrip('/') + '/')


def unique(items):
    return list(dict.fromkeys(items))


def ways_down(roots):
    ways = {}
    for root in roots:
        base = ''
        for part in Path(root).parts[1:]:
            if any(base and within(base, other) for other in roots):
                break
            ways.setdefault(base, set()).add(part)
            base += '/' + part
    return ways


def outside_denies(roots):
    rules = []
    for base, allowed in ways_down(roots).items():
        rules.append(f'Edit(/{base}/*)')
        for name in os.listdir(base or '/'):
            if name not in allowed:
                path = f'{base}/{name}'.lstrip('/')
                rules.extend((f'Edit(//{path})', f'Edit(//{path}/**)'))
    return rules


def find_env(dirs):
    def fail(error):
        raise error
    for directory in dirs:
        for base, children, files in os.walk(directory, onerror=fail):
            children[:] = [name for name in children if name not in ('.git', 'node_modules')]
            for name in files:
                if name == '.env' or name.startswith('.env.'):
                    return str(Path(base) / name)
    return None


def guard_command(cwd, write_dirs):
    import shlex
    return ' '.join(shlex.quote(x) for x in (
        '/usr/bin/env', 'python3', '-I', str(ROOT / 'bin/head-guard.py'), cwd, *write_dirs
    ))


def settings_for(entries, cwd):
    write_dirs = unique(d for e in entries for d in e.get('writeDirs', []))
    add_dirs = unique(d for e in entries for d in e.get('addDirs', []))
    env = find_env([cwd, *write_dirs, *add_dirs])
    deny = outside_denies([cwd, *write_dirs]) + PROJECT_DENY
    for directory in write_dirs:
        deny.extend((f'Edit(/{directory}/.git/**)', f'Edit(/{directory}/.commandcode/**)',
                     f'Edit(/{directory}/**/.env)', f'Edit(/{directory}/**/.env.*)',
                     f'Read(/{directory}/**/.env)', f'Read(/{directory}/**/.env.*)'))
    deny.extend(DANGEROUS_SHELL if any(e.get('shell') for e in entries) else ['Shell'])
    if env:
        deny.append('Grep')
    return {
        'managedBy': OWNER, 'hydraHeads': entries,
        'permissions': {'deny': deny, 'additionalDirectories': unique([*add_dirs, *write_dirs])},
        'hooks': {'PreToolUse': [{'matcher': 'write|edit', 'hooks': [{
            'type': 'command', 'command': guard_command(cwd, write_dirs), 'timeout': 10
        }]}]},
    }, env


def lock_path(cwd):
    digest = hashlib.sha256(cwd.encode()).hexdigest()[:24]
    return Path(tempfile.gettempdir()) / f'hydra-{digest}.lock'


def update_rules(cwd, add=None, remove=None):
    path = Path(cwd) / RULES
    with open(lock_path(cwd), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        entries = []
        if path.exists():
            try:
                existing = json.loads(path.read_text())
            except (OSError, ValueError) as error:
                raise RuntimeError(f'{RULES} is not valid JSON: {error}') from error
            if existing.get('managedBy') != OWNER:
                raise RuntimeError(f'{RULES} contains your own rules; move them to .commandcode/settings.json')
            entries = existing.get('hydraHeads', [])
            if not isinstance(entries, list):
                raise RuntimeError(f'{RULES} has an invalid hydraHeads list')
        now = time.time() * 1000
        entries = [e for e in entries if isinstance(e, dict) and e.get('until', 0) > now
                   and e.get('key') != remove]
        if add:
            entries.append(add)
        if not entries:
            path.unlink(missing_ok=True)
            return None
        data, env = settings_for(entries, cwd)
        path.parent.mkdir(exist_ok=True)
        temporary = path.with_name(f'{path.name}.{os.getpid()}.tmp')
        try:
            temporary.write_text(json.dumps(data, indent=2) + '\n')
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return env


def validate_dirs(cwd, raw, writable=False):
    home = str(Path.home().resolve())
    result = []
    for item in raw:
        if not Path(item).is_absolute() or not Path(item).is_dir():
            raise ValueError(f'directory must be an existing absolute folder: {item}')
        real = str(Path(item).resolve())
        if writable and (real in ('/', home) or within(cwd, real) or within(real, cwd)):
            raise ValueError(f'write-dir is too broad or already inside the project: {item}')
        result.append(real)
    return unique(result)


def usage_report(session):
    if not session:
        return {'usd': None, 'files': [], 'denied': [], 'toolCalls': 0}
    try:
        output = subprocess.check_output([sys.executable, str(ROOT / 'bin/cc-usage.py'),
                                          '--report', session], text=True, timeout=20)
        return json.loads(output)
    except (OSError, ValueError, subprocess.SubprocessError):
        return {'usd': None, 'files': [], 'denied': [], 'toolCalls': 0}


def round_run(prompt, args, resume, effort, deadline):
    command = ['commandcode', '-p', prompt, '-m', args.model, '--max-turns', str(args.max_turns),
               '--output-format', 'json', '--skip-onboarding', '--yolo', '--trust']
    for directory in args.add_dir + args.write_dir:
        command += ['--add-dir', directory]
    if effort:
        command += ['--effort', effort]
    if resume:
        command += ['--resume', resume]
    timeout = max(1, deadline - time.monotonic())
    try:
        ran = subprocess.run(command, cwd=args.cwd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        return {'code': None, 'error': f'timed out after {args.max_minutes} minutes: {error}',
                'finalText': '', 'sessionId': resume, 'turns': 0}
    result = {'code': ran.returncode, 'error': ran.stderr[-2000:], 'finalText': '',
              'sessionId': resume, 'turns': 0}
    for line in ran.stdout.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if row.get('type') == 'result':
            result.update({key: row.get(key, result.get(key)) for key in
                           ('finalText', 'sessionId', 'subtype')})
        if (row.get('event') or {}).get('type') == 'turn_end':
            result['turns'] += 1
    return result


def run(args):
    if not shutil_which('commandcode'):
        raise RuntimeError('Command Code is missing; run npm i -g command-code and sign in')
    cwd = str(Path(args.cwd).resolve())
    if cwd in ('/', str(Path.home().resolve())):
        raise ValueError('choose a project directory, not / or your home folder')
    args.cwd = cwd
    args.add_dir = validate_dirs(cwd, args.add_dir)
    args.write_dir = validate_dirs(cwd, args.write_dir, True)
    if not 1 <= args.max_turns <= 500 or not 1 <= args.max_minutes <= 240:
        raise ValueError('max-turns must be 1..500 and max-minutes 1..240')
    task = Path(args.task_file).read_text().strip() if args.task_file else args.task
    if not task:
        raise ValueError('provide a task or --task-file')
    key = 'codex/' + uuid.uuid4().hex
    entry = {'key': key, 'until': (time.time() + (args.max_minutes + 5) * 60) * 1000,
             'addDirs': args.add_dir, 'writeDirs': args.write_dir, 'shell': args.shell}
    env = update_rules(cwd, add=entry)
    deadline = time.monotonic() + args.max_minutes * 60
    session = None
    turns = 0
    rounds = 0
    startup_retries = 0
    result = {}
    effort = args.effort
    try:
        while rounds < 8 and turns < args.max_turns and time.monotonic() < deadline:
            denied = usage_report(session)['denied'] if session else []
            prompt = (task + HEAD_RULES if not session else
                      'Continue the task from where you stopped. Make tool calls until it is complete. '
                      + ('Do not retry denied calls: ' + '; '.join(
                          f"{d['tool']} {d['target']}" for d in denied) + '. ' if denied else '')
                      + f'End your final report with {DONE}.')
            args.max_turns -= turns
            result = round_run(prompt, args, session, effort, deadline)
            args.max_turns += turns
            rounds += 1
            turns += result['turns']
            session = result.get('sessionId') or session
            if not session and effort and 'Unknown effort' in result['error']:
                supported = re.search(r'Supported:\s*([a-z, ]+)', result['error'])
                levels = [x.strip() for x in supported.group(1).split(',')] if supported else []
                effort = next((x for x in levels if x in EFFORTS and
                               EFFORTS.index(x) >= EFFORTS.index(effort)), levels[-1] if levels else None)
                continue
            if not session and 'no reasoning effort' in result['error'].lower():
                effort = None
                continue
            if not session and startup_retries < 2 and time.monotonic() + 5 < deadline:
                startup_retries += 1
                time.sleep(5 * startup_retries)
                continue
            if DONE in (result.get('finalText') or '') or result['code'] not in (0, 8, 9) or not session:
                break
    finally:
        update_rules(cwd, remove=key)
    report = usage_report(session)
    finished = result.get('code') == 0 and result.get('subtype') == 'success' and DONE in (result.get('finalText') or '')
    print(f"head {args.name} · {args.model} · effort {effort or 'default'} · "
          f"{'finished' if finished else 'NOT finished'} · {rounds} round(s) · {turns} turns · "
          f"${(report['usd'] or 0):.4f}")
    print(f"session {session or 'none'} · cwd {cwd}")
    if env:
        print(f'search tool denied because {env} is in reach')
    outside = [f for f in report['files'] if f.startswith('/') and not any(
        within(f, d) for d in [cwd, *args.write_dir])]
    if outside:
        print('⚠ WROTE OUTSIDE THE PROJECT: ' + ', '.join(outside))
    print('edited: ' + (', '.join(report['files']) or 'nothing'))
    for denied in report['denied']:
        print(f"denied: {denied['tool']} {denied['target']}: {denied['text'][:140]}")
    print('--- head report ---')
    print((result.get('finalText') or '(no final report)').replace(DONE, '').strip()[-8000:])
    if not finished and result.get('error'):
        print('--- stderr ---\n' + result['error'])
    return 0 if finished and not outside else 1


def shutil_which(name):
    from shutil import which
    return which(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    head = sub.add_parser('run', help='run a guarded Command Code Head')
    head.add_argument('task', nargs='?', default='')
    head.add_argument('--task-file')
    head.add_argument('--cwd', default=os.getcwd())
    head.add_argument('--name', default='head')
    head.add_argument('--model', default=MODEL)
    head.add_argument('--effort', choices=EFFORTS, default='low')
    head.add_argument('--max-turns', type=int, default=60)
    head.add_argument('--max-minutes', type=int, default=40)
    head.add_argument('--add-dir', action='append', default=[])
    head.add_argument('--write-dir', action='append', default=[])
    head.add_argument('--shell', action='store_true')
    sub.add_parser('usage', help='show Command Code spend over 5 hours and 7 days')
    args = parser.parse_args()
    try:
        if args.command == 'usage':
            subprocess.run([sys.executable, str(ROOT / 'bin/cc-usage.py')], check=True)
            return 0
        return run(args)
    except (OSError, ValueError, RuntimeError) as error:
        print(f'Hydra: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
