import argparse
import sys

from inventory.store import load


def table(items):
    width = max([len("name")] + [len(item.name) for item in items])
    lines = [f"{'name':<{width}}  {'qty':>5}  {'price':>7}"]
    for item in items:
        lines.append(f"{item.name:<{width}}  {item.qty:>5}  {item.price:>7.2f}")
    return "\n".join(lines)


def main(argv=None, out=sys.stdout):
    parser = argparse.ArgumentParser(prog="inventory")
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="list the items")
    listing.add_argument("--min-qty", type=int, default=0)
    listing.add_argument("--file", default="items.csv")
    args = parser.parse_args(argv)
    items = sorted((item for item in load(args.file) if item.qty >= args.min_qty), key=lambda item: item.name)
    print(table(items), file=out)
    return 0
