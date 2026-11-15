// Cópia, compartilhamento, imagem (PNG multipágina) e PDF. Tudo local, sem serviços externos.
import { reportModel, reportHeader } from './report.js';

// ---------- Cópia / WhatsApp / download ----------

export async function copyText(value) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch { /* tenta o método alternativo */ }
  }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

const WA_URL_LIMIT = 6000; // acima disso, links wa.me podem ser truncados por alguns navegadores

// Retorna 'wa' (abriu wa.me), 'share' (abriu compartilhamento nativo), 'long' (texto longo: copiado) ou 'fail'
export async function shareWhatsApp(value) {
  const url = `https://wa.me/?text=${encodeURIComponent(value)}`;
  if (url.length > WA_URL_LIMIT) {
    if (navigator.share) {
      try { await navigator.share({ text: value }); return 'share'; } catch (e) { if (e?.name === 'AbortError') return 'share'; }
    }
    const copied = await copyText(value);
    return copied ? 'long' : 'fail';
  }
  const w = window.open(url, '_blank', 'noopener');
  if (!w) { location.href = url; }
  return 'wa';
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function shareFiles(files, title) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title }); return true; } catch (e) { if (e?.name === 'AbortError') return true; return false; }
  }
  return false;
}

// ---------- Imagem ----------

const W = 1080;
const H = 1528; // proporção A4 (também usada no PDF)
const M = 60;
const C = {
  bg: '#FFFFFF', card: '#F3F5F8', line: '#E3E7EC', text: '#14181F', muted: '#5D6877', red: '#C8102E', green: '#12945A',
  amber: '#D97706', amberSoft: '#FFF1D6', blue: '#2563EB', gray: '#98A2B0',
};
const FONT = '"Plus Jakarta Sans", -apple-system, "Segoe UI", Roboto, sans-serif';
const STATUS_COLOR = { done: C.green, progress: C.blue, review: C.blue, none: C.gray };

function wrapLines(ctx, textValue, maxW) {
  const out = [];
  for (const para of String(textValue).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const w of words) {
      // palavra maior que a linha: quebra por caractere
      if (ctx.measureText(w).width > maxW) {
        if (line) { out.push(line); line = ''; }
        let chunk = '';
        for (const ch of w) {
          if (ctx.measureText(chunk + ch).width > maxW) { out.push(chunk); chunk = ch; } else chunk += ch;
        }
        line = chunk;
        continue;
      }
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test;
    }
    out.push(line);
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderPages(shift) {
  try {
    await Promise.all([
      document.fonts.load(`400 28px "Plus Jakarta Sans"`),
      document.fonts.load(`600 28px "Plus Jakarta Sans"`),
      document.fonts.load(`700 28px "Plus Jakarta Sans"`),
    ]);
  } catch { /* usa fonte alternativa */ }

  const header = reportHeader(shift);
  const model = reportModel(shift);
  const pages = [];
  let canvas, ctx, y;

  const newPage = (first) => {
    canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    ctx = canvas.getContext('2d');
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    pages.push(canvas);
    ctx.textBaseline = 'alphabetic';
    if (first) {
      ctx.fillStyle = C.red; ctx.fillRect(0, 0, W * 0.5, 14);
      ctx.fillStyle = C.green; ctx.fillRect(W * 0.5, 0, W * 0.5, 14);
      ctx.fillStyle = C.red;
      ctx.font = `800 22px ${FONT}`;
      ctx.fillText('PLANTÃO ADM', M, 84);
      ctx.fillStyle = C.text;
      ctx.font = `700 44px ${FONT}`;
      const tl = wrapLines(ctx, header.title, W - 2 * M);
      let ty = 142;
      for (const l of tl) { ctx.fillText(l, M, ty); ty += 54; }
      ctx.font = `500 30px ${FONT}`;
      ctx.fillStyle = C.muted;
      const info = [['Data', header.date]];
      ty += -6;
      for (const [k, v] of info) {
        ctx.fillStyle = C.muted;
        ctx.font = `500 28px ${FONT}`;
        ctx.fillText(`${k}:`, M, ty + 36);
        ctx.fillStyle = C.text;
        ctx.font = `600 30px ${FONT}`;
        const vl = wrapLines(ctx, v, W - 2 * M - 150);
        for (const l of vl) { ctx.fillText(l, M + 150, ty + 36); ty += 42; }
      }
      y = ty + 30;
    } else {
      ctx.fillStyle = C.red; ctx.fillRect(0, 0, W, 8);
      ctx.fillStyle = C.muted;
      ctx.font = `500 22px ${FONT}`;
      ctx.fillText(`${header.title} · ${header.date}`, M, 72);
      y = 110;
    }
  };

  const FOOT = 70;
  const limit = () => H - FOOT;

  // medições de uma linha
  const measureRow = (r) => {
    const lx = M + 28 + (r.indent ? 36 : 0);
    const maxW = W - M - lx - 10;
    ctx.font = `500 26px ${FONT}`;
    const labelLines = wrapLines(ctx, r.label, maxW);
    ctx.font = `${r.kind === 'ni' ? '500' : '700'} 30px ${FONT}`;
    const valLines = wrapLines(ctx, r.text, maxW);
    return { lx, labelLines, valLines, h: labelLines.length * 34 + valLines.length * 40 + 24 };
  };

  newPage(true);

  for (const sec of model) {
    const headH = 76;
    const first = sec.rows.length ? measureRow(sec.rows[0]) : { h: 0 };
    if (y + headH + first.h > limit()) newPage(false);

    let segStart = y;
    const drawHead = (cont) => {
      segStart = y;
      ctx.fillStyle = C.card;
      roundRect(ctx, M, y, W - 2 * M, headH - 8, 14);
      ctx.fill();
      // indicador de preenchimento (círculo)
      const col = STATUS_COLOR[sec.status];
      ctx.beginPath();
      ctx.arc(M + 34, y + (headH - 8) / 2, 11, 0, Math.PI * 2);
      if (sec.status === 'done') { ctx.fillStyle = col; ctx.fill(); }
      else if (sec.status === 'progress') { ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.stroke(); ctx.beginPath(); ctx.arc(M + 34, y + (headH - 8) / 2, 4, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); }
      else { ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.stroke(); }
      ctx.fillStyle = C.text;
      ctx.font = `700 32px ${FONT}`;
      ctx.fillText(`${sec.index}. ${sec.title.toUpperCase()}${cont ? ' (cont.)' : ''}`, M + 64, y + 44);
      // tag de ocorrência
      if (sec.alerts.length && !cont) {
        const tag = 'OCORRÊNCIA';
        ctx.font = `700 20px ${FONT}`;
        const tw = ctx.measureText(tag).width + 28;
        const tx = W - M - tw - 16;
        ctx.fillStyle = C.amberSoft;
        roundRect(ctx, tx, y + 14, tw, 38, 19);
        ctx.fill();
        ctx.fillStyle = C.amber;
        ctx.fillText(tag, tx + 14, y + 40);
      }
      y += headH;
    };
    const closeSeg = () => {
      ctx.fillStyle = sec.alerts.length ? C.amber : STATUS_COLOR[sec.status];
      ctx.fillRect(M - 14, segStart + 4, 4, Math.max(8, y - segStart - 14));
    };
    drawHead(false);

    sec.rows.forEach((r, idx) => {
      const m = measureRow(r);
      if (y + m.h > limit()) {
        closeSeg();
        newPage(false);
        drawHead(true);
      }
      let ry = y + 8;
      ctx.fillStyle = C.muted;
      ctx.font = `500 26px ${FONT}`;
      if (r.indent) { ctx.fillStyle = C.gray; ctx.fillText('↳', M + 28, ry + 26); ctx.fillStyle = C.muted; }
      for (const l of m.labelLines) { ry += 34; ctx.fillText(l, m.lx, ry - 6); }
      let vc = C.text;
      if (r.kind === 'ni') vc = C.muted;
      else if (r.kind === 'na') vc = C.muted;
      ctx.fillStyle = vc;
      ctx.font = `${r.kind === 'ni' ? '500' : '700'} 30px ${FONT}`;
      for (const l of m.valLines) { ry += 40; ctx.fillText(l, m.lx, ry - 10); }
      y += m.h;
      if (idx < sec.rows.length - 1) {
        ctx.fillStyle = C.line;
        ctx.fillRect(m.lx, y - 2, W - M - m.lx, 1);
      }
    });
    closeSeg();
    y += 26;
  }

  // rodapé em todas as páginas
  pages.forEach((cv, i) => {
    const c = cv.getContext('2d');
    c.fillStyle = C.muted;
    c.font = `500 20px ${FONT}`;
    c.fillText('Plantão ADM', M, H - 30);
    const t = `Página ${i + 1}/${pages.length}`;
    c.fillText(t, W - M - c.measureText(t).width, H - 30);
  });
  return pages;
}

const toBlob = (cv, type, q) =>
  new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao gerar a imagem'))), type, q));

export async function buildPngs(shift) {
  const pages = await renderPages(shift);
  const blobs = [];
  for (const cv of pages) blobs.push(await toBlob(cv, 'image/png'));
  return blobs;
}

// ---------- PDF (páginas A4 com a imagem do relatório) ----------

export async function buildPdf(shift) {
  const pages = await renderPages(shift);
  const jpgs = [];
  for (const cv of pages) jpgs.push(new Uint8Array(await (await toBlob(cv, 'image/jpeg', 0.92)).arrayBuffer()));
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (d) => { const u = typeof d === 'string' ? enc.encode(d) : d; parts.push(u); size += u.length; };
  const beginObj = (n) => { offsets[n] = size; push(`${n} 0 obj\n`); };
  const n = jpgs.length;
  // objetos: 1 catálogo, 2 páginas, para cada página i: 3+i*3 (página), 4+i*3 (imagem), 5+i*3 (conteúdo)
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  beginObj(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const kids = jpgs.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  beginObj(2); push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
  jpgs.forEach((jpg, i) => {
    const p = 3 + i * 3, im = p + 1, ct = p + 2;
    beginObj(p);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>\nendobj\n`);
    beginObj(im);
    push(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    push(jpg);
    push('\nendstream\nendobj\n');
    const content = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
    beginObj(ct);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });
  const total = 3 + n * 3;
  const xref = size;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
