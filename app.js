'use strict';
// ---------- 状態 ----------
const $ = id => document.getElementById(id);
const media = $('media'), ytWrap = $('ytWrap'), nicoWrap = $('nicoWrap'), nicoFrame = $('nicoFrame'), stage = $('stage'), empty = $('empty');
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
let list = store.get('list', []);       // {id,kind:'yt'|'file'|'local',src,title}
let cur = store.get('cur', -1);
let repeat = store.get('repeat', 0);    // 0:オフ 1:全曲 2:1曲
let shuffle = store.get('shuffle', false);
let audioOnly = store.get('audioOnly', false);
let wantPlaying = false;                // ユーザーが「再生中のはず」の状態
let yt = null, ytReady = false, ytPending = null, hls = null;
let wakeLock = null, wakeOn = false;
const localFiles = new Map();           // id -> File(再読込で消える)

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- URL判定 ----------
function parseYouTube(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\.|^m\.|^music\./, '');
    let id = null;
    if (h === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
    else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else {
        const m = url.pathname.match(/^\/(shorts|live|embed|v)\/([\w-]{11})/);
        if (m) id = m[2];
      }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
function parseNico(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.replace(/^www\.|^sp\./, '');
    let m = null;
    if (h === 'nicovideo.jp') m = url.pathname.match(/^\/watch\/((?:sm|nm|so)?\d+)/);
    else if (h === 'nico.ms') m = url.pathname.match(/^\/((?:sm|nm|so)?\d+)/);
    else if (h === 'embed.nicovideo.jp') m = url.pathname.match(/^\/watch\/((?:sm|nm|so)?\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}
function makeItem(u) {
  u = u.trim();
  const id = parseYouTube(u);
  if (id) return { id: uid(), kind: 'yt', src: id, title: 'YouTube ' + id };
  const nid = parseNico(u);
  if (nid) return { id: uid(), kind: 'nico', src: nid, title: 'ニコニコ ' + nid };
  try {
    const url = new URL(u);
    const name = decodeURIComponent(url.pathname.split('/').pop()) || url.hostname;
    return { id: uid(), kind: 'file', src: u, title: name };
  } catch { return null; }
}

// ---------- 無音ループ(Android等でメディアセッションを維持する補助) ----------
const silent = new Audio();
silent.loop = true; silent.volume = 0.01;
silent.src = (() => { // 1秒の無音WAV
  const sr = 8000, n = sr, b = new DataView(new ArrayBuffer(44 + n));
  const w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, sr, true); b.setUint32(28, sr, true);
  b.setUint16(32, 1, true); b.setUint16(34, 8, true); w(36, 'data'); b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
})();

// ---------- YouTube ----------
function loadYTApi() {
  if (window.YT || document.getElementById('ytapi')) return;
  const s = document.createElement('script');
  s.id = 'ytapi'; s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
}
window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player('ytPlayer', {
    width: '100%', height: '100%',
    playerVars: { playsinline: 1, rel: 0, origin: location.origin },
    events: {
      onReady: () => { ytReady = true; if (ytPending) { yt.loadVideoById(ytPending); ytPending = null; } },
      onStateChange: onYtState,
      onError: () => { setTitle('再生できない動画です(埋め込み禁止等)。次へ進みます'); setTimeout(next, 1500); }
    }
  });
};
function onYtState(e) {
  const S = YT.PlayerState;
  if (e.data === S.PLAYING) {
    const d = yt.getVideoData();
    if (d && d.title && list[cur]) { list[cur].title = d.title; save(); render(); setTitle(d.title); updateSession(); }
    wantPlaying = true; setPlayIcon(true); silentOn();
  } else if (e.data === S.PAUSED) {
    // 画面オフ等で勝手に止まった場合は自動再開を試みる
    if (wantPlaying && document.hidden) { setTimeout(() => { try { yt.playVideo(); } catch {} }, 300); return; }
    setPlayIcon(false);
  } else if (e.data === S.ENDED) onEnded();
}

// ---------- ニコニコ(埋め込みプレイヤー postMessage API) ----------
let nicoPlaying = false, nicoTime = 0;
function nicoCmd(eventName, data) {
  try { nicoFrame.contentWindow.postMessage({ sourceConnectorType: 1, playerId: '1', eventName, ...(data ? { data } : {}) }, 'https://embed.nicovideo.jp'); } catch {}
}
window.addEventListener('message', e => {
  if (e.origin !== 'https://embed.nicovideo.jp' || !e.data || e.data.playerId !== '1' || list[cur]?.kind !== 'nico') return;
  const { eventName, data } = e.data;
  if (eventName === 'playerMetadataChange' && data) {
    nicoTime = data.currentTime || 0;
  } else if (eventName === 'playerStatusChange' && data) {
    // 2:再生中 3:一時停止 4:再生完了
    if (data.playerStatus === 2) { nicoPlaying = true; wantPlaying = true; setPlayIcon(true); setPS('playing'); silentOn(); }
    else if (data.playerStatus === 3) { nicoPlaying = false; setPlayIcon(false); setPS('paused'); }
    else if (data.playerStatus === 4) { nicoPlaying = false; onEnded(); }
  } else if (eventName === 'error') {
    // 致命的とは限らないので自動スキップはせず、内容を表示する(プレイヤー内の再生ボタンも押せる)
    setTitle('ニコニコ: エラー通知 ' + JSON.stringify(data || {}).slice(0, 120));
  }
});

// ---------- 再生制御 ----------
function stopAll() {
  media.pause(); media.removeAttribute('src'); media.load();
  if (hls) { hls.destroy(); hls = null; }
  try { ytReady && yt.stopVideo(); } catch {}
  nicoFrame.removeAttribute('src'); nicoWrap.hidden = true;
}
function play(i) {
  if (i < 0 || i >= list.length) return;
  cur = i; store.set('cur', cur);
  const it = list[i];
  stopAll(); render(); setTitle(it.title); empty.hidden = true; wantPlaying = true;
  if (it.kind === 'nico') {
    media.hidden = true; ytWrap.hidden = true; nicoWrap.hidden = false; stage.classList.remove('audio');
    nicoFrame.src = `https://embed.nicovideo.jp/watch/${it.src}?jsapi=1&playerId=1&autoplay=1`;
    silentOn();
  } else if (it.kind === 'yt') {
    media.hidden = true; ytWrap.hidden = false; stage.classList.remove('audio');
    loadYTApi();
    if (ytReady) yt.loadVideoById(it.src); else ytPending = it.src;
  } else {
    ytWrap.hidden = true; media.hidden = false; setAudioLayout();
    if (it.kind === 'local' && !localFiles.has(it.id)) { setTitle(it.title + '(再読込後は再選択が必要です)'); wantPlaying = false; setPlayIcon(false); return; }
    const src = it.kind === 'local' ? URL.createObjectURL(localFiles.get(it.id)) : it.src;
    if (/\.m3u8(\?|$)/i.test(src) && !media.canPlayType('application/vnd.apple.mpegurl')) {
      loadHls().then(() => {
        hls = new Hls(); hls.loadSource(src); hls.attachMedia(media);
        media.play().catch(() => {});
      });
    } else {
      media.src = src; media.play().catch(() => { setTitle(it.title + '(タップで再生)'); setPlayIcon(false); });
    }
    silentOff();
  }
  updateSession();
}
function loadHls() {
  if (window.Hls) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js';
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
function toggle() {
  if (cur < 0) { if (list.length) play(0); return; }
  const it = list[cur];
  if (it.kind === 'nico') {
    if (nicoPlaying) pauseAny(); else playAny();
    return;
  }
  if (it.kind === 'yt') {
    if (!ytReady) return;
    const st = yt.getPlayerState();
    if (st === YT.PlayerState.PLAYING) { wantPlaying = false; yt.pauseVideo(); setPlayIcon(false); }
    else { wantPlaying = true; yt.playVideo(); }
  } else {
    if (media.paused) media.play(); else media.pause();
  }
}
function pauseAny() { wantPlaying = false; if (list[cur]?.kind === 'nico') nicoCmd('pause'); else if (list[cur]?.kind === 'yt') { try { yt.pauseVideo(); } catch {} } else media.pause(); }
function playAny() { wantPlaying = true; if (list[cur]?.kind === 'nico') nicoCmd('play'); else if (list[cur]?.kind === 'yt') { try { yt.playVideo(); } catch {} } else media.play().catch(() => {}); }
function pickNext(dir) {
  if (!list.length) return -1;
  if (shuffle && list.length > 1) { let r; do r = Math.floor(Math.random() * list.length); while (r === cur); return r; }
  return cur + dir;
}
function next() {
  let n = pickNext(1);
  if (n >= list.length) n = repeat === 1 ? 0 : -1;
  if (n >= 0) play(n); else { wantPlaying = false; setPlayIcon(false); }
}
function prev() {
  const t = curTime();
  if (t > 5) return seekTo(0);
  let n = pickNext(-1); if (n < 0) n = repeat === 1 ? list.length - 1 : 0;
  play(n);
}
function seekTo(t) { if (list[cur]?.kind === 'nico') nicoCmd('seek', { time: t }); else if (list[cur]?.kind === 'yt') yt.seekTo(t, true); else media.currentTime = t; }
function onEnded() {
  if (repeat === 2) return play(cur);
  next();
}
media.addEventListener('ended', onEnded);
media.addEventListener('play', () => { wantPlaying = true; setPlayIcon(true); setPS('playing'); });
media.addEventListener('pause', () => { if (!media.ended) { wantPlaying = false; setPlayIcon(false); setPS('paused'); } });
media.addEventListener('error', () => { setTitle('読み込めませんでした: ' + (list[cur]?.title || '')); });
media.addEventListener('timeupdate', throttle(updatePosition, 1000));

// ---------- UI ----------
const setTitle = t => { $('nowTitle').textContent = t || ''; };
const setPlayIcon = p => { $('playBtn').textContent = p ? '⏸' : '▶'; };
function save() { store.set('list', list); store.set('cur', cur); }
function render() {
  const ul = $('list'); ul.textContent = '';
  list.forEach((it, i) => {
    const li = document.createElement('li'); if (i === cur) li.className = 'cur';
    const t = document.createElement('div'); t.className = 't';
    t.textContent = it.title; t.onclick = () => play(i);
    const k = document.createElement('span'); k.className = 'k';
    k.textContent = it.kind === 'yt' ? 'YT' : it.kind === 'nico' ? 'ニコ' : it.kind === 'local' ? '端末' : 'URL';
    const d = document.createElement('button'); d.textContent = '✕'; d.setAttribute('aria-label', '削除');
    d.onclick = () => { list.splice(i, 1); if (i < cur) cur--; else if (i === cur) { cur = -1; stopAll(); wantPlaying = false; setPlayIcon(false); } save(); render(); };
    li.append(k, t, d); ul.append(li);
  });
  $('repeatBtn').textContent = '🔁 ' + ['オフ', '全曲', '1曲'][repeat];
  $('shuffleBtn').textContent = '🔀 ' + (shuffle ? 'オン' : 'オフ');
  $('audioOnlyBtn').textContent = '音声のみ(ファイル) ' + (audioOnly ? 'オン' : 'オフ');
  $('wakeBtn').textContent = '画面点灯 ' + (wakeOn ? 'オン' : 'オフ');
}
function setAudioLayout() {
  const isAudio = audioOnly || (list[cur]?.kind !== 'yt' && /\.(mp3|m4a|aac|ogg|opus|wav|flac)(\?|$)/i.test(list[cur]?.src || list[cur]?.title || ''));
  stage.classList.toggle('audio', isAudio);
  media.style.height = isAudio ? '54px' : '100%';
}
function add(u, playNow) {
  const it = makeItem(u);
  if (!it) { alert('URLの形式が正しくありません'); return; }
  list.push(it); save(); render();
  if (playNow) play(list.length - 1);
}
$('addForm').addEventListener('submit', e => {
  e.preventDefault(); add($('urlInput').value, true); $('urlInput').value = '';
});
$('queueBtn').onclick = () => { const v = $('urlInput').value; if (v.trim()) { add(v, false); $('urlInput').value = ''; } };
$('fileInput').addEventListener('change', e => {
  const first = list.length;
  for (const f of e.target.files) {
    const id = uid(); localFiles.set(id, f);
    list.push({ id, kind: 'local', src: '', title: f.name });
  }
  save(); render(); if (e.target.files.length) play(first); e.target.value = '';
});
$('playBtn').onclick = toggle; $('nextBtn').onclick = next; $('prevBtn').onclick = prev;
$('repeatBtn').onclick = () => { repeat = (repeat + 1) % 3; store.set('repeat', repeat); render(); };
$('shuffleBtn').onclick = () => { shuffle = !shuffle; store.set('shuffle', shuffle); render(); };
$('audioOnlyBtn').onclick = () => { audioOnly = !audioOnly; store.set('audioOnly', audioOnly); setAudioLayout(); render(); };
$('clearBtn').onclick = () => { if (confirm('再生リストを空にしますか?')) { list = []; cur = -1; stopAll(); wantPlaying = false; save(); render(); setTitle(''); empty.hidden = false; } };
$('pipBtn').onclick = async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (list[cur]?.kind !== 'yt' && list[cur]?.kind !== 'nico' && document.pictureInPictureEnabled) await media.requestPictureInPicture();
    else alert('小窓はファイル/URL再生で利用できます。YouTubeはYouTube側の操作に従ってください。');
  } catch (e) { alert('小窓にできませんでした: ' + e.message); }
};
// 画面点灯(Wake Lock)
async function lockWake() { try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
$('wakeBtn').onclick = async () => {
  wakeOn = !wakeOn;
  if (wakeOn) { if (!('wakeLock' in navigator)) { alert('この端末では画面点灯に対応していません'); wakeOn = false; } else await lockWake(); }
  else { try { await wakeLock?.release(); } catch {} wakeLock = null; }
  render();
};
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    if (wakeOn) lockWake();
    // 戻ってきたときに止まっていたら再開
    if (wantPlaying) setTimeout(playAny, 200);
  }
});

// ---------- Media Session(ロック画面操作) ----------
function silentOn() { silent.play().catch(() => {}); }
function silentOff() { silent.pause(); }
function setPS(s) { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s; }
function updateSession() {
  if (!('mediaSession' in navigator) || cur < 0) return;
  const it = list[cur];
  const art = it.kind === 'yt' ? [{ src: `https://i.ytimg.com/vi/${it.src}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' }]
    : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }];
  navigator.mediaSession.metadata = new MediaMetadata({ title: it.title, artist: 'BG Player', artwork: art });
}
function updatePosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (list[cur]?.kind === 'yt' || list[cur]?.kind === 'nico' || !isFinite(media.duration)) return;
  try { navigator.mediaSession.setPositionState({ duration: media.duration, position: media.currentTime, playbackRate: media.playbackRate }); } catch {}
}
if ('mediaSession' in navigator) {
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch {} };
  h('play', playAny); h('pause', pauseAny);
  h('nexttrack', next); h('previoustrack', prev);
  h('seekbackward', () => seekTo(Math.max(0, curTime() - 10)));
  h('seekforward', () => seekTo(curTime() + 10));
  h('seekto', d => seekTo(d.seekTime));
}
function curTime() { if (list[cur]?.kind === 'nico') return nicoTime; return list[cur]?.kind === 'yt' && ytReady ? yt.getCurrentTime() : media.currentTime; }
function throttle(f, ms) { let t = 0; return (...a) => { const n = Date.now(); if (n - t > ms) { t = n; f(...a); } }; }

// ---------- 起動 ----------
render();
if (cur >= 0 && list[cur]) { setTitle(list[cur].title); empty.hidden = true; }
if (list.some(i => i.kind === 'yt')) loadYTApi();
// 共有シート/ブックマークから ?url= で渡された場合
const q = new URLSearchParams(location.search);
const shared = q.get('url') || q.get('text');
if (shared) { const m = shared.match(/https?:\/\/\S+/); if (m) add(m[0], false); history.replaceState(null, '', location.pathname); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
