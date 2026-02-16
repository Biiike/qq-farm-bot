const { spawn } = require('child_process');
const path = require('path');

function hasArg(args, name) {
    return args.includes(name);
}

function toBool(value) {
    return value === '1' || value === 'true';
}

function buildArgs() {
    const userArgs = process.argv.slice(2);
    const args = [path.join(__dirname, 'client.js')];

    if (userArgs.length > 0) {
        return args.concat(userArgs);
    }

    const platform = String(process.env.PLATFORM || 'qq').toLowerCase();
    const isWx = platform === 'wx' || toBool(String(process.env.WX || ''));
    const qrLogin = toBool(String(process.env.QR_LOGIN || ''));

    if (isWx) {
        args.push('--wx');
    }

    if (qrLogin && !isWx) {
        args.push('--qr');
    }

    const code = isWx
        ? (process.env.WX_CODE || process.env.CODE || '')
        : (process.env.QQ_CODE || process.env.CODE || '');

    if (code) {
        args.push('--code', code);
    }

    if (process.env.FARM_INTERVAL) {
        args.push('--interval', String(process.env.FARM_INTERVAL));
    }

    if (process.env.FRIEND_INTERVAL) {
        args.push('--friend-interval', String(process.env.FRIEND_INTERVAL));
    }

    return args;
}

function validateArgs(args) {
    const hasCode = hasArg(args, '--code');
    const hasQr = hasArg(args, '--qr');
    const isToolMode = hasArg(args, '--decode') || hasArg(args, '--verify');

    if (!hasCode && !hasQr && !isToolMode) {
        console.error('[启动] 缺少登录 code。请在环境变量设置 QQ_CODE（或 WX_CODE）。');
        process.exit(1);
    }
}

const args = buildArgs();
validateArgs(args);

const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
});

process.on('SIGINT', () => {
    child.kill('SIGINT');
});

process.on('SIGTERM', () => {
    child.kill('SIGTERM');
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code || 0);
});
