window.WRB = window.WRB || {};
window.WRB.imageUtils = (() => {
  const GIF_JS_URL = 'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js';
  const GIF_WORKER_URL = 'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js';
  const OMGGIF_URL = 'https://cdn.jsdelivr.net/npm/omggif@1.0.10/omggif.js';

  let gifWorkerBlobUrl = null;
  const libsLoaded = { gifEncoder: false, gifDecoder: false };

  const uid = () => Math.random().toString(36).slice(2, 9);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if ([...document.scripts].some(s => s.src === src)) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureGifDecoder() {
    if (libsLoaded.gifDecoder && window.GifReader) return;
    await loadScript(OMGGIF_URL);
    if (typeof window.GifReader !== 'function') {
      throw new Error('omggif (GifReader) 로드 실패');
    }
    libsLoaded.gifDecoder = true;
  }

  async function ensureGifEncoder() {
    if (libsLoaded.gifEncoder && window.GIF && gifWorkerBlobUrl) return;
    await loadScript(GIF_JS_URL);
    if (!window.GIF) throw new Error('gif.js 로드 실패');
    if (!gifWorkerBlobUrl) {
      const res = await fetch(GIF_WORKER_URL);
      if (!res.ok) throw new Error('gif.worker.js 로드 실패');
      const text = await res.text();
      const blob = new Blob([text], { type: 'application/javascript' });
      gifWorkerBlobUrl = URL.createObjectURL(blob);
    }
    libsLoaded.gifEncoder = true;
  }

  function getGifWorkerBlobUrl() { return gifWorkerBlobUrl; }
  function getLibsLoaded() { return libsLoaded; }

  function isImageFile(file) {
    if (file.type && file.type.startsWith('image/')) return true;
    const name = (file.name || '').toLowerCase();
    return /\.(png|jpe?g|gif|webp|bmp|avif)$/.test(name);
  }

  async function isGifFile(file) {
    if (file.type === 'image/gif') return true;
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.gif')) return true;
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      return head.length >= 4 &&
        head[0] === 0x47 && head[1] === 0x49 &&
        head[2] === 0x46 && head[3] === 0x38;
    } catch (e) { return false; }
  }

  function loadStaticImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => resolve({
          id: uid(), kind: 'static', src: e.target.result,
          img, w: img.naturalWidth, h: img.naturalHeight
        });
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function decodeGifFile(file) {
    await ensureGifDecoder();
    const buf = new Uint8Array(await file.arrayBuffer());
    const reader = new window.GifReader(buf);
    const w = reader.width;
    const h = reader.height;
    const n = reader.numFrames();

    // omggif blits frame-bounding-box pixels into a full-canvas RGBA buffer;
    // the caller is responsible for disposal between frames.
    const fullPixels = new Uint8ClampedArray(w * h * 4);
    const composed = [];
    let savedPixels = null;

    for (let i = 0; i < n; i++) {
      const info = reader.frameInfo(i);
      if (info.disposal === 3) savedPixels = new Uint8ClampedArray(fullPixels);

      reader.decodeAndBlitFrameRGBA(i, fullPixels);

      const frameCanvas = document.createElement('canvas');
      frameCanvas.width = w;
      frameCanvas.height = h;
      const imageData = new ImageData(new Uint8ClampedArray(fullPixels), w, h);
      frameCanvas.getContext('2d').putImageData(imageData, 0, 0);
      composed.push({
        canvas: frameCanvas,
        delay: Math.max(20, (info.delay || 10) * 10),
      });

      if (info.disposal === 2) {
        for (let y = info.y; y < info.y + info.height; y++) {
          const rowStart = y * w * 4;
          for (let x = info.x; x < info.x + info.width; x++) {
            fullPixels[rowStart + x * 4 + 3] = 0;
          }
        }
      } else if (info.disposal === 3 && savedPixels) {
        fullPixels.set(savedPixels);
      }
    }

    const duration = composed.reduce((s, fr) => s + fr.delay, 0);
    const src = await new Promise(resolve => {
      const r = new FileReader();
      r.onload = e => resolve(e.target.result);
      r.readAsDataURL(file);
    });
    return { id: uid(), kind: 'gif', src, gifFrames: composed, gifDuration: duration, w, h };
  }

  function detectDarkBackground(sourceCanvas, opts) {
    const luminanceThreshold = opts?.luminanceThreshold ?? 30;
    const edgeRatioThreshold = opts?.edgeRatioThreshold ?? 0.7;
    const oppositeEdgeRatioThreshold = opts?.oppositeEdgeRatioThreshold ?? 0.85;
    const stripPx = opts?.sampleStripPx ?? 4;
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    if (sw < 8 || sh < 8) return false;

    // Downscale for fast sampling
    const SAMPLE_MAX = 240;
    const scale = Math.min(1, SAMPLE_MAX / Math.max(sw, sh));
    const w = Math.max(16, Math.round(sw * scale));
    const h = Math.max(16, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0, w, h);

    const strip = Math.max(2, Math.min(stripPx, Math.floor(Math.min(w, h) / 6)));
    const scanBand = (x, y, bw, bh) => {
      if (bw <= 0 || bh <= 0) return { dark: 0, total: 0 };
      const data = ctx.getImageData(x, y, bw, bh).data;
      let dark = 0, total = 0;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 128) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum < luminanceThreshold) dark++;
        total++;
      }
      return { dark, total };
    };

    const top = scanBand(0, 0, w, strip);
    const bottom = scanBand(0, h - strip, w, strip);
    const left = scanBand(0, strip, strip, h - 2 * strip);
    const right = scanBand(w - strip, strip, strip, h - 2 * strip);

    const totalCount = top.total + bottom.total + left.total + right.total;
    if (totalCount === 0) return false;

    // (1) 전면 다크 가장자리
    const overallRatio = (top.dark + bottom.dark + left.dark + right.dark) / totalCount;
    if (overallRatio > edgeRatioThreshold) return true;

    // (2) 레터박스(top+bottom) / 필러박스(left+right) — 마주보는 한 쌍이 모두 짙은 경우
    const ratio = (b) => (b.total > 0 ? b.dark / b.total : 0);
    const topR = ratio(top), botR = ratio(bottom);
    const leftR = ratio(left), rightR = ratio(right);
    if (topR > oppositeEdgeRatioThreshold && botR > oppositeEdgeRatioThreshold) return true;
    if (leftR > oppositeEdgeRatioThreshold && rightR > oppositeEdgeRatioThreshold) return true;

    return false;
  }

  function detectDarkOnStatic(img, w, h) {
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').drawImage(img, 0, 0);
    const cfg = window.WRB.config?.flowBoard?.darkDetection;
    return detectDarkBackground(tmp, cfg);
  }
  function detectDarkOnCanvas(canvas) {
    const cfg = window.WRB.config?.flowBoard?.darkDetection;
    return detectDarkBackground(canvas, cfg);
  }

  async function loadImageFile(file) {
    if (!isImageFile(file)) return null;
    if (await isGifFile(file)) {
      try {
        const gif = await decodeGifFile(file);
        gif.isDark = gif.gifFrames.length > 0 ? detectDarkOnCanvas(gif.gifFrames[0].canvas) : false;
        return gif;
      } catch (err) {
        console.warn('GIF 디코딩 실패, 단일 프레임 GIF로 처리:', err);
        const stat = await loadStaticImage(file);
        const fc = document.createElement('canvas');
        fc.width = stat.w; fc.height = stat.h;
        fc.getContext('2d').drawImage(stat.img, 0, 0);
        return {
          id: stat.id, kind: 'gif', src: stat.src,
          gifFrames: [{ canvas: fc, delay: 100 }],
          gifDuration: 100,
          w: stat.w, h: stat.h,
          isDark: detectDarkOnCanvas(fc),
        };
      }
    }
    const stat = await loadStaticImage(file);
    stat.isDark = detectDarkOnStatic(stat.img, stat.w, stat.h);
    return stat;
  }

  return {
    uid,
    isImageFile,
    isGifFile,
    loadStaticImage,
    decodeGifFile,
    loadImageFile,
    ensureGifDecoder,
    ensureGifEncoder,
    getGifWorkerBlobUrl,
    getLibsLoaded,
  };
})();
