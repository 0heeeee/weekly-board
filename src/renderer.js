window.WRB = window.WRB || {};
window.WRB.renderer = (() => {
  function cfg() { return window.WRB.config; }

  function titleFont() {
    const t = cfg().sectionTitle;
    return `${t.fontWeight} ${t.fontSize}px ${t.fontFamily}`;
  }

  function innerWidth() {
    const c = cfg().canvas;
    return c.width - c.padding * 2;
  }

  function classifyImage(im) {
    const c = cfg().image.classification || {};
    const mobileMax = c.mobilePortraitMaxAspect ?? 0.65;
    const bannerMin = c.wideBannerMinAspect ?? 2.5;
    const aspect = im.w / im.h;
    if (aspect < mobileMax) return 'mobile';
    if (aspect > bannerMin) return 'banner';
    return 'standard';
  }

  function layoutImages(images, availableWidth) {
    const imageCfg = cfg().image;
    const maxWidth = imageCfg.maxWidth;
    const maxRowHeight = imageCfg.maxRowHeight ?? 420;
    const minRowFillRatio = imageCfg.minRowFillRatio ?? 0.85;
    const { imageGap } = cfg().spacing;

    // Step 1: classify + initial scale-down to maxWidth cap
    const scaled = images.filter(im => !im.loading).map(im => {
      const kind = classifyImage(im);
      const targetW = Math.min(maxWidth, im.w);
      const ratio = targetW / im.w;
      return {
        src: im,
        kind,
        naturalW: im.w,
        naturalH: im.h,
        aspect: im.w / im.h,
        w: Math.round(targetW),
        h: Math.round(im.h * ratio),
      };
    });

    // Step 2: greedy row packing
    // - banner items are forced to their own row
    const rows = [];
    let row = { items: [], width: 0, height: 0 };
    const flushRow = () => {
      if (row.items.length) rows.push(row);
      row = { items: [], width: 0, height: 0 };
    };
    for (const it of scaled) {
      if (it.kind === 'banner') {
        flushRow();
        row.items.push(it);
        row.width = it.w;
        row.height = it.h;
        flushRow();
        continue;
      }
      const addW = row.items.length === 0 ? it.w : row.width + imageGap + it.w;
      if (addW <= availableWidth || row.items.length === 0) {
        row.items.push(it);
        row.width = addW;
        row.height = Math.max(row.height, it.h);
      } else {
        flushRow();
        row.items.push(it);
        row.width = it.w;
        row.height = it.h;
      }
    }
    flushRow();

    // Step 3: justify per-row when conditions are met
    //   - All items are 'standard' or 'banner' (no 'mobile' — mobile screens never enlarge)
    //   - Row fill ratio < minRowFillRatio
    // Scaling: same height H for all items in row, H = (availW - gaps) / Σaspect
    // Capped by maxRowHeight AND by min(naturalH) of items (no upscaling beyond native).
    for (const r of rows) {
      const fillRatio = r.width / availableWidth;
      const allJustifiable = r.items.every(it => it.kind !== 'mobile');
      const isBannerOnlyRow = r.items.length === 1 && r.items[0].kind === 'banner';
      const shouldJustify = allJustifiable && (fillRatio < minRowFillRatio || isBannerOnlyRow);
      if (!shouldJustify) continue;

      const gaps = imageGap * (r.items.length - 1);
      const targetSum = availableWidth - gaps;
      const sumAspect = r.items.reduce((s, it) => s + it.aspect, 0);
      let H = targetSum / sumAspect;
      H = Math.min(H, maxRowHeight);
      const naturalCap = r.items.reduce((m, it) => Math.min(m, it.naturalH), Infinity);
      H = Math.min(H, naturalCap);

      // If after caps H is smaller than current row height, no benefit — keep original
      if (H <= r.height) continue;

      r.items.forEach(it => {
        it.w = Math.round(H * it.aspect);
        it.h = Math.round(H);
      });
      r.height = Math.round(H);
      r.width = r.items.reduce((s, it) => s + it.w, 0) + gaps;
    }

    // Step 4: compute x positions
    for (const r of rows) {
      let x = 0;
      r.items.forEach((it, i) => {
        it.x = i === 0 ? 0 : x;
        x = it.x + it.w + imageGap;
      });
    }

    let total = 0;
    rows.forEach((r, i) => { if (i > 0) total += imageGap; total += r.height; });
    return { rows, totalHeight: total };
  }

  function sectionNeedsGrayWrap(section) {
    const fb = cfg().flowBoard;
    if (!fb?.autoWrapOnDarkImage) return false;
    return section.images.some(im => im && !im.loading && im.isDark);
  }

  function measureSection(section) {
    const wrapped = sectionNeedsGrayWrap(section);
    const wrapPad = wrapped ? (cfg().flowBoard.padding || 0) : 0;
    const availW = innerWidth() - wrapPad * 2;
    const { totalHeight: contentH, rows } = layoutImages(section.images, availW);
    return { titleH: 0, contentH, rows, wrapped, wrapPad };
  }

  function getFrameForGif(image, timeMs) {
    const dur = image.gifDuration || 1;
    let t = timeMs % dur;
    let acc = 0;
    for (const fr of image.gifFrames) {
      acc += fr.delay;
      if (t < acc) return fr.canvas;
    }
    return image.gifFrames[image.gifFrames.length - 1].canvas;
  }

  function drawImageSource(ctx, src, x, y, w, h, timeMs) {
    if (src.kind === 'gif') {
      ctx.drawImage(getFrameForGif(src, timeMs), x, y, w, h);
    } else {
      ctx.drawImage(src.img, x, y, w, h);
    }
  }

  function drawSectionContent(ctx, x, y, rows, timeMs) {
    const { imageGap } = cfg().spacing;
    let cursorY = y;
    rows.forEach((r, ri) => {
      if (ri > 0) cursorY += imageGap;
      r.items.forEach(it => drawImageSource(ctx, it.src, x + it.x, cursorY, it.w, it.h, timeMs));
      cursorY += r.height;
    });
  }

  function drawSingleSection(ctx, section, totalH, m, timeMs) {
    const c = cfg().canvas;
    const fb = cfg().flowBoard;
    ctx.fillStyle = c.background;
    ctx.fillRect(0, 0, c.width, totalH);
    if (m.wrapped) {
      ctx.fillStyle = fb.background;
      const grayX = c.padding;
      const grayY = c.padding;
      const grayW = c.width - c.padding * 2;
      const grayH = totalH - c.padding * 2;
      ctx.fillRect(grayX, grayY, grayW, grayH);
      drawSectionContent(ctx, grayX + m.wrapPad, grayY + m.wrapPad, m.rows, timeMs);
    } else {
      drawSectionContent(ctx, c.padding, c.padding, m.rows, timeMs);
    }
  }

  function sectionHasGif(s) { return s.images.some(i => i.kind === 'gif'); }
  function sectionTotalHeight(measure) {
    const { padding } = cfg().canvas;
    const innerPad = measure.wrapped ? (measure.wrapPad || 0) : 0;
    return Math.max(padding * 2 + innerPad * 2 + measure.contentH, padding * 2 + 10);
  }

  // ============================================================
  // w900 Fill mode — single row, equal-height, fill available width.
  // Upscales beyond natural size (intentional per spec).
  // Used by the "w900 Fill 채우기" per-card toggle. Does NOT affect
  // the default generation pipeline.
  // ============================================================
  function layoutImagesFillW900(images, availableWidth) {
    const { imageGap } = cfg().spacing;
    const items = images.filter(im => !im.loading).map(im => ({
      src: im,
      naturalW: im.w,
      naturalH: im.h,
      aspect: im.w / im.h,
    }));
    if (items.length === 0) return { rows: [], totalHeight: 0 };

    const n = items.length;
    const gaps = imageGap * (n - 1);
    const targetSum = Math.max(1, availableWidth - gaps);
    const sumAspect = items.reduce((s, it) => s + it.aspect, 0) || 1;
    const H = targetSum / sumAspect;
    let x = 0;
    items.forEach((it, i) => {
      it.w = Math.round(H * it.aspect);
      it.h = Math.round(H);
      it.x = i === 0 ? 0 : x;
      x = it.x + it.w + imageGap;
    });
    // Snap last item to exactly fill availableWidth (rounding reconciliation)
    const last = items[items.length - 1];
    const targetRight = availableWidth;
    if (last.x + last.w !== targetRight) {
      last.w = Math.max(1, targetRight - last.x);
    }
    const rowH = Math.round(H);
    return { rows: [{ items, width: availableWidth, height: rowH }], totalHeight: rowH };
  }

  function measureSectionFill(section) {
    const wrapped = sectionNeedsGrayWrap(section);
    const wrapPad = wrapped ? (cfg().flowBoard.padding || 0) : 0;
    const availW = innerWidth() - wrapPad * 2;
    const { totalHeight: contentH, rows } = layoutImagesFillW900(section.images, availW);
    return { titleH: 0, contentH, rows, wrapped, wrapPad };
  }

  async function generateSectionPngFill(section, title, slug, setStatus) {
    setStatus?.(`PNG 생성 중 (w900 Fill) · ${title || slug}...`);
    const c = cfg().canvas;
    const measure = measureSectionFill(section);
    const totalH = sectionTotalHeight(measure);
    const canvas = document.createElement('canvas');
    canvas.width = c.width;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    drawSingleSection(ctx, section, totalH, measure, 0);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const previewUrl = URL.createObjectURL(blob);
    return {
      kind: 'png', blob, previewUrl,
      width: c.width, height: totalH,
      title, slug, sectionId: section.id,
    };
  }

  // Thin wrapper around generateSectionGif using the fill-mode measure.
  // Reuses the entire existing GIF encoding pipeline — no rule changes.
  async function generateSectionGifFill(section, title, slug, onProgress, setStatus) {
    const measure = measureSectionFill(section);
    const totalH = sectionTotalHeight(measure);
    return await generateSectionGif(section, measure, totalH, title, slug, onProgress, setStatus);
  }

  async function generateSectionPng(section, measure, totalH, title, slug, setStatus) {
    setStatus?.(`PNG 생성 중 · ${title || slug}...`);
    const c = cfg().canvas;
    const canvas = document.createElement('canvas');
    canvas.width = c.width;
    canvas.height = totalH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    drawSingleSection(ctx, section, totalH, measure, 0);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const previewUrl = URL.createObjectURL(blob);
    return {
      kind: 'png', blob, previewUrl,
      width: c.width, height: totalH,
      title, slug, sectionId: section.id,
    };
  }

  async function generateSectionGif(section, measure, totalH, title, slug, onProgress, setStatus) {
    const { fps, quality, maxDurationMs } = cfg().gif;
    const c = cfg().canvas;
    const interval = Math.round(1000 / fps);
    const gifs = section.images.filter(i => i.kind === 'gif');
    // Preserve the full duration of the longest uploaded GIF (no cap)
    const totalDuration = Math.max(...gifs.map(g => g.gifDuration));
    const frameCount = Math.max(1, Math.round(totalDuration / interval));

    setStatus?.(`GIF 생성 중 · ${title || slug} · 프레임 합성 (0/${frameCount})`);

    const gif = new window.GIF({
      workers: 2,
      workerScript: window.WRB.imageUtils.getGifWorkerBlobUrl(),
      width: c.width,
      height: totalH,
      quality,
      background: c.background,
      dither: false,
      repeat: 0,
    });
    const work = document.createElement('canvas');
    work.width = c.width;
    work.height = totalH;
    const wctx = work.getContext('2d');
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = 'high';

    for (let i = 0; i < frameCount; i++) {
      drawSingleSection(wctx, section, totalH, measure, i * interval);
      gif.addFrame(work, { delay: interval, copy: true });
      setStatus?.(`GIF 생성 중 · ${title || slug} · 프레임 합성 (${i + 1}/${frameCount})`);
      onProgress?.((i + 1) / frameCount * 0.4);
      await new Promise(r => setTimeout(r, 0));
    }

    setStatus?.(`GIF 생성 중 · ${title || slug} · 인코딩 중...`);
    const blob = await new Promise((resolve, reject) => {
      gif.on('progress', p => {
        onProgress?.(0.4 + p * 0.6);
        setStatus?.(`GIF 생성 중 · ${title || slug} · 인코딩 ${Math.round(p * 100)}%`);
      });
      gif.on('finished', b => resolve(b));
      gif.on('abort', () => reject(new Error('GIF 인코딩 중단')));
      try { gif.render(); } catch (e) { reject(e); }
    });

    const previewUrl = URL.createObjectURL(blob);
    return {
      kind: 'gif', blob, previewUrl,
      width: c.width, height: totalH,
      title, slug, sectionId: section.id,
      frameCount, fps,
    };
  }

  return {
    layoutImages,
    layoutImagesFillW900,
    measureSection,
    measureSectionFill,
    drawSingleSection,
    sectionHasGif,
    sectionTotalHeight,
    generateSectionPng,
    generateSectionPngFill,
    generateSectionGif,
    generateSectionGifFill,
  };
})();
