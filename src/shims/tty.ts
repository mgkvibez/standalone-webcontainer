/**
 * `tty`, built on the terminal rather than on a guess.
 *
 * `isatty` is the question every interactive CLI asks first (`process.stdout.isTTY` / `tty.isatty(1)`), and answering it
 * wrongly changes program behaviour in both directions: a wrong `true` makes a program emit cursor escapes into a buffer
 * that cannot interpret them, a wrong `false` makes it refuse to be interactive at all. So the answer here comes from
 * whether a terminal is actually attached to that descriptor.
 *
 * Descriptor mapping is the one a pty gives: 0, 1 and 2 are the terminal when one is attached, because in a browser there is
 * no other file to point them at.
 *
 * `ReadStream` and `WriteStream` exist because packages construct them (`new tty.WriteStream(1)` to call
 * `getWindowSize`). Constructing one for a descriptor the terminal does not own throws `ENOTTY`, which is what Node does
 * rather than handing back a stream that lies.
 */

import type { Terminal, TerminalInput } from "../terminal/pty.js";

/** The shape a `tty.WriteStream` is used for, reduced to what a browser can answer. */
export interface TtyWriteStream {
  readonly fd: number;
  readonly isTTY: true;
  readonly columns: number;
  readonly rows: number;
  getWindowSize(): [number, number];
  getColorDepth(): number;
  hasColors(count?: number): boolean;
}

export interface TtyReadStream {
  readonly fd: number;
  readonly isTTY: true;
  readonly isRaw: boolean;
  setRawMode(mode: boolean): TtyReadStream;
  readonly input: TerminalInput;
}

/** Node's error for "this descriptor is not a terminal". */
const notATerminal = (fd: number): Error => {
  const error = new Error(`ENOTTY: inappropriate ioctl for device, fd ${fd}`) as Error & { code: string; errno: number; syscall: string };
  error.code = "ENOTTY";
  error.errno = -25;
  error.syscall = "ioctl";
  return error;
};

export interface TtyShim {
  /** True only for a descriptor the attached terminal actually owns. */
  isatty(fd: number): boolean;
  ReadStream: new (fd: number) => TtyReadStream;
  WriteStream: new (fd: number) => TtyWriteStream;
}

const TERMINAL_FDS = new Set([0, 1, 2]);

/**
 * `terminal` is nullable on purpose. A program run without a terminal (`runQuiet`, a fixture, a worker that only pipes) must
 * get `isatty() === false` for every descriptor, which is the truthful answer and the one Node gives for a pipe.
 */
export const createTtyShim = (terminal: Terminal | null): TtyShim => {
  const owns = (fd: number): boolean => terminal !== null && TERMINAL_FDS.has(fd);

  const WriteStream = class implements TtyWriteStream {
    readonly fd: number;

    constructor(fd: number) {
      if (!owns(fd)) throw notATerminal(fd);
      this.fd = fd;
    }

    get isTTY(): true {
      return true;
    }

    get columns(): number {
      return terminal!.columns;
    }

    get rows(): number {
      return terminal!.rows;
    }

    getWindowSize(): [number, number] {
      // Read at call time, not construction time: a program that resizes and asks again must see the new size.
      return [terminal!.columns, terminal!.rows];
    }

    /** 8, the answer for a terminal with 256 colours. Not 24-bit, because nothing here has been colour-negotiated. */
    getColorDepth(): number {
      return 8;
    }

    hasColors(count = 16): boolean {
      return count <= 256;
    }
  };

  const ReadStream = class implements TtyReadStream {
    readonly fd: number;

    constructor(fd: number) {
      if (!owns(fd)) throw notATerminal(fd);
      this.fd = fd;
    }

    get isTTY(): true {
      return true;
    }

    get isRaw(): boolean {
      return terminal!.stdin.isRaw;
    }

    get input(): TerminalInput {
      return terminal!.stdin;
    }

    setRawMode(mode: boolean): TtyReadStream {
      terminal!.stdin.setRawMode(mode);
      return this;
    }
  };

  return {
    isatty: (fd) => owns(fd),
    ReadStream,
    WriteStream,
  };
};
