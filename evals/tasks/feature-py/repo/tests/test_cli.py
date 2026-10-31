import io
import os
import unittest

from inventory.cli import main

ITEMS = os.path.join(os.path.dirname(__file__), "..", "items.csv")


class ListTest(unittest.TestCase):
    def run_cli(self, *args):
        out = io.StringIO()
        self.assertEqual(main(["list", "--file", ITEMS, *args], out=out), 0)
        return out.getvalue().splitlines()

    def test_table_sorted_by_name(self):
        lines = self.run_cli()
        self.assertEqual(lines[0].split(), ["name", "qty", "price"])
        self.assertEqual([line.split()[0] for line in lines[1:]], ["bolt", "gear", "spring", "widget"])

    def test_min_qty(self):
        lines = self.run_cli("--min-qty", "10")
        self.assertEqual([line.split()[0] for line in lines[1:]], ["bolt", "widget"])


if __name__ == "__main__":
    unittest.main()
