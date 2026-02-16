/**
 * Console logger with daily file rotation.
 * Writes logs to logs/YYYY-MM-DD.log while keeping terminal output.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');
const { addLog } = require('./dashboard');

const LOG_DIR = path.join(process.cwd(), 'logs');
const LEVEL_MAP = { info: 10, warn: 20, error: 30 };
const LOG_LEVEL_NAME = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_LEVEL = LEVEL_MAP[LOG_LEVEL_NAME] || LEVEL_MAP.info;
const FILE_LOG_ENABLED = !['0', 'false', 'off'].includes(String(process.env.LOG_TO_FILE || '').toLowerCase());

let initialized = false;
let currentDateKey = '';
let stream = null;
let disabled = false;

function pad2(n) {
    return String(n).padStart(2, '0');
}

function getDateKey(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function getDateTime(d) {
    return `${getDateKey(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function ensureStream() {
    if (!FILE_LOG_ENABLED) return;
    if (disabled) return;

    const now = new Date();
    const dateKey = getDateKey(now);
    if (stream && dateKey === currentDateKey) return;

    if (stream) {
        stream.end();
        stream = null;
    }

    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const file = path.join(LOG_DIR, `${dateKey}.log`);
        stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
        currentDateKey = dateKey;
    } catch (err) {
        disabled = true;
        process.stderr.write(`[logger] 初始化日志文件失败: ${err.message}\n`);
    }
}

function appendLine(level, args) {
    const levelNum = LEVEL_MAP[String(level || '').toLowerCase()] || LEVEL_MAP.info;
    if (levelNum < LOG_LEVEL) return;

    ensureStream();
    const now = new Date();
    const message = util.formatWithOptions({ colors: false, depth: null }, ...args);
    addLog(level, message);

    if (!stream || disabled) return;
    const line = `[${getDateTime(now)}] [${level}] ${message}\n`;
    stream.write(line);
}

function initFileLogger() {
    if (initialized) return;
    initialized = true;

    const rawLog = console.log.bind(console);
    const rawWarn = console.warn.bind(console);
    const rawError = console.error.bind(console);

    console.log = (...args) => {
        if (LOG_LEVEL <= LEVEL_MAP.info) rawLog(...args);
        appendLine('INFO', args);
    };

    console.warn = (...args) => {
        if (LOG_LEVEL <= LEVEL_MAP.warn) rawWarn(...args);
        appendLine('WARN', args);
    };

    console.error = (...args) => {
        if (LOG_LEVEL <= LEVEL_MAP.error) rawError(...args);
        appendLine('ERROR', args);
    };

    process.on('exit', () => {
        if (stream) {
            stream.end();
            stream = null;
        }
    });
}

module.exports = {
    initFileLogger,
};
