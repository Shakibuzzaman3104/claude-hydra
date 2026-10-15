#!/usr/bin/env python3
# @author Shakib
# @since 15/10/26
"""Lists every symlink under the given folders with its real target: the links an OpenCode Head's rules must deny.

OpenCode checks a path as written, so a symlink is an alias its rules do not see through. Nothing is skipped (.git and
node_modules included) and no link is followed. Prints a JSON list of [link, real target] pairs, both absolute. A folder
that cannot be listed ends the run with exit 2 and the reason on stderr, so Hydra refuses the Head rather than miss a
link. A folder that does not exist is skipped: it holds no link.
"""
import json
import os
import sys


def refuse(error):
    sys.stderr.write(f'cannot list {error.filename}: {error.strerror}\n')
    sys.exit(2)


def links_under(root):
    for folder, dirs, files in os.walk(root, onerror=refuse):
        for name in dirs + files:
            path = os.path.join(folder, name)
            if os.path.islink(path):
                yield [path, os.path.realpath(path)]


def main():
    found = []
    for root in sys.argv[1:]:
        if os.path.lexists(root):
            found.extend(links_under(root))
    print(json.dumps(found, separators=(',', ':')))


if __name__ == '__main__':
    main()
