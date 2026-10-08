/*
 * 그 자리, 그 계절 — 1주차 기능
 * 화면 전환 / 지도 / 가까운 순 정렬 / 명소·촬영 지점·격자 / 오늘의 해 / 사진 분석 / 계절 색
 * 화면 디자인(HTML·CSS)은 index.html, 명소 데이터는 data.js
 */
(function () {
  'use strict';

  // ---------- 기본값 ----------
  const CITY_CENTER = { lat: 36.6424, lon: 127.4890 }; // 청주시청 부근
  const NEAR_LIMIT_M = 300; // 사진이 명소에서 이 거리 안이어야 함
  const SEASONS = [
    { key: 'spring', name: '봄', months: [3, 4, 5] },
    { key: 'summer', name: '여름', months: [6, 7, 8] },
    { key: 'autumn', name: '가을', months: [9, 10, 11] },
    { key: 'winter', name: '겨울', months: [12, 1, 2] },
  ];
  const LIGHTS = [
    { key: 'sunrise', name: '일출' },
    { key: 'clear', name: '맑음' },
    { key: 'sunset', name: '일몰' },
    { key: 'rain', name: '비' },
  ];
  const DIRS = ['북', '북북동', '북동', '동북동', '동', '동남동', '남동', '남남동', '남', '남남서', '남서', '서남서', '서', '서북서', '북서', '북북서'];

  const SPOTS = window.SPOTS || [];
  const PHOTOS = window.PHOTOS || [];
  const $ = (s, root = document) => root.querySelector(s);

  const state = { here: null, hereLabel: '청주 시내 기준', spotId: null, pointIdx: 0, preset: null, map: null, hereMarker: null };

  // ---------- 날짜·계절 ----------
  function kstNow() { return new Date(Date.now() + 9 * 3600e3); } // UTC 필드로 읽으면 한국 시각
  function seasonOfMonth(m) { return SEASONS.find(s => s.months.includes(m)); }
  function currentSeason() {
    const forced = new URLSearchParams(location.search).get('season'); // ?season=spring 으로 미리보기
    return SEASONS.find(s => s.key === forced) || seasonOfMonth(kstNow().getUTCMonth() + 1);
  }
  const pad = n => String(n).padStart(2, '0');
  function kstHM(d) { const k = new Date(d.getTime() + 9 * 3600e3); return `${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}`; }
  function kstMinutes(d) { const k = new Date(d.getTime() + 9 * 3600e3); return k.getUTCHours() * 60 + k.getUTCMinutes(); }
  const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };

  // ---------- 거리·방향 ----------
  function distanceM(a, b) {
    const R = 6371e3, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const fmtDist = m => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`);
  const dirName = deg => DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
  function sunAzimuth(time, lat, lon) {
    // SunCalc 방위각은 남쪽 0, 서쪽 +. 나침반 각도(북 0, 동 90)로 바꿈
    const az = SunCalc.getPosition(time, lat, lon).azimuth * 180 / Math.PI;
    return (az + 180 + 360) % 360;
  }

  // ---------- 촬영 불가 칸 ----------
  // 운영시간이 있는 곳은, 그 계절 어느 달에도 일출·일몰이 운영시간 안에 들지 않으면 촬영 불가
  function isClosed(spot, season, light) {
    if (!spot.hours || (light !== 'sunrise' && light !== 'sunset')) return false;
    const year = kstNow().getUTCFullYear();
    return !season.months.some(m => {
      const [open, close] = spot.hours[m];
      const day = new Date(Date.UTC(year, m - 1, 15, 3)); // 그달 15일 정오(한국)
      const t = SunCalc.getTimes(day, spot.lat, spot.lon)[light];
      const min = kstMinutes(t);
      return min >= toMin(open) && min <= toMin(close);
    });
  }
  function photosFor(spotId, pointIdx, season, light) {
    return PHOTOS.filter(p => p.spot === spotId && p.point === pointIdx && p.season === season && p.light === light);
  }

  // ---------- 화면 전환 ----------
  const views = {};
  document.querySelectorAll('section[data-view]').forEach(s => { views[s.dataset.view] = s; });
  function show(name) {
    Object.entries(views).forEach(([k, el]) => el.classList.toggle('is-active', k === name));
    window.scrollTo(0, 0);
    if (name === 'map' && state.map) setTimeout(() => state.map.invalidateSize(), 0);
  }
  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const spot = SPOTS.find(s => s.id === parts[1]);
    if (parts[0] === 'spot' && spot) { state.spotId = spot.id; renderSpot(spot); show('spot'); return; }
    if (parts[0] === 'point' && spot) {
      const idx = Math.min(Number(parts[2]) || 0, spot.points.length - 1);
      state.spotId = spot.id; state.pointIdx = idx; renderPoint(spot, idx); show('point'); return;
    }
    if (parts[0] === 'upload') { renderUploadHeader(); show('upload'); return; }
    renderSpotList(); show('map'); initMap();
  }
  const go = hash => { if (location.hash === hash) route(); else location.hash = hash; };

  // ---------- 1. 지도 + 가까운 명소 ----------
  function baseLocation() { return state.here || CITY_CENTER; }
  function renderSpotList() {
    const list = $('#spot-list');
    const tpl = $('#tpl-spot-item');
    const base = baseLocation();
    list.innerHTML = '';
    SPOTS.map(s => ({ s, d: distanceM(base, s) }))
      .sort((a, b) => a.d - b.d)
      .forEach(({ s, d }) => {
        const li = tpl.content.firstElementChild.cloneNode(true);
        $('[data-field="name"]', li).textContent = s.name;
        $('[data-field="distance"]', li).textContent = fmtDist(d);
        const tags = $('[data-field="tags"]', li);
        s.tags.forEach(t => { const span = document.createElement('span'); span.className = 'tag'; span.textContent = t; tags.appendChild(span); });
        makeButton(li, `${s.name}, ${fmtDist(d)}`, () => go(`#/spot/${s.id}`));
        list.appendChild(li);
      });
    $('#sort-basis').textContent = `${state.hereLabel} · 거리순`;
  }

  function initMap() {
    if (state.map || !window.L) return;
    const el = $('#map');
    el.innerHTML = '';
    const map = L.map(el, { zoomControl: false, scrollWheelZoom: false, tap: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    SPOTS.forEach(s => {
      const icon = L.divIcon({
        className: 'spot-marker', iconSize: [16, 16], iconAnchor: [8, 22],
        html: `<span class="map-pin"></span><span class="pin-label">${s.name}</span>`,
      });
      L.marker([s.lat, s.lon], { icon, title: s.name, keyboard: true }).addTo(map).on('click', () => go(`#/spot/${s.id}`));
    });
    map.fitBounds(SPOTS.map(s => [s.lat, s.lon]), { padding: [36, 36] });
    const labelToggle = () => el.classList.toggle('show-labels', map.getZoom() >= 12);
    map.on('zoomend', labelToggle); labelToggle();
    state.map = map;
    if (state.here) showHereOnMap();
  }
  function showHereOnMap() {
    if (!state.map || !state.here) return;
    const icon = L.divIcon({ className: 'here-marker', iconSize: [14, 14], html: '<span></span>' });
    if (state.hereMarker) state.hereMarker.setLatLng([state.here.lat, state.here.lon]);
    else state.hereMarker = L.marker([state.here.lat, state.here.lon], { icon, interactive: false }).addTo(state.map);
  }

  function locate(silent) {
    const chip = $('#locate');
    if (!navigator.geolocation) { chip.lastElementChild.textContent = '이 브라우저는 위치를 지원하지 않아요'; return; }
    if (!silent) chip.lastElementChild.textContent = '내 위치 찾는 중…';
    navigator.geolocation.getCurrentPosition(pos => {
      state.here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.hereLabel = '내 위치 기준';
      chip.lastElementChild.textContent = '내 위치에서 가까운 곳';
      chip.classList.add('is-on');
      renderSpotList();
      showHereOnMap();
    }, () => {
      if (!silent) chip.lastElementChild.textContent = '위치를 못 가져왔어요 · 눌러서 다시 시도';
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  // ---------- 2. 명소 상세 ----------
  function renderSpot(spot) {
    $('#spot-title').textContent = spot.name;
    $('#spot-hours').textContent = spot.hoursText;
    $('#spot-parking').textContent = spot.parking;
    $('#spot-note').textContent = spot.note;

    const times = SunCalc.getTimes(new Date(), spot.lat, spot.lon);
    $('#sun-rise').textContent = kstHM(times.sunrise);
    $('#sun-set').textContent = kstHM(times.sunset);
    const ra = sunAzimuth(times.sunrise, spot.lat, spot.lon), sa = sunAzimuth(times.sunset, spot.lat, spot.lon);
    $('#sun-rise-dir').textContent = `${dirName(ra)} ${Math.round(ra)}°`;
    $('#sun-set-dir').textContent = `${dirName(sa)} ${Math.round(sa)}°`;

    const list = $('#point-list');
    const tpl = $('#tpl-point-item');
    list.innerHTML = '';
    spot.points.forEach((p, i) => {
      const li = tpl.content.firstElementChild.cloneNode(true);
      $('[data-field="name"]', li).textContent = p.name;
      $('[data-field="direction"]', li).textContent = directionText(p);
      const open = SEASONS.reduce((n, s) => n + LIGHTS.filter(l => !isClosed(spot, s, l.key)).length, 0);
      const filled = SEASONS.reduce((n, s) => n + LIGHTS.filter(l => photosFor(spot.id, i, s.key, l.key).length).length, 0);
      $('[data-field="filled"]', li).textContent = `${open}칸 중 ${filled}칸`;
      makeButton(li, `${p.name} 촬영 조건 보기`, () => go(`#/point/${spot.id}/${i}`));
      list.appendChild(li);
    });
  }
  function directionText(p) {
    const dir = p.dir == null ? '방향 미정' : `${dirName(p.dir)}쪽 ${Math.round(p.dir)}°`;
    return p.verified ? dir : `${dir} · 현장 확인 전`;
  }

  // ---------- 3. 촬영 지점 격자 ----------
  function renderPoint(spot, idx) {
    const p = spot.points[idx];
    $('#point-spot').textContent = spot.name;
    $('#point-title').textContent = p.name;
    $('#point-dir').textContent = directionText(p);

    const grid = $('#grid');
    const now = currentSeason();
    grid.innerHTML = '';
    SEASONS.forEach(season => {
      const label = document.createElement('div');
      label.className = 'season-label' + (season.key === now.key ? ' is-now' : '');
      label.textContent = season.name;
      if (season.key === now.key) label.title = '지금 계절';
      grid.appendChild(label);

      LIGHTS.forEach(light => {
        const name = `${season.name} ${light.name}`;
        const photos = photosFor(spot.id, idx, season.key, light.key);
        let cell;
        if (photos.length) {
          cell = $('#tpl-cell').content.firstElementChild.cloneNode(true);
          cell.classList.add('has-photo');
          const rep = photos.find(ph => ph.featured) || photos[photos.length - 1];
          const img = $('[data-field="photo"]', cell);
          img.src = rep.url; img.alt = `${name} 대표 사진`;
          $('[data-field="count"]', cell).textContent = `${photos.length}장`;
          makeButton(cell, `${name}, 사진 ${photos.length}장`, () => {}); // 사진 넘겨 보기는 2차
        } else if (isClosed(spot, season, light.key)) {
          cell = document.createElement('div');
          cell.className = 'cell closed';
          cell.innerHTML = '<div class="closed-inner">운영<br>시간 외</div>';
          cell.setAttribute('aria-label', `${name}: 운영시간 밖이라 촬영할 수 없어요`);
          cell.setAttribute('role', 'img');
        } else {
          cell = document.createElement('div');
          cell.className = 'cell empty';
          cell.innerHTML = '<div class="empty-inner"><div class="empty-plus">+</div><small>첫 사진<br>기다려요</small></div>';
          makeButton(cell, `${name}: 아직 사진이 없어요. 첫 사진 올리기`, () => {
            state.preset = { spotId: spot.id, pointIdx: idx, season, light };
            go('#/upload');
          });
        }
        grid.appendChild(cell);
      });
    });
  }

  // ---------- 4. 사진 올리기 (1주차: 분석까지만) ----------
  function renderUploadHeader() {
    const pre = state.preset;
    const spot = pre && SPOTS.find(s => s.id === pre.spotId);
    $('#upload-title').innerHTML = spot
      ? `${escapeHtml(pre.season.name)} ${escapeHtml(pre.light.name)},<br>아직 아무도 찍지 않았어요.`
      : '아직 아무도<br>찍지 않은 자리예요.';
    $('#upload-sub').innerHTML = spot
      ? `${escapeHtml(spot.name)} · ${escapeHtml(spot.points[pre.pointIdx].name)}<br>당신의 사진이 이 조건의 첫 번째 기록이 될 수 있어요.`
      : '당신의 사진이 이 조건의<br>첫 번째 기록이 될 수 있어요.';
  }

  async function analyze(file) {
    const box = $('#upload-result');
    box.classList.remove('is-ok', 'is-warn');
    box.textContent = '사진 정보를 읽는 중이에요…';
    const r = { gps: null, date: null, hasExif: false };
    let url = '';
    try { url = URL.createObjectURL(file); } catch (e) { /* 미리보기 없이 진행 */ }
    try {
      const x = await exifr.parse(file, { tiff: true, exif: true, gps: true, xmp: false, icc: false, iptc: false });
      if (x) {
        r.hasExif = Object.keys(x).length > 0;
        if (typeof x.latitude === 'number' && typeof x.longitude === 'number' && !(x.latitude === 0 && x.longitude === 0)) r.gps = { lat: x.latitude, lon: x.longitude };
        const dt = x.DateTimeOriginal || x.CreateDate;
        if (dt instanceof Date && !isNaN(dt)) r.date = dt; // 촬영한 휴대폰 시각(한국 시각으로 가정)
      }
    } catch (e) { /* 정보 없음 */ }

    let title, lines = [], ok = false;
    if (r.gps) {
      const nearest = SPOTS.map(s => ({ s, d: distanceM(r.gps, s) })).sort((a, b) => a.d - b.d)[0];
      if (nearest.d <= NEAR_LIMIT_M) {
        ok = true;
        const where = `${nearest.s.name} · ${nearest.s.points[0].name}`;
        if (r.date) {
          const cell = classify(r.date, nearest.s);
          title = cell.light ? `${where} · ${cell.season.name} ${cell.light} 칸에 들어가요` : `${where} · ${cell.season.name} 사진이에요`;
          lines.push(cell.detail);
          const pre = state.preset;
          if (pre && (pre.spotId !== nearest.s.id || pre.season.key !== cell.season.key || (cell.light && pre.light.name !== cell.light && pre.light.key !== 'rain'))) {
            const preSpot = SPOTS.find(x => x.id === pre.spotId);
            lines.push(`고른 칸(${preSpot.name} ${pre.season.name} ${pre.light.name})과 달라요. 사진 정보에 맞는 칸으로 들어가요.`);
          }
        } else {
          title = `${where} 근처 사진이에요`;
          lines.push('촬영시각이 없어 계절과 빛은 직접 골라야 해요.');
        }
      } else {
        title = `등록된 명소에서 ${fmtDist(nearest.d)} 떨어진 사진이에요`;
        lines.push(`가장 가까운 곳은 ${nearest.s.name}이에요. 명소 ${NEAR_LIMIT_M}m 안에서 찍은 사진만 올릴 수 있어요.`);
      }
    } else {
      title = '사진에 위치 정보가 없어요';
      lines.push(r.hasExif
        ? (isIOS() ? '아이폰은 웹에서 사진을 고를 때 위치를 빼고 보내요. 사진 선택 화면의 옵션에서 위치 포함을 켜 보세요.'
                   : '카메라의 위치 태그가 꺼져 있었거나 휴대폰이 위치를 뺐을 수 있어요.')
        : '메신저로 받았거나 캡처한 사진은 위치 정보가 없어요.');
      lines.push('위치 없는 사진은 2차부터 지도에서 직접 고른 뒤 검토 대기로 올라가요.');
    }

    box.classList.add(ok ? 'is-ok' : 'is-warn');
    box.innerHTML = `<div class="result-preview">
      ${url ? `<img class="result-thumb" src="${url}" alt="">` : ''}
      <div><strong>${escapeHtml(title)}</strong>${lines.map(l => `<span>${escapeHtml(l)}</span>`).join('')}</div></div>`;
  }

  function classify(date, spot) {
    // 휴대폰 사진의 촬영시각은 시간대 없이 저장돼 있어 한국 시각으로 읽힘
    const m = date.getMonth() + 1;
    const season = seasonOfMonth(m);
    const t = SunCalc.getTimes(date, spot.lat, spot.lon);
    const H = 3600e3;
    const detail = `그날 일출 ${kstHM(t.sunrise)} · 일몰 ${kstHM(t.sunset)} · 촬영 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (Math.abs(date - t.sunrise) <= H) return { season, light: '일출', detail };
    if (Math.abs(date - t.sunset) <= H) return { season, light: '일몰', detail };
    if (date > t.sunrise && date < t.sunset) return { season, light: '맑음', detail: `${detail} · 비가 왔다면 올릴 때 '비'를 골라 주세요` };
    return { season, light: null, detail: `${detail} · 밤 사진은 아직 칸이 없어요` };
  }

  // ---------- 계절 색 ----------
  function applySeason() {
    const s = currentSeason();
    const year = kstNow().getUTCFullYear();
    document.documentElement.dataset.season = s.key;
    $('#season-eyebrow').textContent = `CHEONGJU PHOTO GUIDE · ${s.key.toUpperCase()} ${year}`;
  }

  // ---------- 도우미 ----------
  function makeButton(el, label, onClick) {
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', label);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }

  // ---------- 연결 ----------
  document.documentElement.classList.add('js');
  applySeason();

  $('#back-to-map').addEventListener('click', () => go('#/'));
  ['#back-to-spot', '#back-to-spot-bottom'].forEach(id => $(id).addEventListener('click', () => go(`#/spot/${state.spotId}`)));
  ['#cancel-upload', '#cancel-upload-bottom'].forEach(id => $(id).addEventListener('click', () => {
    state.preset ? go(`#/point/${state.preset.spotId}/${state.preset.pointIdx}`) : go('#/');
  }));
  $('#open-upload').addEventListener('click', () => {
    state.preset = null;
    go('#/upload');
  });
  $('#locate').addEventListener('click', () => locate(false));
  ['#pick-gallery', '#pick-camera'].forEach(id => {
    const input = $(id);
    input.addEventListener('change', () => { if (input.files[0]) analyze(input.files[0]); input.value = ''; });
  });
  document.querySelectorAll('.upload-source label').forEach(l => l.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#' + l.htmlFor).click(); }
  }));
  $('#submit-upload').addEventListener('click', () => {
    const box = $('#upload-result');
    box.classList.remove('is-ok');
    box.classList.add('is-warn');
    box.textContent = $('#consent').checked
      ? '사진 저장은 2차 점검에서 연결돼요. 지금은 사진 분석 결과만 확인할 수 있어요.'
      : '사진 속 사람에 대한 동의에 먼저 체크해 주세요.';
  });

  window.addEventListener('hashchange', route);
  route();

  // 이미 위치를 허용한 사람은 바로 내 위치 기준으로 정렬
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then(p => { if (p.state === 'granted') locate(true); }).catch(() => {});
  }
})();
