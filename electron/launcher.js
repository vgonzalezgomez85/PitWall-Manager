// Cross-platform Electron launcher.
// Unsets ELECTRON_RUN_AS_NODE before spawning Electron so it doesn't
// start in headless Node mode when launched from VS Code terminal.
const { spawn } = require('child_process');
const electron  = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const proc = spawn(electron, ['.'], { env, stdio: 'inherit' });
proc.on('close', code => process.exit(code ?? 0));
