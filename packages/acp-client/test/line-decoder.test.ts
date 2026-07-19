import assert from "node:assert/strict";
import test from "node:test";
import { AcpParseError, NdjsonLineDecoder } from "../src/index.js";

test("decodes split UTF-8, CRLF and an unterminated final line", () => {
  const decoder = new NdjsonLineDecoder(128);
  const bytes = Buffer.from("{\"text\":\"你好\"}\r\n{\"tail\":true}", "utf8");
  const split = bytes.indexOf(Buffer.from("你")) + 1;
  assert.deepEqual(decoder.push(bytes.subarray(0, split)), []);
  assert.deepEqual(decoder.push(bytes.subarray(split)), ['{"text":"你好"}']);
  assert.deepEqual(decoder.finish(), ['{"tail":true}']);
});

test("rejects invalid UTF-8", () => {
  const decoder = new NdjsonLineDecoder(128);
  assert.throws(() => decoder.push(Uint8Array.of(0xc3, 0x28, 0x0a)), AcpParseError);
});
