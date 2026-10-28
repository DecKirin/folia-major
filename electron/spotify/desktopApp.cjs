const { execFile, spawn } = require('node:child_process');
const os = require('node:os');

// electron/spotify/desktopApp.cjs
// Spotify's own desktop app, as this computer has it: opening it (in the background where the
// system allows), and the names Spotify shows it under in the account's device list. Nothing here
// closes the app.

// Starts a program and resolves whether it started: a program that is not there fails at once.
const started = (command, args) => new Promise(resolve => {
  let child;
  try {
    child = spawn(command, args, { detached: true, stdio: 'ignore' });
  } catch {
    resolve(false);
    return;
  }
  child.once('error', () => resolve(false));
  child.once('spawn', () => {
    child.unref();
    resolve(true);
  });
});

// Opens the app. Resolves true where the system started it (or it was running), false where this
// computer has no Spotify app to open. `openExternal` opens a `spotify:` link (Windows).
async function openSpotifyApp({ platform = process.platform, openExternal, run = execFile, start = started } = {}) {
  if (platform === 'darwin') {
    // `-g`: opened without coming to the front. `open -a` fails when there is no such app.
    return new Promise(resolve => {
      run('open', ['-g', '-a', 'Spotify'], error => resolve(!error));
    });
  }
  if (platform === 'win32') {
    if (!openExternal) return false;
    try {
      await openExternal('spotify:');
      return true;
    } catch {
      return false;
    }
  }
  return await start('spotify', []) || await start('flatpak', ['run', 'com.spotify.Client']);
}

// The names the app on this computer may be listed under. On macOS it is the computer's name as
// the system shows it (`scutil --get ComputerName`, "Xiding's MacBook Pro"), not the host name.
function computerNames({ platform = process.platform, run = execFile } = {}) {
  const names = [os.hostname(), os.hostname().split('.')[0]];
  if (platform !== 'darwin') return Promise.resolve(names);
  return new Promise(resolve => {
    run('scutil', ['--get', 'ComputerName'], (error, stdout) => {
      resolve(error ? names : [String(stdout).trim(), ...names]);
    });
  });
}

module.exports = { computerNames, openSpotifyApp };
