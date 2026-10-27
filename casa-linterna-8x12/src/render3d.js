// Renders 3D del visor (Playwright + Chromium). Uso: node render3d.js visor.html carpeta_salida
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [,, file, out] = process.argv;
  const b = await chromium.launch({args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']});
  const p = await b.newPage({viewport: {width: 1700, height: 1150}, deviceScaleFactor: 1.25});
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('file://' + path.resolve(file));
  await p.waitForFunction(() => window.CL, null, {timeout: 30000});
  await p.addStyleTag({content: 'header,aside,#pick,.views{display:none!important} #stage{position:fixed!important;inset:0!important}'});
  await p.evaluate(() => window.dispatchEvent(new Event('resize')));
  const shots = [
    ['render-iso',       {lv:4, ph:'solid', cut:'none'}, [-9, 14, -23], [6, 3.4, -6.5]],
    ['render-calle',     {lv:4, ph:'solid', cut:'none'}, [-8.5, 1.7, -14.5], [4, 3.6, -7]],
    ['render-cochera',   {lv:4, ph:'solid', cut:'none'}, [-2.2, 1.65, -9.3], [8, 2.7, -10.6]],
    ['render-corte',     {lv:4, ph:'solid', cut:'x', cutpos:0.50}, [16, 9, -24], [6, 3.5, -6.5]],
    ['render-p2',        {lv:2, ph:'off', cut:'none'}, [6, 16, -19], [6, 2.4, -5]],
    ['render-terraza',   {lv:4, ph:'ghost', cut:'none'}, [16, 14, -20], [6, 6.0, -4.5]],
  ];
  for (const [name, st, cam, tg] of shots) {
    await p.evaluate(([st, cam, tg]) => { Object.assign(CL.state, st); CL.apply(); CL.setCam(cam, tg); }, [st, cam, tg]);
    await p.waitForTimeout(1800);
    await p.screenshot({path: path.join(out, name + '.png')});
    console.log('render', name);
  }
  await b.close();
})();
