export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

let _logger: Logger = noopLogger;

export function setLogger(logger: Logger): void {
  _logger = logger;
}

export const serverLogger: Logger = new Proxy(noopLogger, {
  get(_target, prop: keyof Logger) {
    return (...args: unknown[]) => {
      (_logger[prop] as (...a: unknown[]) => void)(...args);
    };
  },
});
