import csv
from dataclasses import dataclass


@dataclass(frozen=True)
class Item:
    name: str
    qty: int
    price: float


def load(path):
    with open(path, newline="", encoding="utf-8") as handle:
        return [Item(row["name"], int(row["qty"]), float(row["price"])) for row in csv.DictReader(handle)]
