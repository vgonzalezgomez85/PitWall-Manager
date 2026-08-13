const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * electron-builder solo pone icono al VOLUMEN montado (dmg.icon).
 * El propio fichero .dmg en Finder se queda con el icono genérico de
 * imagen de disco. Le asignamos un icono personalizado con NSWorkspace
 * vía JXA (Rez/DeRez no aceptan el icns "plano" que usa electron-builder).
 */
exports.default = async function setDmgIcon(buildResult) {
  const dmgFiles = buildResult.artifactPaths.filter((p) => p.endsWith('.dmg'));
  if (dmgFiles.length === 0) return;

  const iconIcns = path.join(__dirname, 'icon.icns');
  const scriptPath = path.join(os.tmpdir(), 'pitwall-seticon.js');
  fs.writeFileSync(
    scriptPath,
    `function run(argv) {
      ObjC.import('Cocoa');
      const icon = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
      const ok = $.NSWorkspace.sharedWorkspace.setIconForFileOptions(icon, argv[1], 0);
      if (!ok) throw new Error('setIconForFileOptions failed for ' + argv[1]);
    }`
  );

  for (const dmgPath of dmgFiles) {
    execFileSync('osascript', ['-l', 'JavaScript', scriptPath, iconIcns, dmgPath]);
  }

  fs.rmSync(scriptPath, { force: true });
};
