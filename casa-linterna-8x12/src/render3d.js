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
    ['render-iso',       {lv:4, ph:'solid', cut:'none'}, [-9, 13, 10], [4, 3.8, -6]],
    ['render-calle',     {lv:4, ph:'solid', cut:'none'}, [-2.4, 1.7, 9.5], [4.2, 4.4, -4]],
    ['render-cochera',   {lv:4, ph:'solid', cut:'none'}, [2.2, 1.65, 6.5], [4.6, 2.6, -4.0]],
    ['render-corte',     {lv:4, ph:'solid', cut:'x', cutpos:0.43}, [17, 9.5, 2], [3.5, 3.8, -6]],
    ['render-p2',        {lv:2, ph:'off', cut:'none'}, [9, 14, 2], [4, 2, -8.5]],
    ['render-terraza',   {lv:4, ph:'ghost', cut:'none'}, [12, 13.5, -1], [3.8, 5.9, -8.5]],
  ];
  for (const [name, st, cam, tg] of shots) {
    await p.evaluate(([st, cam, tg]) => { Object.assign(CL.state, st); CL.apply(); CL.setCam(cam, tg); }, [st, cam, tg]);
    await p.waitForTimeout(1800);
    await p.screenshot({path: path.join(out, name + '.png')});
    console.log('render', name);
  }
  await b.close();
})();
