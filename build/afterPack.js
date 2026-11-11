// Ad-hoc sign the macOS app (no paid Apple certificate) so it runs on Apple Silicon.
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const resDir = path.join(app, 'Contents', 'Resources');
  const run = cmd => { try { execSync(cmd, { stdio: 'inherit' }); } catch (e) { console.warn('codesign warning:', e.message); } };
  // sign every native binary we ship in Resources (engine, yt-dlp, deno)
  for (const sub of ['engine', 'bin']) {
    const dir = path.join(resDir, sub);
    if (!fs.existsSync(dir)) continue;
    run(`find "${dir}" -type f \\( -perm -u+x -o -name "*.dylib" -o -name "*.so" \\) -exec codesign --force --sign - --timestamp=none {} +`);
  }
  run(`codesign --force --deep --sign - --timestamp=none "${app}"`);
  run(`xattr -cr "${app}"`);
};
