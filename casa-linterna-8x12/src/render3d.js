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
    ['render-iso',       {lv:4, ph:'solid', cut:'none'}, [-9.5, 14, 17], [4, 3.4, -5.5]],
    ['render-calle',     {lv:4, ph:'solid', cut:'none'}, [-2.2, 1.7, 12.5], [4.2, 4.6, -2]],
    ['render-patio',     {lv:4, ph:'solid', cut:'none'}, [0.75, 1.55, -11.6], [5.6, 2.3, -7.6]],
    ['render-corte',     {lv:4, ph:'solid', cut:'x', cutpos:0.465}, [17, 9, 5], [3.5, 3.6, -6]],
    ['render-p2',        {lv:2, ph:'solid', cut:'none'}, [10, 13, 8], [4, 1.5, -4.5]],
    ['render-posterior', {lv:4, ph:'ghost', cut:'none'}, [15, 12, -24], [4, 3.6, -7]],
  ];
  for (const [name, st, cam, tg] of shots) {
    await p.evaluate(([st, cam, tg]) => { Object.assign(CL.state, st); CL.apply(); CL.setCam(cam, tg); }, [st, cam, tg]);
    await p.waitForTimeout(1800);
    await p.screenshot({path: path.join(out, name + '.png')});
    console.log('render', name);
  }
  await b.close();
})();
