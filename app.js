/* ══════════════════════════════════════════════════════════
   Yardage Caddie — 残りヤードから使用クラブを推奨する
   データは clubs.json が唯一の正。ここには数値を書かない。
   ══════════════════════════════════════════════════════════ */
'use strict';

const STORE_KEY = 'caddie.state.v2';

let DATA = null;
let CORR = null;
let AIM = null;
let YPM = 1.0936;

const state = {
  unit: 'yd',
  dist: 140,
  hazard: 195,
  green: 240,
  elevYd: 0,
  windDir: 'none',
  windMs: 4,
  lie: 'fairway',
  tempC: 20,
  greenFirm: 'normal',
  aim: 'green',   // carry = 越える ／ green = 乗せる(キャリー+グリーン上の転がり) ／ run = 転がす(キャリー+ラン)
  screen: 'pick',
  hole: null,      // 取り込んだコースの、いまのホール番号
  greenId: null,   // 2グリーンのどちらか（コースデータの greens[].id）
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
 * グリーン上で落ちてから転がる量(yd)。
 * 実測(green_run_yd)があればそれを使い、なければ計測器のラン×比率を仮の値にする。
 * 計測器のランは平らなフェアウェイ想定なので、そのままではグリーン上より多く出る。
 * グリーンの硬さ（コーライ・真夏・冬は硬い）で倍率を掛ける。
 */
function greenRunYd(club) {
  const base = club.green_run_yd ?? (club.run_yd || 0) * AIM.green_run_ratio;
  const firm = CORR.green_firmness.presets.find((p) => p.id === state.greenFirm);
  return base * (firm ? firm.factor : 1);
}

/**
 * 番手側の距離。狙いで基準が変わる。
 *   carry = キャリー                  … 落ちた場所で決まる場面（ハザードを越す・砲台）
 *   green = キャリー + グリーン上の転がり … グリーンに落として少し転がす（既定）
 *   run   = キャリー + ラン             … フェアウェイに置く・花道から転がす
 * スピンの少ない番手ほど転がるので、この区別は長い番手ほど大きく効く。
 */
function basisYd(club, field, aim = state.aim) {
  if (aim === 'run') return club[field] + (club.run_yd || 0);
  if (aim === 'green') return club[field] + greenRunYd(club);
  return club[field];
}

function aimMode(id) {
  return AIM.modes.find((m) => m.id === (id || state.aim));
}

/* ─────────── 得意・苦手 ─────────── */
/* 普段の得意/苦手は clubs.json の skill。ラウンド中の「今日は7Iが当たらない」は
   アプリで上書きでき、日付が変わると自動で元に戻る（上書きは正ではないので端末にだけ置く）。 */

const TODAY_KEY = 'caddie.today.v1';
let TODAY = { date: '', skills: {} };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todaySkills() {
  if (TODAY.date !== todayStr()) TODAY = { date: todayStr(), skills: {} };
  return TODAY.skills;
}

function loadToday() {
  try {
    const t = JSON.parse(localStorage.getItem(TODAY_KEY) || 'null');
    if (t && t.date === todayStr() && t.skills) TODAY = t;
  } catch (_) { /* 壊れていたら上書きなしで起動 */ }
}

function saveToday() {
  try { localStorage.setItem(TODAY_KEY, JSON.stringify(TODAY)); } catch (_) { /* プライベートモード等 */ }
}

const skillBase = (c) => c.skill || 'normal';
const skillOf = (c) => todaySkills()[c.id] || skillBase(c);
const skillLabel = (s) => DATA.skill_rules.labels[s];

/** 得意なら距離のズレを小さく、苦手なら大きく見積もる（yd換算） */
function skillAdjust(c) {
  const R = DATA.skill_rules;
  const s = skillOf(c);
  return s === 'good' ? -R.good_bonus_yd : s === 'weak' ? R.weak_penalty_yd : 0;
}

/* ─────────── 安定度（計測日の球のまとまり） ─────────── */

/**
 * 安定度は表示と注意書きにだけ使い、推奨の評価式には入れない。
 * 得意/苦手は本人の設定なので、データで黙って書き換えないため。
 */
function stabilityOf(c) {
  const s = c.stability;
  const R = DATA.stability_rules;
  if (!s || s.shots < R.min_shots) return { rating: 'none' };
  const rate = s.miss / s.shots;
  const rating =
    rate >= R.unstable.miss_rate_min ||
    s.carry_sd_yd >= R.unstable.carry_sd_min_yd ||
    s.carry_iqr_yd >= R.unstable.carry_iqr_min_yd ? 'unstable' :
    rate <= R.stable.miss_rate_max && s.carry_iqr_yd <= R.stable.carry_iqr_max_yd ? 'stable' :
    'normal';
  return { rating, rate, main: mainMiss(s) };
}

/** いちばん多いミスの種類。同数なら両方。1球ずつしかないものは傾向と呼ばない */
function mainMiss(s) {
  const kinds = [['右', s.miss_right], ['左', s.miss_left], ['低い球', s.miss_low]];
  const top = Math.max(...kinds.map((k) => k[1]));
  if (top < 2) return null;
  return kinds.filter((k) => k[1] === top).map((k) => k[0]).join('・');
}

const stabLabel = (r) => DATA.stability_rules.labels[r];
const pct = (x) => `${r0(x * 100)}%`;

/** 本人の得意/苦手と計測の安定度が食い違うときだけ、見直しの一言を返す */
function skillHint(c) {
  const st = stabilityOf(c).rating;
  const sk = skillBase(c);
  // 食い違いを承知で据え置くと本人が決めた番手は、見直しを促さない
  if (c.skill_hold) return null;
  if (sk === 'good' && st === 'unstable') return '計測では不安定';
  if (sk === 'normal' && st === 'unstable') return '苦手にする候補';
  if (sk === 'weak' && st === 'stable') return '得意にする候補';
  return null;
}

/**
 * 実効距離に対する番手を、距離だけで選ぶ。
 * 仕様の「≧ を満たす最小番手」だけでは、ギャップ帯に落ちたとき
 * 152yd に対して 1W(175) のような非現実的な答えが出るため、
 * 上下の番手を見て近いほうを推奨し、差を必ず明示する。
 */
function pickByDistance(field, at, aim = state.aim) {
  const eff = at ?? effective(toYd(state.dist));
  const v = (c) => basisYd(c, field, aim);
  const asc = usableClubs(field).sort((a, b) => v(a) - v(b));
  if (!asc.length) return null;

  const over = asc.find((c) => v(c) >= eff);
  const under = [...asc].reverse().find((c) => v(c) < eff);
  const NEAR = CORR.near_threshold_yd;

  if (!over) return { club: under, basis: v(under), delta: v(under) - eff, unreachable: true, asc };
  if (!under) return { club: over, basis: v(over), delta: v(over) - eff, asc };

  const dOver = v(over) - eff;
  const dUnder = eff - v(under);
  const club = dOver <= dUnder ? over : under;
  return {
    club,
    basis: v(club),
    delta: v(club) - eff,
    over,
    under,
    inGap: dOver > NEAR && dUnder > NEAR,
    asc,
  };
}

/**
 * 得意/苦手を加味して番手を選ぶ。
 *   評価 = |距離のズレ| + 苦手ペナルティ − 得意ボーナス   → 最小の番手を推奨
 * 乗り換え先は、ズレが1番手分（max_override_yd）以内の番手に限る。
 * 得意だからといって11yd足りないクラブを勧めると、手前のハザードに捕まるため。
 * 同点なら距離だけで選んだ番手を残す。
 */
function pick(field, at, aim = state.aim) {
  const pure = pickByDistance(field, at, aim);
  if (!pure) return null;
  const base = { ...pure, pure: pure.club, pureDelta: pure.delta, overridden: false };
  if (pure.unreachable) return base;

  const eff = at ?? effective(toYd(state.dist));
  const v = (c) => basisYd(c, field, aim);
  const score = (c) => Math.abs(v(c) - eff) + skillAdjust(c);
  const MAX = DATA.skill_rules.max_override_yd;

  let best = pure.club;
  for (const c of pure.asc) {
    if (c === pure.club || Math.abs(v(c) - eff) > MAX) continue;
    if (score(c) < score(best)) best = c;
  }
  if (best === pure.club) return base;

  return { ...base, club: best, basis: v(best), delta: v(best) - eff, overridden: true };
}

/**
 * ボールまで歩くときに持っていくクラブ。
 * 推奨を中心に上下1番手ずつ取る。番手を読み違えても、外しても、
 * カートまで戻らずに次が打てるようにするため。
 */
function carrySet(res, field) {
  if (!res) return [];
  const n = DATA.carry_set?.count ?? 3;
  const asc = res.asc;
  const i = asc.indexOf(res.club);
  let lo = i - Math.floor((n - 1) / 2);
  lo = clamp(lo, 0, Math.max(0, asc.length - n));
  return asc.slice(lo, lo + n).reverse().map((c) => ({
    club: c,
    yd: r0(basisYd(c, field)),
    isPick: c === res.club,
  }));
}

/**
 * 推奨対象のクラブ間で15yd以上空いている区間。
 * useAim=false（既定）はキャリー基準。クラブの買い足し判断は常にキャリーで見る。
 * useAim=true はラダーの目盛りと軸を揃えるため、表示中の基準に合わせる。
 */
function gapList(useAim = false) {
  const val = (c) => (useAim ? basisYd(c, 'carry_game_yd') : c.carry_game_yd);
  const desc = usableClubs('carry_game_yd').sort((a, b) => val(b) - val(a));
  const out = [];
  for (let i = 0; i < desc.length - 1; i++) {
    const hi = desc[i];
    const lo = desc[i + 1];
    const yd = val(hi) - val(lo);
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
    const sk = skillOf(res.club);
    if (sk !== 'normal') {
      const tag = el('span', 'skill-tag', skillLabel(sk));
      tag.dataset.skill = sk;
      name.appendChild(tag);
    }
    card.appendChild(name);

    // キャリーと、狙いに応じた2つ目の距離（止まる位置 or トータル）を常に両方出す。
    // どちらで合わせているかを太字で示す。縦幅を増やさないため2行に固定する。
    const carry = res.club[s.field];
    const second = state.aim === 'green'
      ? carry + greenRunYd(res.club)
      : carry + (res.club.run_yd || 0);
    const dist = el('div', 'card-carry');
    const line = (label, yd, on) => {
      const n = el('div', 'cn' + (on ? ' is-basis' : ''));
      n.appendChild(el('span', 'cl', label));
      n.appendChild(el('span', 'cv', `${r0(yd)}yd`));
      return n;
    };
    dist.appendChild(line('キャリー', carry, state.aim === 'carry'));
    dist.appendChild(line(aimMode().line2, second, state.aim !== 'carry'));
    card.appendChild(dist);

    const d = el('div', 'card-delta', res.unreachable ? '届きません' : deltaText(res.delta));
    d.dataset.sign = res.delta < -0.5 ? 'short' : res.delta > 0.5 ? 'over' : 'even';
    card.appendChild(d);

    // 得意/苦手で乗り換えたときは、距離だけで選んだ番手を必ず併記する。
    // アプリが黙って判断を変えたように見せないため
    if (res.overridden) {
      // 2行に折り返すと「持っていく3本」がフォールド下へ落ちるため、短く1行に収める
      const pd = r0(res.pureDelta);
      const signed = pd > 0 ? `+${pd}` : pd < 0 ? `−${-pd}` : '±0';
      card.appendChild(el('div', 'card-alt', `距離だけなら ${res.pure.name} ${signed}yd`));
    }

    card.appendChild(el('div', 'card-conf', confStars(res.club)));
    host.appendChild(card);
  }
}

function confStars(c) {
  const st = stabilityOf(c).rating;
  if (c.confidence === 'measured' && st !== 'none') return `★★☆ 実測${c.shots_measured}球・${stabLabel(st)}`;
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

  const F = 'carry_game_yd';
  const game = pick(F);
  if (!game) return;
  const eff = effective(toYd(state.dist));
  const v = (c) => basisYd(c, F);

  if (game.unreachable) {
    add('gap', `実効距離が最長番手(${game.club.name} ${r0(v(game.club))}yd)を超えています。刻む前提でレイアップ地点を選んでください。`);
  } else if (game.inGap) {
    add('gap',
      `ギャップ帯です。${game.over.name}(${r0(v(game.over))}yd)では` +
      `${r0(v(game.over) - eff)}yd余り、` +
      `${game.under.name}(${r0(v(game.under))}yd)では` +
      `${r0(eff - v(game.under))}ydショートします。` +
      `どちらに外すのが安全かで選んでください。`);
  }

  if (state.aim === 'run') {
    add('warn', `トータル基準（ランを含む）で計算しています。${aimMode().warn}`);
  } else if (state.aim === 'carry') {
    add('info', aimMode().when + '。落ちてから転がる分は見ていないので、奥にこぼれないか確認してください。');
  } else if (!game.unreachable) {
    // 乗せる: 着地はピンの手前になる。手前のハザードに落ちないかを必ず知らせる
    const gr = r0(greenRunYd(game.club));
    if (gr >= 3) {
      const est = game.club.green_run_yd == null ? '（転がる量は推定）' : '';
      add('info',
        `着地はピンの約${gr}yd手前、グリーン上で${gr}yd転がる想定です${est}。` +
        `手前にバンカーや池があるなら「越える」に切り替えてください。`);
    }
  }

  if (game.overridden) {
    const p = game.pure;
    const c = game.club;
    const why =
      skillOf(p) === 'weak' && skillOf(c) === 'good' ? `苦手な${p.name}より、得意な${c.name}を優先しました` :
      skillOf(p) === 'weak' ? `苦手な${p.name}を避けて${c.name}にしました` :
      `得意な${c.name}を優先しました`;
    add('skill',
      `${why}（${c.name}は${deltaText(game.delta)}）。` +
      `手前に池やバンカーがあるときは、距離どおり${p.name}を選んでください。`);
  } else if (skillOf(game.club) === 'weak' && !game.unreachable) {
    add('skill', `${game.club.name}は苦手クラブですが、距離が合うのはこの番手だけです。`);
  }

  const overrides = Object.entries(todaySkills());
  if (overrides.length) {
    const names = overrides.map(([id, s]) => {
      const c = DATA.clubs.find((x) => x.id === id);
      return c ? `${c.name}→${skillLabel(s)}` : null;
    }).filter(Boolean);
    add('info', `今日の調子を反映中：${names.join('・')}（日付が変わると元に戻ります）`);
  }

  holeNotes(add);

  if (game.club.warn) add('warn', `${game.club.name}：${game.club.warn}`);

  // 安定度から、この場面で効く一言だけを足す（ミスの中身そのものは warn に書いてある）
  const gs = game.club.stability;
  if (gs && !game.unreachable) {
    const st = stabilityOf(game.club);
    if (state.aim === 'carry' && gs.miss_low >= 2) {
      add('warn',
        `${game.club.name}は低い球が${gs.shots}球中${gs.miss_low}球。ミスすると最大${gs.short_max_yd}yd手前に落ちました。` +
        `越えるのが絶対条件なら1番手上を選んでください。`);
    } else if (st.rating === 'unstable') {
      add('warn',
        `${game.club.name}は計測では${stabLabel('unstable')}（ミス率${pct(st.rate)}・キャリーのばらつき±${r0(gs.carry_sd_yd)}yd）。` +
        `ピンではなくグリーンの広い側を狙ってください。`);
    }
  }

  const lie = CORR.lie[state.lie];
  if (lie.warn) add('warn', `${lie.label}：${lie.warn}`);

  if (state.windDir === 'cross') {
    add('warn', '横風は距離を補正していません。曲がり幅だけ読んで、狙いを風上へずらしてください。');
  }

  if (game.club.confidence !== 'measured') {
    add('info', `${game.club.name}の距離は推定値です。実測すると精度が上がります。`);
  }
}

/* ─────────── 描画: 持っていく3本 ─────────── */

function renderCarrySet() {
  const host = $('carrySet');
  host.textContent = '';
  const F = 'carry_game_yd';
  const res = pick(F);
  const set = carrySet(res, F);
  if (!set.length) return;

  const row = el('div', 'cset-row');
  for (const it of set) {
    const b = el('div', 'cset-club');
    if (it.isPick) b.dataset.pick = '1';
    b.appendChild(el('div', 'cset-name', it.club.name));
    b.appendChild(el('div', 'cset-yd', `${it.yd}`));
    row.appendChild(b);
  }
  host.appendChild(row);
  host.appendChild(el('p', 'cset-why',
    '番手を読み違えても、当たりが悪くても、カートまで戻らずに次が打てる組み合わせ。'));
}

/* ─────────── 描画: 距離ラダー ─────────── */

function renderLadder() {
  const outer = $('ladder');
  outer.textContent = '';
  const host = el('div', 'ladder-scale');
  outer.appendChild(host);

  const F = 'carry_game_yd';
  const v = (c) => basisYd(c, F);
  const clubs = usableClubs(F).sort((a, b) => v(a) - v(b));
  if (!clubs.length) return;

  $('ladderTitle').textContent =
    `距離ラダー（${state.aim === 'carry' ? 'キャリー' : aimMode().line2}）`;

  const lo = v(clubs[0]) - 12;
  const hi = v(clubs[clubs.length - 1]) + 18;
  const pos = (yd) => ((yd - lo) / (hi - lo)) * 100;

  host.appendChild(el('div', 'ladder-axis'));

  for (const g of gapList(true)) {
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
    node.dataset.skill = skillOf(c);
    node.style.left = pos(v(c)) + '%';
    node.appendChild(el('div', 'ladder-tick'));
    node.appendChild(el('div', 'ladder-name', c.name));
    node.appendChild(el('div', 'ladder-yd', String(r0(v(c)))));
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
  // 保存された単位で起動することがあるので、トグルの見た目を毎回合わせる
  document.querySelectorAll('.unit-btn').forEach((x) => x.classList.toggle('is-on', x.dataset.unit === state.unit));

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

/* ─────────── コース（取り込み式） ─────────── */
/* コース名やホール情報は公開リポジトリに置かない。利用者が自分のデータを取り込み、
   端末にだけ保存する。ここにあるのは読み方と作戦の立て方だけ。 */

const COURSE_KEY = 'caddie.course.v1';
let COURSE = null;

/** 取り込むデータの形を確かめる。だめなら、どこを直せばよいかを日本語で返す */
function validateCourse(c) {
  if (!c || typeof c !== 'object') return 'JSONの形になっていません。';
  if (c.schema !== 'caddie-course-v1') return '"schema": "caddie-course-v1" がありません。コースデータのファイルか確認してください。';
  if (!c.name) return 'コース名（name）がありません。';
  if (!Array.isArray(c.greens) || !c.greens.length) return 'グリーンの種類（greens）がありません。';
  if (!Array.isArray(c.holes) || !c.holes.length) return 'ホール（holes）が1つもありません。';
  for (const h of c.holes) {
    if (!Number.isInteger(h.no) || !h.par) return `ホールの番号（no）かパー（par）が抜けています。`;
    for (const g of c.greens) {
      if (typeof h.yd?.[g.id] !== 'number') return `${h.no}番の${g.label}グリーンの距離（yd.${g.id}）がありません。`;
    }
  }
  return null;
}

function loadCourse() {
  try {
    const raw = localStorage.getItem(COURSE_KEY);
    const c = raw ? JSON.parse(raw) : null;
    COURSE = c && !validateCourse(c) ? c : null;
  } catch (_) { COURSE = null; }
  if (!COURSE) state.hole = null;
  if (COURSE && !COURSE.greens.some((g) => g.id === state.greenId)) state.greenId = COURSE.greens[0].id;
}

function importCourse(text) {
  let c;
  try { c = JSON.parse(text); } catch (_) { return '読み込めませんでした。JSONの全文をそのまま貼り付けてください（途中で切れていないか確認）。'; }
  const err = validateCourse(c);
  if (err) return err;
  try { localStorage.setItem(COURSE_KEY, JSON.stringify(c)); } catch (_) { return 'この端末に保存できませんでした（プライベートモードでは保存できません）。'; }
  loadCourse();
  state.hole = COURSE.holes[0].no;
  return null;
}

const holeOf = (no) => COURSE?.holes.find((h) => h.no === no) || null;
const greenLabel = (id) => COURSE?.greens.find((g) => g.id === id)?.label ?? '';

/** 番手が曲がりやすい側。明示がなければ計測の主なミスから読む */
function missSide(c) {
  if (c.miss_side) return c.miss_side;
  const m = c.stability ? mainMiss(c.stability) : null;
  if (!m) return null;
  if (m.includes('右') && !m.includes('左')) return 'right';
  if (m.includes('左') && !m.includes('右')) return 'left';
  return null;
}
const sideJa = { left: '左', right: '右', back: '奥', front: '手前', cross: '横切る' };

const totalYd = (c) => c.carry_game_yd + (c.run_yd || 0);

/**
 * 残り距離から、グリーンを狙うショットの評価（小さいほど良い）。
 * 番手の距離とのズレ＋得意/苦手に加えて、残りが長いほど少し不利にする。
 * 同じ「ちょうど」でも130ydの7Iより60ydの56°のほうが寄るため。
 */
function approachAt(rest, aim) {
  const res = pick('carry_game_yd', rest, aim);
  const P = DATA.course_plan;
  return { res, score: Math.abs(res.delta) + skillAdjust(res.club) + rest * P.approach_length_weight };
}

/** グリーンを狙える残り距離の上限（フェアウェイから打てる最長番手＋近さの許容） */
function reachYd(aim) {
  const fw = usableClubs('carry_game_yd').filter((c) => !c.tee_club);
  return Math.max(...fw.map((c) => basisYd(c, 'carry_game_yd', aim))) + CORR.near_threshold_yd;
}

/**
 * 残り rest からグリーンに乗せるまでの打ち方。
 * 届かないうちは刻み、刻みは「次がいちばん打ちやすい距離が残る」番手を選ぶ。
 */
function routeFrom(rest, aim) {
  const P = DATA.course_plan;
  const shots = [];
  const fw = usableClubs('carry_game_yd').filter((c) => !c.tee_club);
  for (let i = 0; i < P.max_layups && rest > reachYd(aim); i++) {
    const opts = fw
      .filter((c) => rest - totalYd(c) >= P.layup_min_rest_yd)
      .map((c) => {
        const left = rest - totalYd(c);
        // まだ届かないなら、とにかく前へ（評価は残り距離そのもの）
        const score = left > reachYd(aim) ? left : approachAt(left, aim).score + skillAdjust(c);
        return { c, left, score };
      })
      .sort((a, b) => a.score - b.score || b.left - a.left);
    if (!opts.length) break;
    shots.push({ kind: 'layup', club: opts[0].c, yd: totalYd(opts[0].c), rest: opts[0].left });
    rest = opts[0].left;
  }
  const ap = approachAt(rest, aim);
  shots.push({ kind: 'approach', club: ap.res.club, rest, delta: ap.res.delta, score: ap.score });
  return shots;
}

/** ティーショットの番手ごとに作戦を立て、良い順に並べる */
function holePlans(hole, greenId) {
  const P = DATA.course_plan;
  const len = hole.yd[greenId];
  const aim = hole.elevated_green ? 'carry' : 'green';
  const M = CORR.layup_margin_yd;
  const hz = hole.hazards || [];

  const tees = usableClubs('carry_game_yd').filter((c) => P.tee_categories.includes(c.category));
  const plans = [];
  for (const c of tees) {
    const land = totalYd(c);
    if (land >= len - P.layup_min_rest_yd) continue;   // パー3はこの作戦表の対象外
    // 横切るハザード: 実戦基準で越えられず、好球時に届いてしまう番手は使わない
    const blocked = hz.some((h) => h.side === 'cross' &&
      c.carry_game_yd < h.to + M && c.carry_best_yd + (c.run_yd || 0) > h.from - M);
    if (blocked) continue;

    const ms = missSide(c);
    const obOnMiss = hz.find((h) => h.type === 'ob' && h.side === ms && h.from <= land && land <= h.to);
    const risk = obOnMiss ? (obOnMiss.close_to && land <= obOnMiss.close_to ? 2 : 1) : 0;
    const route = routeFrom(len - land, aim);
    plans.push({
      tee: c, land, risk, ms, obOnMiss, route, aim,
      strokes: 1 + route.length,
      score: route[route.length - 1].score,
    });
  }
  // ①乗るまでの打数 ②ミスの出る側のOB ③ティーショットの距離（前に出るほど後が楽）④残る距離の打ちやすさ
  // 苦手な1Wでも、ミスの出る側にOBがなければ使う。ミス側にOBがあるときだけ②で外れる
  return plans.sort((a, b) =>
    a.strokes - b.strokes || a.risk - b.risk || b.land - a.land || a.score - b.score);
}

function teeAimText(plan, hole) {
  const ob = (hole.hazards || []).filter((h) => h.type === 'ob' && (h.side === 'left' || h.side === 'right'));
  const sides = [...new Set(ob.map((h) => h.side))];
  if (sides.length === 1) {
    const safe = sides[0] === 'left' ? '右' : '左';
    const why = plan.ms && plan.ms !== sides[0]
      ? `${plan.tee.name}のミスは${sideJa[plan.ms]}に出やすく、OBと反対側なので相性は悪くない`
      : plan.ms === sides[0]
        ? `${plan.tee.name}のミスはOB側の${sideJa[plan.ms]}に出やすい。いつもより${safe}を向く`
        : `${sideJa[sides[0]]}はOB`;
    return `フェアウェイの${safe}半分。${why}`;
  }
  if (sides.length === 2) return 'フェアウェイの真ん中。両側がOBなので、曲がり幅の小さい番手を優先';
  return 'フェアウェイの広い側';
}

function renderCourse() {
  const imp = $('courseImport');
  const view = $('courseView');
  imp.hidden = !!COURSE;
  view.hidden = !COURSE;
  if (!COURSE) return;

  $('courseName').textContent = COURSE.name;
  $('courseTee').textContent = `${COURSE.tee ?? ''}ティー`;

  const gHost = $('greenChips');
  gHost.textContent = '';
  for (const g of COURSE.greens) {
    const b = el('button', 'chip' + (state.greenId === g.id ? ' is-on' : ''), g.label);
    b.type = 'button';
    b.addEventListener('click', () => { state.greenId = g.id; renderAll(); });
    gHost.appendChild(b);
  }

  const hHost = $('holeChips');
  hHost.textContent = '';
  for (let no = 1; no <= 18; no++) {
    const has = !!holeOf(no);
    const b = el('button', 'chip hole-chip' + (state.hole === no ? ' is-on' : ''), String(no));
    b.type = 'button';
    b.disabled = !has;
    if (has) b.addEventListener('click', () => { state.hole = no; renderAll(); });
    hHost.appendChild(b);
  }

  const out = $('holeOut');
  out.textContent = '';
  const hole = holeOf(state.hole);
  if (!hole) {
    out.appendChild(el('p', 'layup-empty', 'ホールを選んでください。'));
    return;
  }
  const len = hole.yd[state.greenId];

  const head = el('div', 'hole-head');
  head.appendChild(el('div', 'hole-no', `${hole.no}`));
  const meta = el('div', 'hole-meta');
  meta.appendChild(el('div', 'hole-par', `Par ${hole.par}`));
  meta.appendChild(el('div', 'hole-yd', `${len}yd（${greenLabel(state.greenId)}）`));
  head.appendChild(meta);
  out.appendChild(head);

  // 作戦
  const plans = hole.par >= 4 ? holePlans(hole, state.greenId) : [];
  if (plans.length) {
    const best = plans[0];
    const box = el('div', 'plan');
    box.appendChild(el('div', 'plan-title', '作戦'));
    const step = (n, club, text, sub) => {
      const r = el('div', 'plan-step');
      r.appendChild(el('div', 'plan-n', n));
      r.appendChild(el('div', 'plan-club', club));
      const t = el('div', 'plan-text', text);
      if (sub) t.appendChild(el('div', 'plan-sub', sub));
      r.appendChild(t);
      box.appendChild(r);
    };
    step('1打目', best.tee.name, `約${r0(best.land)}yd（キャリー${best.tee.carry_game_yd}）`, teeAimText(best, hole));
    best.route.forEach((s, i) => {
      const n = `${i + 2}打目`;
      if (s.kind === 'layup') {
        step(n, s.club.name, `約${r0(s.yd)}yd刻む → 残り${r0(s.rest)}yd`,
          s.club.skill === 'good' ? `得意な${s.club.name}で、次が打ちやすい距離を残す` : '次が打ちやすい距離を残す');
      } else {
        const sub = hole.elevated_green ? '砲台グリーン。キャリーで乗せる（狙いは「越える」）' : null;
        step(n, s.club.name, `残り${r0(s.rest)}yd（${deltaText(s.delta)}）`, sub);
      }
    });
    // パーオン＝パー−2打で乗る。1打遅れるごとに2パットで1つずつ増える
    const onIn = best.strokes;
    const over = onIn - (hole.par - 2);
    const target = over <= 0 ? 'パー' : over === 1 ? 'ボギー' : `${over}オーバー`;
    box.appendChild(el('div', 'plan-goal',
      `目標：${target}（${onIn}オン2パット）${over > 0 ? '　無理に届かせない' : ''}`));

    const last = best.route[best.route.length - 1];
    const go2 = el('button', 'reset-btn plan-go', `${onIn}打目（残り${r0(last.rest)}yd）を推奨画面で見る`);
    go2.type = 'button';
    go2.addEventListener('click', () => {
      state.unit = 'yd';
      state.dist = r0(last.rest);
      state.aim = best.aim;
      refreshChips();
      go('pick');
      renderAll();
    });
    box.appendChild(go2);

    // ティーの番手が不調な日の代案。得意な番手で始める作戦があればそれを出す
    const others = plans.filter((p) => p.tee !== best.tee);
    const alt = others.find((p) => skillOf(p.tee) === 'good') || others[0];
    if (alt) {
      const seq = [alt.tee, ...alt.route.map((s) => s.club)].map((c) => c.name).join(' → ');
      box.appendChild(el('div', 'plan-alt',
        `${best.tee.name}が不調な日：${seq}（${alt.strokes}打目でグリーン、最後は残り${r0(alt.route[alt.route.length - 1].rest)}yd）`));
    }
    out.appendChild(box);
  }

  // ホールの特徴
  const feat = el('div', 'hole-feats');
  for (const h of hole.hazards || []) {
    const f = el('div', 'hole-feat', h.text);
    f.dataset.type = h.type;
    feat.appendChild(f);
  }
  const gn = hole.green_notes?.[state.greenId];
  if (gn) {
    const f = el('div', 'hole-feat', gn);
    f.dataset.type = 'green';
    feat.appendChild(f);
  }
  out.appendChild(feat);

  if (hole.memo) out.appendChild(el('p', 'hole-memo', hole.memo));
  if (hole.unverified) out.appendChild(el('p', 'hole-unv', `未確認：${hole.unverified}`));
  if (COURSE.source) out.appendChild(el('p', 'hole-unv', `出どころ：${COURSE.source}`));
}

/** 推奨画面の上に、いまのホールを細く出す。グリーンを狙う注意もここから足す */
function renderHoleStrip() {
  const strip = $('holeStrip');
  const hole = holeOf(state.hole);
  strip.hidden = !hole;
  if (!hole) return;
  strip.querySelector('.hs-text').textContent =
    `${hole.no}番 Par${hole.par} ${hole.yd[state.greenId]}yd（${greenLabel(state.greenId)}）`;
}

function holeNotes(add) {
  const hole = holeOf(state.hole);
  if (!hole) return;
  const back = (hole.hazards || []).find((h) => h.side === 'back' && h.type === 'ob');
  if (back) add('warn', `${hole.no}番：グリーン奥はOB。迷ったら短いほうの番手を選ぶ。`);
  const gn = hole.green_notes?.[state.greenId];
  if (gn) add('info', `${hole.no}番：${gn}。`);
  if (hole.elevated_green && state.aim !== 'carry') {
    add('info', `${hole.no}番は砲台グリーン。手前から転がり上がりにくいので「越える」（キャリー）で合わせるのが基本です。`);
  }
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

  // グリーンの硬さは普通のときは省く（要約行を短く保つ）
  const gf = CORR.green_firmness;
  if (state.greenFirm !== gf.default) {
    const f = gf.presets.find((p) => p.id === state.greenFirm);
    if (f) parts.push(`グリーン${f.label}`);
  }

  const node = $('condSummary');
  node.textContent = parts.join('・');
  const isDefault =
    state.elevYd === 0 && state.windDir === 'none' &&
    state.lie === 'fairway' && state.tempC === CORR.temperature.base_c &&
    state.greenFirm === gf.default;
  node.dataset.on = isDefault ? '0' : '1';
}

/* ─────────── 描画: 得意・苦手（今日の調子） ─────────── */

function renderSkills() {
  const host = $('skillList');
  host.textContent = '';
  const clubs = usableClubs('carry_game_yd').sort((a, b) => b.carry_game_yd - a.carry_game_yd);
  const today = todaySkills();

  for (const c of clubs) {
    const row = el('div', 'skill-row');
    const nm = el('div', 'skill-name', c.name);
    if (today[c.id]) {
      nm.appendChild(el('span', 'skill-today', `今日（普段は${skillLabel(skillBase(c))}）`));
    }
    const st = stabilityOf(c).rating;
    if (st !== 'none') {
      const b = el('span', 'skill-stab', `計測: ${stabLabel(st)}`);
      b.dataset.stab = st;
      nm.appendChild(b);
    }
    const hint = skillHint(c);
    if (hint) nm.appendChild(el('span', 'skill-hint', hint));
    if (c.skill_hold && !today[c.id]) nm.appendChild(el('span', 'skill-stab', c.skill_hold));
    row.appendChild(nm);

    const chips = el('div', 'chips');
    for (const s of ['good', 'normal', 'weak']) {
      const b = el('button', 'chip', skillLabel(s));
      b.type = 'button';
      b.dataset.skill = s;
      if (skillOf(c) === s) b.classList.add('is-on');
      b.addEventListener('click', () => {
        // 普段の設定に戻したら上書きを消す。上書きは「普段と違う」ときだけ持つ
        if (s === skillBase(c)) delete today[c.id];
        else today[c.id] = s;
        saveToday();
        renderAll();
      });
      chips.appendChild(b);
    }
    row.appendChild(chips);
    host.appendChild(row);
  }

  $('skillReset').hidden = Object.keys(today).length === 0;
}

/* ─────────── 描画: 番手の傾向（安定度） ─────────── */

function renderTrends() {
  const R = DATA.stability_rules;
  const clubs = usableClubs('carry_game_yd').sort((a, b) => b.carry_game_yd - a.carry_game_yd);

  // 種類ごと: 球数とミスを足し合わせて見る。1本だけの種類もそのまま出す
  const groups = $('trendGroups');
  groups.textContent = '';
  for (const [cat, label] of Object.entries(R.categories)) {
    const members = clubs.filter((c) => c.category === cat);
    if (!members.length) continue;
    const measured = members.filter((c) => stabilityOf(c).rating !== 'none');
    const item = el('div', 'trend-group');
    const head = el('div', 'trend-head');
    head.appendChild(el('span', 'trend-cat', label));
    head.appendChild(el('span', 'trend-clubs', members.map((c) => c.name).join(' ')));
    item.appendChild(head);

    if (!measured.length) {
      item.appendChild(el('div', 'trend-line', '今回の計測なし'));
      groups.appendChild(item);
      continue;
    }
    const sum = (k) => measured.reduce((n, c) => n + c.stability[k], 0);
    const shots = sum('shots');
    const pooled = {
      miss_right: sum('miss_right'), miss_left: sum('miss_left'), miss_low: sum('miss_low'),
    };
    const main = mainMiss(pooled);
    const mainN = main ? Math.max(pooled.miss_right, pooled.miss_left, pooled.miss_low) : 0;
    const ratings = measured.map((c) => `${c.name} ${stabLabel(stabilityOf(c).rating)}`).join('・');
    item.appendChild(el('div', 'trend-line',
      `ミス率${pct(sum('miss') / shots)}（${shots}球）` +
      (main ? `　主なミス：${main}（${mainN}球）` : '　目立つミスなし')));
    item.appendChild(el('div', 'trend-sub', ratings));
    const notes = measured.map((c) => c.stability.note).filter(Boolean);
    if (notes.length) item.appendChild(el('div', 'trend-sub', notes.join(' ')));
    groups.appendChild(item);
  }

  const body = $('stabBody');
  body.textContent = '';
  for (const c of clubs) {
    const st = stabilityOf(c);
    const tr = el('tr');
    tr.appendChild(el('td', 'club-cell', c.name));
    if (st.rating === 'none') {
      const td = el('td', 'sub-num', '計測なし');
      td.colSpan = 4;
      td.style.textAlign = 'left';
      tr.appendChild(td);
    } else {
      const s = c.stability;
      tr.appendChild(el('td', 'sub-num', `${pct(st.rate)}`));
      tr.appendChild(el('td', 'sub-num', `±${r0(s.carry_sd_yd)}`));
      tr.appendChild(el('td', 'stab-miss', st.main || '—'));
      const r = el('td', 'stab-rate', stabLabel(st.rating));
      r.dataset.stab = st.rating;
      tr.appendChild(r);
    }
    body.appendChild(tr);
  }
}

function renderAll() {
  renderDist();
  renderCondSummary();
  renderEff();
  renderCards();
  renderCarrySet();
  renderNotes();
  renderLadder();
  renderSkills();
  renderTrends();
  renderTable();
  renderLayup();
  renderCourse();
  renderHoleStrip();
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
  // 狙いの説明文は常時は出さない。既定(グリーンに乗せる)は自明で、
  // 切り替えたときだけ注意書きに出せば足りる。ここは高さが答えを押し下げる
  buildChips($('aimChips'),
    AIM.modes.map((m) => ({ label: m.label, v: m.id })),
    (i) => i.v === state.aim, (i) => { state.aim = i.v; });

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

  buildChips($('firmChips'),
    CORR.green_firmness.presets.map((p) => ({ label: p.label, v: p.id })),
    (i) => i.v === state.greenFirm, (i) => { state.greenFirm = i.v; });
}

/* ─────────── 入力イベント ─────────── */

function bindInputs() {
  const err = $('courseErr');
  const doImport = (text) => {
    const msg = importCourse(text);
    err.hidden = !msg;
    err.textContent = msg || '';
    if (!msg) { $('courseText').value = ''; renderAll(); }
  };
  $('courseImportBtn').addEventListener('click', () => doImport($('courseText').value));
  $('courseFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then(doImport).catch(() => { err.hidden = false; err.textContent = 'ファイルを読めませんでした。'; });
  });
  $('courseClear').addEventListener('click', () => {
    if (!confirm('取り込んだコースをこの端末から消します。よろしいですか？')) return;
    try { localStorage.removeItem(COURSE_KEY); } catch (_) { /* 無視 */ }
    COURSE = null;
    state.hole = null;
    renderAll();
  });
  $('holeStripOpen').addEventListener('click', () => go('course'));
  $('holeStripClear').addEventListener('click', () => { state.hole = null; renderAll(); });

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

  $('skillReset').addEventListener('click', () => {
    TODAY = { date: todayStr(), skills: {} };
    saveToday();
    renderAll();
  });

  $('resetCond').addEventListener('click', () => {
    state.elevYd = 0; state.windDir = 'none'; state.windMs = CORR.wind.presets_ms.mid;
    state.lie = 'fairway'; state.tempC = CORR.temperature.base_c;
    state.greenFirm = CORR.green_firmness.default;
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
  AIM = DATA.aim_modes;
  YPM = DATA.unit.yd_per_m;
  state.unit = DATA.unit.input_default || 'yd';
  state.aim = AIM.default || 'green';
  load();
  loadToday();
  loadCourse();
  if (!CORR.lie[state.lie]) state.lie = 'fairway';
  if (!aimMode()) state.aim = AIM.default;
  if (!CORR.green_firmness.presets.some((p) => p.id === state.greenFirm)) state.greenFirm = CORR.green_firmness.default;

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
