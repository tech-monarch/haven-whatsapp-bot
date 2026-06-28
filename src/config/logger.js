/**
 * Leveled logger — reads logLevel from config (which reads LOG_LEVEL from .env).
 */
const config = require('./index');

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 100 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

function timestamp() {
  return new Date().toISOString();
}

function build(level) {
  return (...args) => {
    if (LEVELS[level] < currentLevel) return;
    const prefix = `[${timestamp()}] [${level.toUpperCase().padEnd(5)}]`;
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  };
}

module.exports = {
  trace: build('trace'),
  debug: build('debug'),
  info:  build('info'),
  warn:  build('warn'),
  error: build('error'),
};
