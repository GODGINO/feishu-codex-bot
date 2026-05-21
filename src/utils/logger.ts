import pino from 'pino';

export function createLogger(level: string = 'info') {
  const format = process.env.LOG_FORMAT || 'pretty';

  if (format === 'json') {
    // Production: one JSON object per line, grep-friendly
    return pino({ level });
  }

  // Development: human-readable pretty print
  return pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  });
}

export type Logger = pino.Logger;
