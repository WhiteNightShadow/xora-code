import io
import json
import os
import unittest

from inventory.cli import main

ITEMS = os.path.join(os.path.dirname(__file__), "..", "items.csv")


class HiddenJsonTest(unittest.TestCase):
    def run_json(self, *args):
        out = io.StringIO()
        self.assertEqual(main(["list", "--file", ITEMS, "--format", "json", *args], out=out), 0)
        return json.loads(out.getvalue())

    def test_json_items(self):
        data = self.run_json()
        self.assertEqual([item["name"] for item in data], ["bolt", "gear", "spring", "widget"])
        self.assertEqual(data[0], {"name": "bolt", "qty": 200, "price": 0.1})

    def test_json_min_qty(self):
        self.assertEqual([item["name"] for item in self.run_json("--min-qty", "10")], ["bolt", "widget"])

    def test_table_is_still_default(self):
        out = io.StringIO()
        main(["list", "--file", ITEMS], out=out)
        self.assertEqual(out.getvalue().splitlines()[0].split(), ["name", "qty", "price"])


if __name__ == "__main__":
    unittest.main()
