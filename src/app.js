(() => {
  const WRB = window.WRB;
  const { imageUtils, renderer } = WRB;
  const { uid, isImageFile, loadImageFile, ensureGifDecoder, ensureGifEncoder, getLibsLoaded } = imageUtils;

  // ============================================================
  // Defaults (used only when config/board-rules.json fails to fetch,
  // e.g. when index.html is opened via file:// in browsers that block
  // local file fetches). Keep these in sync with config/board-rules.json.
  // ============================================================
  const FALLBACK_CONFIG = {
    canvas: { width: 950, background: '#000000', padding: 25 },
    spacing: { imageGap: 20, sectionGap: 50 },
    image: {
      maxWidth: 300,
      maxRowHeight: 420,
      minRowFillRatio: 0.85,
      classification: { mobilePortraitMaxAspect: 0.65, wideBannerMinAspect: 2.5 },
      smallImageSet: { maxWidthMin: 280, maxWidthMax: 300 },
    },
    flowBoard: {
      background: '#323232',
      padding: 25,
      autoWrapOnDarkImage: true,
      darkDetection: { luminanceThreshold: 30, edgeRatioThreshold: 0.7, sampleStripPx: 4 },
    },
    sectionTitle: {
      color: '#9B9B9B', fontSize: 22, fontWeight: 600,
      fontFamily: '-apple-system, "SF Pro", "Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
      lineHeight: 32, bottomGap: 18,
    },
    gif: { fps: 15, quality: 10, maxDurationMs: 8000 },
  };

  // ============================================================
  // Changelog (newest first)
  // ============================================================
  const CHANGELOG = [
    { date: '26.05.14', version: '1.0.1', items: [
      '화면 캡쳐 + Cmd+V / Ctrl+V 시 썸네일 자동 추가 기능',
      'KST 기준 매주 월요일 14:00을 주차 경계로 자동 갱신',
      'GIF 생성 시 업로드 GIF의 원본 길이 그대로 유지 (8초 캡 제거)',
    ]},
    { date: '26.05.13', version: '1.0', items: [
      '첫 배포',
    ]},
  ];

  // ============================================================
  // State
  // ============================================================
  let sections = [];
  let dragSrc = null;
  let lastResults = [];
  let activeSectionId = null; // last interacted-with section — paste target

  const pad2 = n => String(n).padStart(2, '0');

  // ============================================================
  // Config loading
  // ============================================================
  async function loadConfig() {
    try {
      const res = await fetch('config/board-rules.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      WRB.config = json;
      return { ok: true, source: 'json' };
    } catch (err) {
      WRB.config = FALLBACK_CONFIG;
      return { ok: false, source: 'fallback', error: err };
    }
  }

  // ============================================================
  // Week — KST-based, boundary is Monday 14:00 KST
  // ============================================================
  function getISOWeek(date) {
    // Standard ISO week (Monday-based) — kept for callers that pass a Date directly
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return { year: d.getUTCFullYear(), week: weekNo };
  }

  function getCurrentWeek() {
    // Week boundary: Monday 14:00 KST (KST = UTC+9).
    // Subtracting 14 hours from KST clock time makes the boundary align with
    // Monday 00:00, which is the standard ISO week boundary.
    // KST clock - 14h ≡ UTC - 5h, so we read date components in UTC after the shift.
    const shifted = new Date(Date.now() - 5 * 3600 * 1000);
    const y = shifted.getUTCFullYear();
    const m = shifted.getUTCMonth();
    const day = shifted.getUTCDate();
    const d = new Date(Date.UTC(y, m, day));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return { year: d.getUTCFullYear(), week: weekNo };
  }

  function setupMetaCombo(field, options, currentValue) {
    const combo = document.querySelector(`.meta-combo[data-field="${field}"]`);
    if (!combo) return;
    const input = combo.querySelector('.meta-combo-input');
    const toggle = combo.querySelector('.meta-combo-toggle');
    const menu = combo.querySelector('.meta-combo-menu');

    menu.innerHTML = '';
    options.forEach(v => {
      const el = document.createElement('div');
      el.className = 'meta-combo-option';
      el.textContent = String(v);
      el.dataset.value = String(v);
      el.setAttribute('role', 'option');
      if (String(v) === String(currentValue)) el.classList.add('selected');
      el.addEventListener('click', () => {
        input.value = String(v);
        syncSelected();
        closeMenu();
        input.focus();
      });
      menu.appendChild(el);
    });

    input.value = String(currentValue);

    function syncSelected() {
      menu.querySelectorAll('.meta-combo-option').forEach(o => {
        o.classList.toggle('selected', o.dataset.value === input.value);
      });
    }
    function openMenu() {
      document.querySelectorAll('.meta-combo.open').forEach(c => {
        if (c !== combo) c.classList.remove('open');
      });
      combo.classList.add('open');
      const sel = menu.querySelector('.selected');
      if (sel) sel.scrollIntoView({ block: 'center' });
    }
    function closeMenu() { combo.classList.remove('open'); }

    toggle.addEventListener('click', e => {
      e.stopPropagation();
      if (combo.classList.contains('open')) closeMenu();
      else openMenu();
    });
    input.addEventListener('input', syncSelected);
    input.addEventListener('focus', closeMenu);
  }

  function setupMetaCombos(iso) {
    const years = [];
    for (let y = iso.year - 5; y <= iso.year + 5; y++) years.push(y);
    setupMetaCombo('year', years, iso.year);
    const weeks = [];
    for (let w = 1; w <= 53; w++) weeks.push(w);
    setupMetaCombo('week', weeks, iso.week);
  }

  document.addEventListener('click', e => {
    if (!e.target.closest('.meta-combo')) {
      document.querySelectorAll('.meta-combo.open').forEach(c => c.classList.remove('open'));
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.meta-combo.open').forEach(c => c.classList.remove('open'));
    }
  });

  // ============================================================
  // Section / image CRUD
  // ============================================================
  function addSection(title = '') {
    sections.push({ id: uid(), title, images: [] });
    render();
  }
  function removeSection(id) {
    sections = sections.filter(s => s.id !== id);
    render();
  }
  function moveSection(id, dir) {
    const i = sections.findIndex(s => s.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    [sections[i], sections[j]] = [sections[j], sections[i]];
    render();
  }
  function updateSectionTitle(id, title) {
    const s = sections.find(x => x.id === id);
    if (s) s.title = title;
  }
  function removeImage(sectionId, imageId) {
    const s = sections.find(x => x.id === sectionId);
    if (!s) return;
    s.images = s.images.filter(im => im.id !== imageId);
    render();
  }

  async function addFilesToSection(sectionId, fileList) {
    const s = sections.find(x => x.id === sectionId);
    if (!s) return;
    const files = Array.from(fileList).filter(isImageFile);
    if (files.length === 0) return;
    const placeholders = files.map(() => ({ id: uid(), kind: 'loading', loading: true }));
    s.images.push(...placeholders);
    render();
    for (let i = 0; i < files.length; i++) {
      try {
        const im = await loadImageFile(files[i]);
        if (im) {
          const idx = s.images.findIndex(x => x.id === placeholders[i].id);
          if (idx >= 0) s.images[idx] = im;
        } else {
          s.images = s.images.filter(x => x.id !== placeholders[i].id);
        }
      } catch (e) {
        s.images = s.images.filter(x => x.id !== placeholders[i].id);
        console.error(e);
      }
      render();
    }
  }

  // ============================================================
  // Rendering — sections (left column)
  // ============================================================
  const sectionsEl = document.getElementById('sections');
  function render() {
    sectionsEl.innerHTML = '';
    sections.forEach((s, idx) => sectionsEl.appendChild(renderSection(s, idx)));
    const btn = document.getElementById('generateBtn');
    if (btn) btn.disabled = !hasAnyImages();
  }

  const ICON = {
    up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`,
    down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
    upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  };

  function renderSection(s, idx) {
    const el = document.createElement('div');
    el.className = 'section';
    el.dataset.id = s.id;
    const realCount = s.images.filter(i => !i.loading).length;
    const loadingCount = s.images.length - realCount;

    const head = document.createElement('div');
    head.className = 'section-head';
    head.innerHTML = `
      <div class="section-title-group">
        <div class="section-number">${pad2(idx + 1)}</div>
        <input class="title" type="text" placeholder="업무명 입력" />
      </div>
      <div class="section-actions-head">
        <button class="btn icon" data-act="up" title="위로">${ICON.up}</button>
        <div class="action-divider"></div>
        <button class="btn icon" data-act="down" title="아래로">${ICON.down}</button>
        <div class="action-divider"></div>
        <button class="btn icon danger" data-act="remove-section" title="섹션 삭제">${ICON.trash}</button>
      </div>
    `;
    const titleInput = head.querySelector('input.title');
    titleInput.value = s.title;
    titleInput.addEventListener('input', e => updateSectionTitle(s.id, e.target.value));
    // Track which section was last interacted with — used as paste target
    el.addEventListener('mousedown', () => { activeSectionId = s.id; }, true);
    el.addEventListener('focusin', () => { activeSectionId = s.id; });
    head.querySelector('[data-act="up"]').addEventListener('click', () => moveSection(s.id, -1));
    head.querySelector('[data-act="down"]').addEventListener('click', () => moveSection(s.id, +1));
    head.querySelector('[data-act="remove-section"]').addEventListener('click', () => {
      if (confirm('이 섹션을 삭제할까요?')) removeSection(s.id);
    });
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'section-body';

    const dz = document.createElement('label');
    dz.className = 'dropzone';
    dz.innerHTML = `
      <div class="dz-icon">${ICON.upload}</div>
      <div class="dz-main">이미지를 드래그하거나 클릭해서 업로드</div>
      <div class="dz-hint">PNG · JPG · GIF · 여러 개 한 번에 가능</div>
      <input type="file" accept="image/*" multiple />
    `;
    const fileInput = dz.querySelector('input[type="file"]');
    fileInput.addEventListener('change', e => {
      addFilesToSection(s.id, e.target.files);
      e.target.value = '';
    });
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      dz.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return;
      dz.classList.remove('drag');
    }));
    dz.addEventListener('drop', e => {
      const files = e.dataTransfer?.files;
      if (files && files.length) addFilesToSection(s.id, files);
    });
    body.appendChild(dz);

    const thumbs = document.createElement('div');
    thumbs.className = 'thumbs';
    s.images.forEach(im => thumbs.appendChild(renderThumb(s, im)));
    if (s.images.length > 0) {
      body.appendChild(thumbs);
      const footer = document.createElement('div');
      footer.className = 'thumbs-footer';
      footer.textContent = `${realCount}장${loadingCount ? ` · 로딩 ${loadingCount}` : ''}`;
      body.appendChild(footer);
    }

    el.appendChild(body);
    return el;
  }

  function renderThumb(s, im) {
    const t = document.createElement('div');
    t.className = 'thumb' + (im.loading ? ' loading' : '');
    t.dataset.id = im.id;
    if (im.loading) {
      t.innerHTML = `<div class="spinner">로딩…</div>`;
      return t;
    }
    t.draggable = true;
    const badge = im.kind === 'gif' ? `<span class="badge">GIF</span>` : '';
    t.innerHTML = `
      <img src="${im.src}" alt="" />
      ${badge}
      <button class="remove" title="삭제">×</button>
      <div class="meta">${im.w}×${im.h}${im.kind === 'gif' ? ` · ${im.gifFrames.length}f` : ''}</div>
    `;
    t.querySelector('.remove').addEventListener('click', e => {
      e.stopPropagation();
      removeImage(s.id, im.id);
    });
    t.addEventListener('dragstart', e => {
      dragSrc = { sectionId: s.id, imageId: im.id };
      t.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', im.id); } catch (_) {}
    });
    t.addEventListener('dragend', () => {
      t.classList.remove('dragging');
      dragSrc = null;
    });
    t.addEventListener('dragover', e => {
      if (!dragSrc || dragSrc.sectionId !== s.id) return;
      e.preventDefault();
    });
    t.addEventListener('drop', e => {
      if (!dragSrc || dragSrc.sectionId !== s.id) return;
      e.preventDefault();
      const arr = s.images;
      const from = arr.findIndex(x => x.id === dragSrc.imageId);
      const to = arr.findIndex(x => x.id === im.id);
      if (from < 0 || to < 0 || from === to) return;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      render();
    });
    return t;
  }

  // ============================================================
  // Status / progress / filename utils
  // ============================================================
  function setStatus(text, level) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.classList.toggle('error', level === 'error');
    el.classList.toggle('warn', level === 'warn');
  }
  function setProgress(p) {
    const wrap = document.getElementById('progressWrap');
    const fill = document.getElementById('progressBar');
    if (p == null) { wrap.classList.remove('show'); fill.style.width = '0%'; return; }
    wrap.classList.add('show');
    fill.style.width = Math.max(0, Math.min(100, p * 100)) + '%';
  }

  function slugify(s) {
    return (s || '').trim()
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .slice(0, 80);
  }
  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }
  function buildFilename(result) {
    const year = document.getElementById('year').value || new Date().getFullYear();
    const week = document.getElementById('week').value || '1';
    const ext = result.kind === 'gif' ? 'gif' : 'png';
    const titlePart = result.slug ? `_${result.slug}` : '';
    return `주간보고_${year}.${week}주차${titlePart}.${ext}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ============================================================
  // Generate
  // ============================================================
  const hasAnyImages = () => sections.some(s => s.images.some(i => !i.loading));
  const hasAnyLoading = () => sections.some(s => s.images.some(i => i.loading));
  function sectionHasContent(s) { return s.images.some(i => !i.loading); }

  function clearResults() {
    lastResults.forEach(r => { if (r.previewUrl) URL.revokeObjectURL(r.previewUrl); });
    lastResults = [];
    renderResults();
    document.getElementById('downloadAllBtn').disabled = true;
  }

  async function generateSection(section, indexInAll, onProgress) {
    const measure = renderer.measureSection(section);
    const totalH = renderer.sectionTotalHeight(measure);
    const title = section.title.trim();
    const slug = slugify(title || pad2(indexInAll + 1));
    const hasGif = renderer.sectionHasGif(section) && getLibsLoaded().gifEncoder;

    if (hasGif) {
      return await renderer.generateSectionGif(section, measure, totalH, title, slug, onProgress, setStatus);
    }
    return await renderer.generateSectionPng(section, measure, totalH, title, slug, setStatus);
  }

  async function generate() {
    if (sections.length === 0) { alert('업무 섹션을 1개 이상 추가해주세요.'); return; }
    if (hasAnyLoading()) { alert('이미지 로딩이 끝날 때까지 잠시 기다려주세요.'); return; }
    if (!hasAnyImages()) { alert('이미지를 1장 이상 업로드해주세요.'); return; }

    clearResults();
    const targets = sections.filter(sectionHasContent);
    const needGifEncoder = targets.some(renderer.sectionHasGif);
    if (needGifEncoder) {
      try {
        setStatus('GIF 라이브러리 로드 중...');
        await ensureGifEncoder();
      } catch (err) {
        console.error(err);
        setStatus('GIF 라이브러리 로드 실패. GIF 섹션은 첫 프레임으로 대체합니다.', 'error');
      }
    }

    setProgress(0);
    for (let i = 0; i < targets.length; i++) {
      const s = targets[i];
      const idxInAll = sections.indexOf(s);
      const baseProgress = i / targets.length;
      const slot = 1 / targets.length;
      try {
        const result = await generateSection(s, idxInAll, p => setProgress(baseProgress + slot * p));
        result.index = idxInAll;
        lastResults.push(result);
        renderResults();
      } catch (err) {
        console.error('섹션 생성 실패:', s.title, err);
        setStatus(`섹션 "${s.title || '(이름 없음)'}" 생성 실패: ${err.message}`, 'error');
      }
    }
    setProgress(1);

    document.getElementById('downloadAllBtn').disabled = lastResults.length === 0;
    const totalSize = lastResults.reduce((sum, r) => sum + r.blob.size, 0);
    setStatus(`완료 · ${lastResults.length}개 · 총 ${formatSize(totalSize)}`);
    setTimeout(() => setProgress(null), 2000);
  }

  // ============================================================
  // Render results (right column)
  // ============================================================
  const emptyStateHTML = `
    <div class="empty-state" id="emptyState">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="9" cy="9" r="2"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
      </div>
      <div class="empty-text">
        <strong>「이미지 만들기」</strong>를 누르면<br/>
        결과가 여기에 표시됩니다
      </div>
    </div>
  `;

  function renderResults() {
    const list = document.getElementById('resultsList');
    const wrap = document.querySelector('.preview-wrap');
    if (lastResults.length === 0) {
      list.innerHTML = emptyStateHTML;
      wrap.classList.remove('has-results');
      return;
    }
    list.innerHTML = '';
    lastResults.forEach(r => list.appendChild(renderResultCard(r)));
    wrap.classList.add('has-results');
  }

  function renderResultCard(r) {
    const card = document.createElement('div');
    card.className = 'result-card';
    const filename = buildFilename(r);
    const numberLabel = r.index != null ? pad2(r.index + 1) : '';
    card.innerHTML = `
      <div class="result-card-head">
        ${numberLabel ? `<div class="result-number">${numberLabel}</div>` : ''}
        <div class="result-info">
          <div class="result-title" title="${escapeHtml(filename)}">${escapeHtml(filename)}</div>
          <div class="result-meta">
            <span class="kind-tag ${r.kind}">${r.kind.toUpperCase()}</span>
            <span>${r.width} × ${r.height}px</span>
            <span>·</span>
            <span>${formatSize(r.blob.size)}</span>
            ${r.kind === 'gif' ? `<span>·</span><span>${r.frameCount}f · ${r.fps}fps</span>` : ''}
          </div>
        </div>
        <button class="btn" data-act="download">
          ${ICON.download}
          ${r.kind === 'gif' ? 'GIF' : 'PNG'} 다운로드
        </button>
      </div>
      <div class="result-preview-area" title="클릭하여 크게 보기">
        <img src="${r.previewUrl}" alt="" />
      </div>
    `;
    card.querySelector('.result-preview-area').addEventListener('click', () => openLightbox(r.previewUrl));
    card.querySelector('[data-act="download"]').addEventListener('click', () => downloadOne(r));
    return card;
  }

  // ============================================================
  // Lightbox
  // ============================================================
  const lb = document.getElementById('lightbox');
  const lbImg = document.getElementById('lightboxImg');
  const lbCard = document.getElementById('lightboxCard');
  const lbFrame = document.getElementById('lightboxFrame');
  const lbClose = document.getElementById('lightboxClose');
  function openLightbox(url) {
    lbImg.src = url;
    lb.classList.add('show');
    lbCard.scrollTop = 0;
  }
  function closeLightbox() {
    lb.classList.remove('show');
    lbImg.src = '';
  }
  lb.addEventListener('click', e => {
    if (!lbFrame.contains(e.target)) closeLightbox();
  });
  lbClose.addEventListener('click', e => {
    e.stopPropagation();
    closeLightbox();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && lb.classList.contains('show')) closeLightbox();
  });

  // ============================================================
  // Download
  // ============================================================
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadOne(r) {
    downloadBlob(r.blob, buildFilename(r));
  }
  async function downloadAll() {
    for (const r of lastResults) {
      downloadBlob(r.blob, buildFilename(r));
      await new Promise(res => setTimeout(res, 250));
    }
  }

  // ============================================================
  // Changelog popover
  // ============================================================
  function setupChangelogPopover() {
    const trigger = document.getElementById('versionTrigger');
    const label = document.getElementById('versionLabel');
    const popover = document.getElementById('versionPopover');
    const body = document.getElementById('versionPopoverBody');
    const closeBtn = document.getElementById('versionPopoverClose');
    if (!trigger || !popover) return;

    // Set latest version label
    if (CHANGELOG.length > 0) label.textContent = `v${CHANGELOG[0].version}`;

    // Render body
    body.innerHTML = CHANGELOG.map(entry => `
      <div class="version-entry">
        <div class="version-entry-head">
          <span class="version-entry-version">v${escapeHtml(entry.version)}</span>
          <span class="version-entry-date">${escapeHtml(entry.date)}</span>
        </div>
        <ul class="version-entry-items">
          ${entry.items.map(it => `<li>${escapeHtml(it)}</li>`).join('')}
        </ul>
      </div>
    `).join('');

    const open = () => {
      popover.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
    };
    const close = () => {
      popover.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };
    const toggle = () => popover.hidden ? open() : close();

    trigger.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    closeBtn.addEventListener('click', close);
    document.addEventListener('click', (e) => {
      if (popover.hidden) return;
      if (popover.contains(e.target) || trigger.contains(e.target)) return;
      close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !popover.hidden) close();
    });
  }

  // ============================================================
  // Bootstrap
  // ============================================================
  async function boot() {
    const configResult = await loadConfig();
    const c = WRB.config.canvas;
    document.getElementById('brandSub').textContent = `${c.width}px · PNG / GIF · created by 0heee`;

    if (!configResult.ok) {
      console.warn('board-rules.json 로드 실패, 내장 기본값을 사용합니다.', configResult.error);
      setStatus(
        'config/board-rules.json 을 불러오지 못해 기본값으로 동작합니다. (로컬 서버로 실행하면 JSON 편집이 반영됩니다)',
        'warn'
      );
    }

    const iso = getCurrentWeek();
    setupMetaCombos(iso);

    document.getElementById('addSection').addEventListener('click', () => addSection());
    document.getElementById('generateBtn').addEventListener('click', () => {
      generate().catch(err => {
        console.error(err);
        setStatus('생성 실패: ' + err.message, 'error');
        setProgress(null);
      });
    });
    document.getElementById('downloadAllBtn').addEventListener('click', downloadAll);

    // Changelog popover
    setupChangelogPopover();

    // Paste image from clipboard (Mac: Cmd+V / Windows: Ctrl+V)
    document.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return; // not an image — let default paste happen
      e.preventDefault();
      // Target: last interacted-with section → else last section → else new section
      let targetId = activeSectionId && sections.find(x => x.id === activeSectionId)?.id;
      if (!targetId && sections.length > 0) targetId = sections[sections.length - 1].id;
      if (!targetId) { addSection(); targetId = sections[sections.length - 1].id; }
      // Brief visual flash on the target section's dropzone
      const sectionEl = document.querySelector(`.section[data-id="${targetId}"]`);
      const dz = sectionEl?.querySelector('.dropzone');
      if (dz) {
        dz.classList.add('drag');
        setTimeout(() => dz.classList.remove('drag'), 350);
      }
      addFilesToSection(targetId, files);
    });

    addSection();
    renderResults();

    // Eagerly preload the GIF decoder so the very first GIF drop doesn't race
    // the network. Falls back gracefully inside loadImageFile() if it fails.
    ensureGifDecoder().catch(err => console.warn('omggif preload failed:', err));
  }

  boot();
})();
