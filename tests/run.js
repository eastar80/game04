/* 자동 플레이 테스트 — node tests/run.js
   수치는 밸런스 확인용이지 재미의 증거가 아니다 (프로젝트 지침). */
const { chromium } = require('playwright');
const path = require('path');

const PAGE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const RUNS = 20;
const SIGMAS = [15, 50, 120];

let failed = 0;
function check(name, ok, detail) {
  console.log((ok ? '  \x1b[32mPASS\x1b[0m ' : '  \x1b[31mFAIL\x1b[0m ') + name + (detail ? '  — ' + detail : ''));
  if (!ok) failed++;
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
  });
  const page = await browser.newPage();
  // 리더보드 엔드포인트로 나가는 요청은 이 환경에서 프록시가 막는다.
  // 그건 게임의 에러가 아니라 오프라인 경로 그 자체다 — 따로 검증한다([8]).
  const isNet = t => /ERR_|Failed to load resource|Failed to fetch|NetworkError/i.test(t);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !isNet(m.text())) errors.push(m.text()); });
  await page.goto(PAGE);
  await page.waitForFunction(() => !!window.__beat);

  console.log('\n[1] 페이지 로드');
  check('런타임 에러 없음', errors.length === 0, errors.join(' | '));
  check('__beat 훅 노출', await page.evaluate(() =>
    ['state', 'nextBeatTime', 'tap', 'reset', 'replay'].every(k => k in window.__beat)));

  console.log('\n[2] 봇 ' + RUNS + '판 × σ ' + SIGMAS.join('/') + 'ms');
  const table = {};
  for (const sigma of SIGMAS) {
    table[sigma] = await page.evaluate(({ sigma, RUNS }) => {
      const out = [];
      for (let i = 1; i <= RUNS; i++) out.push(window.__beat.bot(sigma, i * 7919).result);
      return out;
    }, { sigma, RUNS });
    const r = table[sigma];
    console.log('    σ=' + String(sigma).padStart(3) + 'ms  점수 평균 ' + mean(r.map(x => x.score)).toFixed(1).padStart(6) +
      '   최장무음 ' + mean(r.map(x => x.bestSilentRun)).toFixed(1) +
      ' (최대 ' + Math.max(...r.map(x => x.bestSilentRun)) + ')' +
      '   PERFECT ' + (mean(r.map(x => x.perfectRate)) * 100).toFixed(0) + '%');
  }
  const m = SIGMAS.map(s => mean(table[s].map(x => x.score)));
  check('점수가 σ 순으로 단조 감소', m[0] > m[1] && m[1] > m[2], m.map(x => x.toFixed(0)).join(' > '));
  check('σ=15 봇이 무음 8박 배율에 도달', table[15].every(r => r.bestSilentRun === 8 && r.bestMult === 8));
  check('σ=120 봇은 무음 4박을 못 넘음', table[120].every(r => r.bestSilentRun <= 4),
    '최대 ' + Math.max(...table[120].map(r => r.bestSilentRun)) + '박');

  console.log('\n[3] 리플레이 — 입력 기록만으로 재현 (원칙 1)');
  const rep = await page.evaluate(() => {
    const out = [];
    for (let i = 1; i <= 10; i++) {
      const b = window.__beat.bot(10 + i * 12, i * 104729);
      out.push({ live: b.result, replay: window.__beat.replay(b.inputs) });
    }
    return out;
  });
  check('봇 결과 === replay(inputs) 결과 (10판)',
    rep.every(x => JSON.stringify(x.live) === JSON.stringify(x.replay)),
    rep.map(x => x.live.score + '/' + x.replay.score).join(' '));

  console.log('\n[4] 주사율 독립 — 같은 입력 → 같은 판정');
  const fps = await page.evaluate(() => {
    const out = [];
    for (let i = 1; i <= 10; i++) {
      const b = window.__beat.bot(40, i * 31337);
      out.push([b.result, window.__beat.replayStepped(b.inputs, 1 / 30),
        window.__beat.replayStepped(b.inputs, 1 / 60),
        window.__beat.replayStepped(b.inputs, 1 / 120),
        window.__beat.replayStepped(b.inputs, 1 / 240)].map(r => JSON.stringify(r)));
    }
    return out;
  });
  check('30/60/120/240Hz 진행 간격에서 결과 동일',
    fps.every(g => g.every(x => x === g[0])));

  console.log('\n[5] 실제 페이지에서 라이브 판정');
  const live = await page.evaluate(async () => {
    await window.__beat.reset();
    const log = [];
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 14; i++) {
      let bt = window.__beat.nextBeatTime;
      while (window.__beat.now() < bt - 0.25) await sleep(10);
      const ev = window.__beat.tap(bt);           // 정확히 박 위에 탭
      if (ev) log.push({ judge: ev.judge, mult: ev.mult, silent: ev.silent });
      while (window.__beat.now() < bt + 0.02) await sleep(2);
    }
    return { log, state: window.__beat.state };
  });
  check('정박 탭은 전부 PERFECT', live.log.length >= 10 && live.log.every(e => e.judge === 'PERFECT'),
    live.log.map(e => e.judge + (e.silent ? '×' + e.mult : '')).join(' '));
  check('4박 뒤 무음 마디로 넘어감', live.log.some(e => e.silent), '');
  check('콤보가 쌓임', live.state.combo >= 10, '콤보 ' + live.state.combo);
  check('오디오 시계가 흐름', live.state.remaining < 60 && live.state.remaining > 0,
    '남은 ' + live.state.remaining.toFixed(1) + '초');

  console.log('\n[7] 첫 판 회귀 — 오디오 시계가 깨기 전에 판을 시작하지 않는가');
  // 예전 버그: resume() 은 비동기이고 suspended 인 AudioContext 는 currentTime 이 0에 멈춰 있는데,
  // 그 죽은 시계로 t0 를 잡았다. 그래서 첫 판만 카운트인이 얼어붙고 박이 통째로 틀어졌다.
  // 헤드리스 크로미엄은 5ms 만에 깨어나 자연 재현이 안 되므로, 스펙이 허용하는
  // "늦게 깨는 컨텍스트"를 주입해 그 조건을 만든다.
  const WAKE_MS = 600;
  const cold = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--mute-audio']
  });
  const cp = await cold.newPage();
  const coldErrors = [];
  cp.on('pageerror', e => coldErrors.push(String(e)));
  cp.on('console', m => { if (m.type() === 'error' && !isNet(m.text())) coldErrors.push(m.text()); });
  await cp.addInitScript(wake => {
    const Real = window.AudioContext;
    function Slow() { this._ac = new Real(); this._born = performance.now(); this._resumed = false; }
    Slow.prototype._live = function () { return this._resumed && performance.now() - this._born >= wake; };
    Slow.prototype.resume = function () { this._resumed = true; return this._ac.resume(); };
    Slow.prototype.createGain = function () { return this._ac.createGain(); };
    Slow.prototype.createOscillator = function () { return this._ac.createOscillator(); };
    Object.defineProperty(Slow.prototype, 'state', { get() { return this._live() ? this._ac.state : 'suspended'; } });
    Object.defineProperty(Slow.prototype, 'currentTime', { get() { return this._live() ? this._ac.currentTime : 0; } });
    Object.defineProperty(Slow.prototype, 'destination', { get() { return this._ac.destination; } });
    window.AudioContext = Slow; window.webkitAudioContext = Slow;
  }, WAKE_MS);
  await cp.goto(PAGE);
  await cp.waitForFunction(() => !!window.__beat);

  await cp.mouse.click(200, 400);                 // 진짜 제스처로 첫 판 시작
  await cp.waitForFunction(() => window.__beat.state.mode !== 'boot', null, { timeout: 10000 });

  // 핵심 불변식: 판이 시작되는 순간 첫 판정 박까지 남은 시간은 lead(0.35) + 카운트인 4박(2.4) = 2.75초.
  // 죽은 시계로 t0 를 잡으면 그만큼(여기선 0.6초) 줄어든 값이 나온다.
  const lead = await cp.evaluate(() => window.__beat.state.t0 - window.__beat.now());
  check('첫 박까지 2.75초 — 죽은 시계로 t0 를 잡지 않았다',
    Math.abs(lead - 2.75) < 0.08, lead.toFixed(3) + '초 (버그 시 약 ' + (2.75 - WAKE_MS / 1000).toFixed(2) + '초)');

  const clockMoved = await cp.evaluate(async () => {
    const a = window.__beat.now();
    await new Promise(r => setTimeout(r, 300));
    return window.__beat.now() - a;
  });
  check('첫 판 시작 시점에 오디오 시계가 흐르고 있다', clockMoved > 0.25 && clockMoved < 0.4,
    '300ms 동안 ' + (clockMoved * 1000).toFixed(0) + 'ms 진행');

  const firstRun = await cp.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const seen = [], log = [];
    for (let i = 0; i < 8; i++) {
      const bt = window.__beat.nextBeatTime;
      if (bt === null) { await sleep(20); continue; }
      while (window.__beat.now() < bt - 0.25) await sleep(8);
      seen.push(bt);
      const ev = window.__beat.tap(bt);
      if (ev) log.push(ev.judge);
      while (window.__beat.now() < bt + 0.03) await sleep(2);
    }
    return { log, gaps: seen.slice(1).map((t, i) => t - seen[i]) };
  });
  check('첫 판에서도 정박 탭이 전부 PERFECT', firstRun.log.length >= 6 && firstRun.log.every(j => j === 'PERFECT'),
    firstRun.log.join(' ') || '판정 없음');
  check('첫 판 박 간격이 0.6초로 균일', firstRun.gaps.every(g => Math.abs(g - 0.6) < 0.002),
    firstRun.gaps.map(g => g.toFixed(3)).join(' '));
  check('첫 판 런타임 에러 없음', coldErrors.length === 0, coldErrors.join(' | '));
  await cold.close();

  console.log('\n[8] 기록 — 전체 기록 저장과 오프라인 견딤');
  // 한 판을 3초로 줄여서 여러 판을 돌린다(DIFFS 표 하나만 고치면 되는 구조 그대로).
  const playOnce = async (pg, taps) => pg.evaluate(async n => {
    window.__beat.DIFFS.기본.duration = 3;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await window.__beat.reset();
    for (let i = 0; i < n; i++) {
      const bt = window.__beat.nextBeatTime;
      if (bt === null) break;
      while (window.__beat.now() < bt - 0.25) await sleep(8);
      window.__beat.tap(bt);
      while (window.__beat.now() < bt + 0.03) await sleep(2);
    }
    for (let i = 0; i < 300 && !window.__beat.state.finished; i++) await sleep(20);
    return window.__beat.state;
  }, taps);

  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('beat.runs') || '[]').length);
  const s1 = await playOnce(page, 4);
  check('판이 끝나면 게임 오버 화면이 뜬다', await page.isVisible('#over.on'), 'mode ' + s1.mode);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('beat.runs') || '[]').length);
  check('끝난 판이 전체 기록에 1줄 쌓인다', after === before + 1, before + ' → ' + after);

  await playOnce(page, 3);
  const runs = await page.evaluate(() => JSON.parse(localStorage.getItem('beat.runs') || '[]'));
  check('여러 판이 누적된다', runs.length === before + 2, '총 ' + runs.length + '판');
  check('각 판의 지표가 함께 저장된다',
    runs[0] && ['t', 'score', 'perfectRate', 'bestSilentRun', 'avgErrMs'].every(k => k in runs[0]),
    Object.keys(runs[0] || {}).join(','));

  // 네트워크가 막힌 채로도 게임과 내 기록은 그대로여야 한다
  await page.click('#tabAll');
  await page.waitForFunction(() => !/불러오는 중/.test(document.getElementById('list').textContent),
    null, { timeout: 15000 });
  const allText = await page.textContent('#list');
  check('전체 랭킹 실패 시 안내로 떨어진다(게임은 멈추지 않는다)', /불러오지 못했습니다/.test(allText),
    allText.trim().slice(0, 40));
  await page.click('#tabMine');
  const mineText = await page.textContent('#list');
  check('네트워크가 죽어도 내 기록은 보인다', /판 · 최고/.test(mineText), mineText.trim().split('\n')[0].slice(0, 40));

  const reloaded = await page.evaluate(() => JSON.parse(localStorage.getItem('beat.runs') || '[]').length);
  await page.reload();
  await page.waitForFunction(() => !!window.__beat && window.__beat.state.best >= 0);
  await page.waitForFunction(exp => JSON.parse(localStorage.getItem('beat.runs') || '[]').length === exp,
    reloaded, { timeout: 5000 });
  const bestAfter = await page.evaluate(() => window.__beat.state.best);
  const bestOfRuns = Math.max(...runs.map(r => r.score));
  check('새로고침해도 전체 기록과 최고 점수가 남는다', bestAfter === bestOfRuns,
    '최고 ' + bestAfter + ' / 기록상 ' + bestOfRuns);

  await page.evaluate(() => { window.__beat.DIFFS.기본.duration = 45; });

  console.log('\n[6] 런타임 에러 재확인');
  check('전체 실행 중 에러 없음', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log('\n' + (failed ? '\x1b[31m' + failed + ' FAILED\x1b[0m' : '\x1b[32m모두 통과\x1b[0m') + '\n');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
