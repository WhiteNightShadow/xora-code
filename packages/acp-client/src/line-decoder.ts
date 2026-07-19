import { AcpLineTooLongError, AcpParseError } from "./errors.js";

const EMPTY = Buffer.alloc(0);

export class NdjsonLineDecoder {
  readonly maxLineBytes: number;
  #buffer = EMPTY;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(maxLineBytes: number) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
    this.maxLineBytes = maxLineBytes;
  }

  push(chunk: string | Uint8Array): string[] {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    if (bytes.byteLength === 0) return [];

    this.#buffer = this.#buffer.byteLength === 0
      ? bytes
      : Buffer.concat([this.#buffer, bytes], this.#buffer.byteLength + bytes.byteLength);

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a, start);
      if (newline < 0) break;

      let end = newline;
      if (end > start && this.#buffer[end - 1] === 0x0d) end -= 1;
      const length = end - start;
      if (length > this.maxLineBytes) throw new AcpLineTooLongError(this.maxLineBytes, length);
      if (length > 0) lines.push(this.#decode(this.#buffer.subarray(start, end)));
      start = newline + 1;
    }

    this.#buffer = start === 0 ? this.#buffer : this.#buffer.subarray(start);
    const pendingLength = this.#buffer[this.#buffer.byteLength - 1] === 0x0d
      ? this.#buffer.byteLength - 1
      : this.#buffer.byteLength;
    if (pendingLength > this.maxLineBytes) {
      throw new AcpLineTooLongError(this.maxLineBytes, pendingLength);
    }
    return lines;
  }

  finish(): string[] {
    if (this.#buffer.byteLength === 0) return [];
    let end = this.#buffer.byteLength;
    if (this.#buffer[end - 1] === 0x0d) end -= 1;
    if (end > this.maxLineBytes) throw new AcpLineTooLongError(this.maxLineBytes, end);
    const line = end === 0 ? "" : this.#decode(this.#buffer.subarray(0, end));
    this.#buffer = EMPTY;
    return line.length === 0 ? [] : [line];
  }

  #decode(bytes: Uint8Array): string {
    try {
      return this.#decoder.decode(bytes);
    } catch (cause) {
      const preview = Buffer.from(bytes.subarray(0, 80)).toString("hex");
      throw new AcpParseError("ACP JSON-RPC line is not valid UTF-8", preview, { cause });
    }
  }
}
