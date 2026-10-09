import argparse
import json
import sys


class Store:
    def __init__(self, path):
        self.path = path

    def load(self):
        try:
            with open(self.path) as f:
                return json.load(f)
        except FileNotFoundError:
            return []

    def save(self, todos):
        with open(self.path, "w") as f:
            json.dump(todos, f)


def cmd_add(store, args, out):
    todos = store.load()
    todos.append({"text": " ".join(args.text), "done": False})
    store.save(todos)
    print(f"added #{len(todos)}", file=out)
    return 0


def cmd_list(store, args, out):
    for i, todo in enumerate(store.load(), 1):
        if todo["done"] and not args.all:
            continue
        mark = "x" if todo["done"] else " "
        print(f"{i}. [{mark}] {todo['text']}", file=out)
    return 0


def cmd_done(store, args, out):
    todos = store.load()
    if not 1 <= args.number <= len(todos):
        print(f"no todo #{args.number}", file=out)
        return 1
    todos[args.number - 1]["done"] = True
    store.save(todos)
    print(f"done #{args.number}", file=out)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(prog="todo")
    parser.add_argument("--file", default="todos.json")
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add")
    add.add_argument("text", nargs="+")
    add.set_defaults(handler=cmd_add)

    lst = sub.add_parser("list")
    lst.add_argument("--all", action="store_true")
    lst.set_defaults(handler=cmd_list)

    done = sub.add_parser("done")
    done.add_argument("number", type=int)
    done.set_defaults(handler=cmd_done)
    return parser


def main(argv=None, out=sys.stdout):
    args = build_parser().parse_args(argv)
    return args.handler(Store(args.file), args, out)


if __name__ == "__main__":
    sys.exit(main())
