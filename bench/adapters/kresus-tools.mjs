// Yarn's script entry point can run directly under Node, including paths with spaces.
export function yarnCommand(args, {
    platform = process.platform,
    node = process.execPath,
    executable = process.env.BENCH_KRESUS_YARN || (platform === 'win32' ? 'yarn.cmd' : '/opt/node22/bin/yarn'),
} = {}) {
    if (/\.[cm]?js$/i.test(executable)) {
        return { command: node, args: [executable, ...args], shell: false };
    }
    const shell = platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
    const command = shell && /\s/.test(executable) ? `"${executable}"` : executable;
    return { command, args, shell };
}
