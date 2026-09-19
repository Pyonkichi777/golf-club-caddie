/* ══════════════════════════════════════════════════════════
   Yardage Caddie — 残りヤードから使用クラブを推奨する
   データは clubs.json が唯一の正。ここには数値を書かない。
   ══════════════════════════════════════════════════════════ */
'use strict';

const STORE_KEY = 'caddie.state.v1';

let DATA = null;
let CORR = null;
let YPM = 1.0936;

const state = {
  unit: 'm',
  dist: 128,
  hazard: 180,
  green: 220,
  elevYd: 0,
  windDir: 'none',
  windMs: 4,
  lie: 'fairway',
  tempC: 20,
  screen: 'pick',
};

/* ─────────── 小物 ─────────── */
const $ = (id) => document.getElementById(id);
const toYd = (v) => (state.unit === 'm' ? v * YPM : v);
const toM = (yd) => yd / YPM;
const r0 = (n) => Math.round(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* ─────────── 計算 ─────────── */

/** 飛距離のロス率(%)。正の値ほど「飛ばない」＝実効距離が伸びる */
function lossPct() {
  let p = 0;
  if (state.windDir === 'head') p += CORR.wind.head_loss_pct_per_ms * state.windMs;
  if (state.windDir === 'tail') p -= CORR.wind.tail_gain_pct_per_ms * state.windMs;
  p += CORR.lie[state.lie].carry_loss_pct;
  const t = CORR.temperature;
  p += ((t.base_c - state.tempC) / 10) * t.loss_pct_per_10c_below_base;
  return p;
}

/** 見た目の距離(yd) → 実効距離(yd) */
function effective(baseYd) {
  const e = state.elevYd;
  const elevAdd = e >= 0 ? e * CORR.elevation.uphill_factor : e * CORR.elevation.downhill_factor;
  return baseYd + elevAdd + (baseYd * lossPct()) / 100;
}

function usableClubs(field) {
  return DATA.clubs.filter((c) => c.recommendable && c[field] != null);
}

/**
 * 実効距離に対する番手を選ぶ。
 * 仕様の「≧ を満たす最小番手」だけでは、ギャップ帯に落ちたとき
 * 152yd に対して 1W(175) のような非現実的な答えが出るため、
 * 上下の番手を見て近いほうを推奨し、差を必ず明示する。
 */
function pick(field) {
  const eff = effective(toYd(state.dist));
  const asc = usableClubs(field).sort((a, b) => a[field] - b[field]);
  if (!asc.length) return null;

  const over = asc.find((c) => c[field] >= eff);
  const under = [...asc].reverse().find((c) => c[field] < eff);
  const NEAR = CORR.near_threshold_yd;

  if (!over) return { club: under, delta: under[field] - eff, unreachable: true };
  if (!under) return { club: over, delta: over[field] - eff };

  const dOver = over[field] - eff;
  const dUnder = eff - under[field];
  const club = dOver <= dUnder ? over : under;
  return {
    club,
    delta: club[field] - eff,
    over,
    under,
    inGap: dOver > NEAR && dUnder > NEAR,
  };
}

/** 推奨対象のクラブ間で15yd以上空いている区間 */
function gapList() {
  const desc = usableClubs('carry_game_yd').sort((a, b) => b.carry_game_yd - a.carry_game_yd);
  const out = [];
  for (let i = 0; i < desc.length - 1; i++) {
    const hi = desc[i];
    const lo = desc[i + 1];
    const yd = hi.carry_game_yd - lo.carry_game_yd;
    if (yd >= CORR.gap_threshold_yd) {
      // ドライバーは基本ティーショット専用。1Wと次の番手の間が空くのは
      // どのバッグでも起きることで、埋める対象ではないため優先度を下げる
      const teeSide = hi.tee_club || lo.tee_club;
      const priority = teeSide ? 'low' : yd >= 20 ? 'high' : 'mid';
      out.push({ hi, lo, yd, from: lo.carry_game_yd, to: hi.carry_game_yd, priority, teeSide });
    }
  }
  const rank = { high: 0, mid: 1, low: 2 };
  return out.sort((a, b) => rank[a.priority] - rank[b.priority] || b.yd - a.yd);
}

/* ─────────── 描画: 推奨カード ─────────── */

function deltaText(d) {
  const v = Math.abs(r0(d));
  if (v === 0) return 'ちょうど';
  return d > 0 ? `+${v}yd 余る` : `${v}yd 足りない`;
}

function renderCards() {
  const host = $('cards');
  host.textContent = '';

  const specs = [
    { field: 'carry_game_yd', kicker: '実戦基準', primary: true },
    { field: 'carry_best_yd', kicker: 'ナイス基準', primary: false },
  ];

  for (const s of specs) {
    const res = pick(s.field);
    const card = el('div', 'card' + (s.primary ? ' card--primary' : ''));
    card.appendChild(el('div', 'card-kicker', s.kicker));

    if (!res) {
      card.appendChild(el('div', 'card-none', '候補なし'));
      host.appendChild(card);
      continue;
    }

    const name = el('div', 'card-club', res.club.name);
    if (res.club.name.length >= 4) name.classList.add('is-long');
    card.appendChild(name);
    card.appendChild(el('div', 'card-carry', `${res.club[s.field]}yd / ${r0(toM(res.club[s.field]))}m`));

    const d = el('div', 'card-delta', res.unreachable ? '届きません' : deltaText(res.delta));
    d.dataset.sign = res.delta < -0.5 ? 'short' : res.delta > 0.5 ? 'over' : 'even';
    card.appendChild(d);

    card.appendChild(el('div', 'card-conf', confStars(res.club)));
    host.appendChild(card);
  }
}

function confStars(c) {
  if (c.confidence === 'measured') return `★★☆ 実測${c.shots_measured}球`;
  if (c.shots_measured >= 30) return '★★★';
  if (c.shots_measured >= 10) return '★★☆';
  return '★☆☆ 推定';
}

/* ─────────── 描画: 注意書き ─────────── */

function renderNotes() {
  const host = $('notes');
  host.textContent = '';
  const add = (kind, text) => {
    const n = el('div', 'note', text);
    n.dataset.kind = kind;
    host.appendChild(n);
  };

  const game = pick('carry_game_yd');
  if (!game) return;

  if (game.unreachable) {
    add('gap', `実効距離が最長番手(${game.club.name} ${game.club.carry_game_yd}yd)を超えています。刻む前提でレイアップ地点を選んでください。`);
  } else if (game.inGap) {
    add('gap',
      `ギャップ帯です。${game.over.name}(${game.over.carry_game_yd}yd)では` +
      `${r0(game.over.carry_game_yd - effective(toYd(state.dist)))}yd余り、` +
      `${game.under.name}(${game.under.carry_game_yd}yd)では` +
      `${r0(effective(toYd(state.dist)) - game.under.carry_game_yd)}ydショートします。` +
      `どちらに外すのが安全かで選んでください。`);
  }

  if (game.club.warn) add('warn', `${game.club.name}：${game.club.warn}`);

  const lie = CORR.lie[state.lie];
  if (lie.warn) add('warn', `${lie.label}：${lie.warn}`);

  if (state.windDir === 'cross') {
    add('warn', '横風は距離を補正していません。曲がり幅だけ読んで、狙いを風上へずらしてください。');
  }

  if (game.club.confidence !== 'measured') {
    add('info', `${game.club.name}の距離は推定値です。実測すると精度が上がります。`);
  }
}

/* ─────────── 描画: 距離ラダー ─────────── */

function renderLadder() {
  const outer = $('ladder');
  outer.textContent = '';
  const host = el('div', 'ladder-scale');
  outer.appendChild(host);

  const clubs = usableClubs('carry_game_yd').sort((a, b) => a.carry_game_yd - b.carry_game_yd);
  if (!clubs.length) return;

  const lo = clubs[0].carry_game_yd - 12;
  const hi = clubs[clubs.length - 1].carry_game_yd + 18;
  const pos = (yd) => ((yd - lo) / (hi - lo)) * 100;

  host.appendChild(el('div', 'ladder-axis'));

  for (const g of gapList()) {
    const band = el('div', 'ladder-gap');
    band.dataset.pri = g.priority;
    band.style.left = pos(g.from) + '%';
    band.style.width = pos(g.to) - pos(g.from) + '%';
    band.title = `${g.yd}yd のギャップ`;
    host.appendChild(band);
  }

  clubs.forEach((c, i) => {
    const node = el('div', 'ladder-club');
    node.dataset.alt = i % 2 ? '1' : '0';
    node.style.left = pos(c.carry_game_yd) + '%';
    node.appendChild(el('div', 'ladder-tick'));
    node.appendChild(el('div', 'ladder-name', c.name));
    node.appendChild(el('div', 'ladder-yd', String(c.carry_game_yd)));
    host.appendChild(node);
  });

  const eff = effective(toYd(state.dist));
  const marker = el('div', 'ladder-marker');
  const clamped = eff < lo || eff > hi;
  marker.dataset.clamped = clamped ? '1' : '0';
  marker.style.left = clamp(pos(eff), 0, 100) + '%';
  marker.appendChild(el('div', 'm-flag', `${r0(eff)}`));
  marker.appendChild(el('div', 'm-stem'));
  host.appendChild(marker);
}

/* ─────────── 描画: 実効距離ストリップ ─────────── */

function renderEff() {
  const base = toYd(state.dist);
  const eff = effective(base);
  $('effValue').textContent = r0(eff);
  $('effAlt').textContent = `${r0(toM(eff))} m`;
  const d = eff - base;
  const dEl = $('effDelta');
  dEl.textContent = (d >= 0 ? '+' : '−') + Math.abs(r0(d));
  dEl.dataset.zero = Math.abs(r0(d)) === 0 ? '1' : '0';
}

/* ─────────── 描画: 距離入力 ─────────── */

function renderDist() {
  $('distValue').value = state.dist;
  $('distUnit').textContent = state.unit;
  const other = state.unit === 'm' ? `${r0(toYd(state.dist))} yd` : `${r0(toM(state.dist))} m`;
  $('distAlt').textContent = other;

  $('hzValue').value = state.hazard;
  $('hzUnit').textContent = state.unit;
  $('hzAlt').textContent = state.unit === 'm' ? `${r0(state.hazard * YPM)} yd` : `${r0(state.hazard / YPM)} m`;
  $('greenValue').value = state.green;
  $('greenUnit').textContent = state.unit;
}

/* ─────────── 描画: 距離表 ─────────── */

function renderTable() {
  const body = $('dtableBody');
  body.textContent = '';

  const all = [...DATA.clubs].sort((a, b) => {
    const av = a.carry_game_yd == null ? -1 : a.carry_game_yd;
    const bv = b.carry_game_yd == null ? -1 : b.carry_game_yd;
    return bv - av;
  });

  for (const c of all) {
    const tr = el('tr');
    if (!c.recommendable) tr.className = 'is-out';

    const nameCell = el('td', 'club-cell', c.name);
    tr.appendChild(nameCell);

    if (c.carry_game_yd == null) {
      const td = el('td', 'sub-num', '実戦で打てないため除外');
      td.colSpan = 3;
      td.style.textAlign = 'left';
      tr.appendChild(td);
      tr.appendChild(el('td', 'conf', '—'));
    } else {
      tr.appendChild(el('td', 'main-num', `${c.carry_game_yd}`));
      tr.appendChild(el('td', 'sub-num', `${r0(toM(c.carry_game_yd))}`));
      tr.appendChild(el('td', 'sub-num', `${c.carry_best_yd}`));
      tr.appendChild(el('td', 'conf', confStars(c)));
    }
    body.appendChild(tr);
  }

  const gapsHost = $('gaps');
  gapsHost.textContent = '';
  const gaps = gapList();
  if (!gaps.length) {
    gapsHost.appendChild(el('p', 'layup-empty', '15yd以上のギャップはありません。'));
  }
  for (const g of gaps) {
    const item = el('div', 'gap-item');
    item.dataset.pri = g.priority;
    item.appendChild(el('div', 'gap-span', `${g.yd}`));
    const bodyEl = el('div', 'gap-body');
    bodyEl.appendChild(el('div', 'gap-where', `${g.hi.name} ${g.to}yd → ${g.lo.name} ${g.from}yd`));
    bodyEl.appendChild(el('div', 'gap-why',
      g.teeSide
        ? `${g.hi.name}はティーショット用なので、この空白は埋める対象ではありません。`
        : `${g.from}〜${g.to}yd（${r0(toM(g.from))}〜${r0(toM(g.to))}m）がフルショットで埋まりません。`));
    item.appendChild(bodyEl);
    gapsHost.appendChild(item);
  }

  const src = $('sources');
  src.textContent = '';
  for (const c of DATA.clubs) {
    const d = el('div', 'src');
    d.appendChild(el('b', null, c.name + ' '));
    d.appendChild(el('span', null, `${c.model ?? ''}　${c.source ?? ''}`));
    src.appendChild(d);
  }
}

/* ─────────── 描画: 刻む ─────────── */

function renderLayup() {
  const host = $('layupOut');
  host.textContent = '';

  const effHz = effective(state.unit === 'm' ? state.hazard * YPM : state.hazard);
  const effGr = effective(state.unit === 'm' ? state.green * YPM : state.green);
  const M = CORR.layup_margin_yd;

  /* ── 越える ── */
  const crossBlock = block('越える', `実戦基準キャリー ≧ ${r0(effHz)} + ${M}yd`);
  const crossers = usableClubs('carry_game_yd')
    .filter((c) => c.carry_game_yd >= effHz + M)
    .sort((a, b) => a.carry_game_yd - b.carry_game_yd);

  if (!crossers.length) {
    crossBlock.body.appendChild(el('p', 'layup-empty',
      `候補なし。最長番手でもキャリーで越えられません（実効ハザード ${r0(effHz)}yd ＋ マージン ${M}yd）。`));
  } else {
    crossers.slice(0, 2).forEach((c, i) => {
      const o = el('div', 'opt' + (i === 0 ? ' opt--best' : ''));
      o.appendChild(el('div', 'opt-club', c.name));
      const dt = el('div', 'opt-detail');
      dt.innerHTML = `実戦基準 <strong>${c.carry_game_yd}yd</strong>。悪い当たりでも越えます（余裕 ${r0(c.carry_game_yd - effHz)}yd）。`;
      o.appendChild(dt);
      crossBlock.body.appendChild(o);
    });
  }
  host.appendChild(crossBlock.root);

  /* ── 刻む ── */
  const stopBlock = block('刻む', `好球時キャリー＋ラン ≦ ${r0(effHz)} − ${M}yd`);

  if (effGr <= effHz) {
    stopBlock.body.appendChild(el('p', 'layup-empty',
      'グリーンまでの距離がハザードより手前です。刻む必要がありません。'));
    host.appendChild(stopBlock.root);
    return;
  }

  const stoppers = usableClubs('carry_best_yd')
    .filter((c) => c.carry_best_yd + c.run_yd <= effHz - M)
    .map((c) => {
      const landing = c.carry_game_yd + c.run_yd;
      const rest = effGr - landing;
      const next = nextShotFor(rest);
      return { c, landing, rest, next };
    })
    .sort((a, b) => b.landing - a.landing);

  if (!stoppers.length) {
    stopBlock.body.appendChild(el('p', 'layup-empty',
      `候補なし。最も短い番手でも、好球時のトータルが ${r0(effHz - M)}yd を超えます。`));
  } else {
    // 刻みは「安全な範囲で最大限前に出す」が原則。
    // ただし次打がギャップ帯に落ちる刻みは、1つ手前の番手に落とす。
    // （stoppers は着地距離の降順）
    const nonGap = stoppers.filter((s) => !s.next.inGap);
    const best = (nonGap.length ? nonGap : stoppers)[0];

    // 推奨は必ず先頭に置く。一番下にあると読まれない
    const ordered = [best, ...stoppers.filter((s) => s !== best)].slice(0, 3);

    ordered.forEach((s) => {
      const o = el('div', 'opt' + (s === best ? ' opt--best' : ''));
      const club = el('div', 'opt-club', s.c.name);
      if (s === best) club.appendChild(el('span', 'opt-badge', '推奨'));
      o.appendChild(club);
      const dt = el('div', 'opt-detail');
      dt.innerHTML =
        `好球時でも <strong>${s.c.carry_best_yd + s.c.run_yd}yd</strong>（${r0(effHz - M)}ydの手前に止まる）<br>` +
        `着地想定 <strong>${r0(s.landing)}yd</strong> → 残り <strong>${r0(s.rest)}yd / ${r0(toM(s.rest))}m</strong>`;
      o.appendChild(dt);
      const tag = el('span', 'opt-next',
        s.next.club ? `次は ${s.next.club.name}（${deltaText(s.next.delta)}）` : '次打の番手なし');
      tag.dataset.gap = s.next.inGap ? '1' : '0';
      dt.appendChild(document.createElement('br'));
      dt.appendChild(tag);
      stopBlock.body.appendChild(o);
    });

    const skipped = stoppers[0] !== best ? stoppers[0] : null;
    if (skipped) {
      const n = el('div', 'note',
        `${skipped.c.name}ならあと${r0(skipped.landing - best.landing)}yd前に出せますが、` +
        `残り${r0(skipped.rest)}ydがギャップ帯に入ります。${best.c.name}で刻むほうが次打が素直です。`);
      n.dataset.kind = 'info';
      n.style.marginTop = '10px';
      stopBlock.body.appendChild(n);
    }

    if (best.next.inGap) {
      const n = el('div', 'note', `どの刻みでも次打がギャップ帯（残り${r0(best.rest)}yd）に入ります。距離表のギャップを確認してください。`);
      n.dataset.kind = 'gap';
      n.style.marginTop = '10px';
      stopBlock.body.appendChild(n);
    }
  }
  host.appendChild(stopBlock.root);

  function block(title, rule) {
    const root = el('div', 'layup-block');
    const head = el('div', 'layup-head');
    head.appendChild(el('span', null, title));
    head.appendChild(el('span', 'lh-rule', rule));
    const body = el('div', 'layup-body');
    root.appendChild(head);
    root.appendChild(body);
    return { root, body };
  }
}

/** ある残り距離に対して、どの番手が来るか */
function nextShotFor(restYd) {
  const asc = usableClubs('carry_game_yd').sort((a, b) => a.carry_game_yd - b.carry_game_yd);
  const over = asc.find((c) => c.carry_game_yd >= restYd);
  const under = [...asc].reverse().find((c) => c.carry_game_yd < restYd);
  const NEAR = CORR.near_threshold_yd;
  if (!over && !under) return { club: null, delta: 0, inGap: false };
  if (!over) return { club: under, delta: under.carry_game_yd - restYd, inGap: false };
  if (!under) return { club: over, delta: over.carry_game_yd - restYd, inGap: false };
  const dOver = over.carry_game_yd - restYd;
  const dUnder = restYd - under.carry_game_yd;
  const club = dOver <= dUnder ? over : under;
  return { club, delta: club.carry_game_yd - restYd, inGap: dOver > NEAR && dUnder > NEAR };
}

/* ─────────── 描画: 全体 ─────────── */

/** 条件パネルを畳んでいても、いま何が効いているかが一目で分かるようにする */
function renderCondSummary() {
  const parts = [];
  if (state.elevYd > 0) parts.push(`打ち上げ${state.elevYd}yd`);
  else if (state.elevYd < 0) parts.push(`打ち下ろし${-state.elevYd}yd`);
  else parts.push('平坦');

  const wind = { none: '無風', head: '向かい', tail: '追い', cross: '横風' }[state.windDir];
  parts.push(state.windDir === 'none' ? wind : `${wind}${state.windMs}m/s`);

  parts.push(CORR.lie[state.lie].label);

  const t = CORR.temperature.presets.find((p) => p.c === state.tempC);
  parts.push(t ? t.label : `${state.tempC}℃`);

  const node = $('condSummary');
  node.textContent = parts.join('・');
  const isDefault =
    state.elevYd === 0 && state.windDir === 'none' &&
    state.lie === 'fairway' && state.tempC === CORR.temperature.base_c;
  node.dataset.on = isDefault ? '0' : '1';
}

function renderAll() {
  renderDist();
  renderCondSummary();
  renderEff();
  renderCards();
  renderNotes();
  renderLadder();
  renderTable();
  renderLayup();
  save();
}

/* ─────────── チップUI ─────────── */

function buildChips(host, items, getActive, onPick) {
  host.textContent = '';
  for (const it of items) {
    const b = el('button', 'chip', it.label);
    b.type = 'button';
    if (it.tone) b.dataset.tone = it.tone;
    if (getActive(it)) b.classList.add('is-on');
    b.addEventListener('click', () => {
      onPick(it);
      refreshChips();
      renderAll();
    });
    host.appendChild(b);
  }
}

function elevItems() {
  const p = CORR.elevation.presets_yd;
  return [
    { label: '平坦', v: 0 },
    { label: `↑${p.slight}`, v: p.slight },
    { label: `↑${p.mid}`, v: p.mid },
    { label: `↑${p.large}`, v: p.large },
    { label: `↓${p.slight}`, v: -p.slight },
    { label: `↓${p.mid}`, v: -p.mid },
    { label: `↓${p.large}`, v: -p.large },
  ];
}

function refreshChips() {
  buildChips($('elevChips'), elevItems(), (i) => i.v === state.elevYd, (i) => { state.elevYd = i.v; });

  buildChips($('windDirChips'), [
    { label: '無風', v: 'none' },
    { label: '向かい', v: 'head', tone: 'flag' },
    { label: '追い', v: 'tail' },
    { label: '横', v: 'cross', tone: 'flag' },
  ], (i) => i.v === state.windDir, (i) => { state.windDir = i.v; });

  const wp = CORR.wind.presets_ms;
  const speedRow = $('windSpeedRow');
  speedRow.hidden = state.windDir === 'none';
  buildChips($('windSpeedChips'), [
    { label: `弱 ${wp.weak}m/s`, v: wp.weak },
    { label: `中 ${wp.mid}m/s`, v: wp.mid },
    { label: `強 ${wp.strong}m/s`, v: wp.strong },
  ], (i) => i.v === state.windMs, (i) => { state.windMs = i.v; });

  buildChips($('lieChips'),
    Object.entries(CORR.lie).map(([k, v]) => ({ label: v.label, v: k })),
    (i) => i.v === state.lie, (i) => { state.lie = i.v; });

  buildChips($('tempChips'),
    CORR.temperature.presets.map((p) => ({ label: `${p.label} ${p.c}℃`, v: p.c })),
    (i) => i.v === state.tempC, (i) => { state.tempC = i.v; });
}

/* ─────────── 入力イベント ─────────── */

function bindInputs() {
  document.querySelectorAll('.unit-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const u = b.dataset.unit;
      if (u === state.unit) return;
      const conv = (v) => (u === 'yd' ? Math.round(v * YPM) : Math.round(v / YPM));
      state.dist = conv(state.dist);
      state.hazard = conv(state.hazard);
      state.green = conv(state.green);
      state.unit = u;
      document.querySelectorAll('.unit-btn').forEach((x) => x.classList.toggle('is-on', x.dataset.unit === u));
      renderAll();
    });
  });

  document.querySelectorAll('[data-step]').forEach((b) => {
    b.addEventListener('click', () => {
      state.dist = clamp(state.dist + Number(b.dataset.step), 1, 400);
      renderAll();
    });
  });
  document.querySelectorAll('[data-hzstep]').forEach((b) => {
    b.addEventListener('click', () => {
      state.hazard = clamp(state.hazard + Number(b.dataset.hzstep), 1, 400);
      renderAll();
    });
  });
  document.querySelectorAll('[data-grstep]').forEach((b) => {
    b.addEventListener('click', () => {
      state.green = clamp(state.green + Number(b.dataset.grstep), 1, 500);
      renderAll();
    });
  });

  const numBind = (id, key, max) => {
    $(id).addEventListener('input', () => {
      const v = Number($(id).value);
      if (Number.isFinite(v) && v > 0) { state[key] = clamp(Math.round(v), 1, max); renderAll(); }
    });
    $(id).addEventListener('blur', () => renderDist());
  };
  numBind('distValue', 'dist', 400);
  numBind('hzValue', 'hazard', 400);
  numBind('greenValue', 'green', 500);

  $('resetCond').addEventListener('click', () => {
    state.elevYd = 0; state.windDir = 'none'; state.windMs = CORR.wind.presets_ms.mid;
    state.lie = 'fairway'; state.tempC = CORR.temperature.base_c;
    refreshChips(); renderAll();
  });

  document.querySelectorAll('[data-goto]').forEach((b) => {
    b.addEventListener('click', () => go(b.dataset.goto));
  });
}

function go(name) {
  state.screen = name;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('is-active', s.id === 'screen-' + name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-on', t.dataset.goto === name));
  window.scrollTo({ top: 0 });
  save();
}

/* ─────────── 保存 ─────────── */

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* プライベートモード等 */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    Object.assign(state, JSON.parse(raw));
  } catch (_) { /* 壊れていたら初期値のまま */ }
}

/* ─────────── 起動 ─────────── */

async function boot() {
  try {
    const res = await fetch('clubs.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`clubs.json の取得に失敗しました (${res.status})`);
    DATA = await res.json();
  } catch (e) {
    const box = $('bootError');
    box.hidden = false;
    box.textContent = `データを読み込めませんでした: ${e.message}。一度オンラインで開き直してください。`;
    return;
  }

  CORR = DATA.corrections;
  YPM = DATA.unit.yd_per_m;
  load();
  if (!CORR.lie[state.lie]) state.lie = 'fairway';

  const usable = DATA.clubs.filter((c) => c.recommendable).length;
  $('bagNote').textContent = `推奨対象 ${usable}本 / バッグ ${DATA.clubs.length + 1}本`;

  refreshChips();
  bindInputs();
  go(state.screen || 'pick');
  renderAll();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 配信元がhttpsでなければ無視 */ });
  }
}

boot();
