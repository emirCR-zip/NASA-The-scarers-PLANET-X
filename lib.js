"use strict";
/* SPHEREx Sky Timeline - funciones de datos (sin DOM, se pueden probar en Node).
   - Consulta ADQL a IRSA, lectura de CSV y de archivos FITS,
   - alineación (reproyección TAN) de cada recorte a una cuadrícula común,
   - estiramiento de brillo a escala de grises. */
const SkyLib = (() => {
  const D2R = Math.PI / 180;

  /* ---------- Coordenadas escritas por el usuario ---------- */
  function parseSexagesimal(s) {
    const neg = s.trim().startsWith("-");
    const p = s.trim().replace(/^[+-]/, "").split(/[:hdms°'"\s]+/i).filter(Boolean).map(Number);
    if (!p.length || p.some(Number.isNaN)) return NaN;
    const v = p[0] + (p[1] || 0) / 60 + (p[2] || 0) / 3600;
    return neg ? -v : v;
  }
  const hasSexa = s => /[:hms\s]/i.test(s.trim()) && /[:hms]/i.test(s.trim());
  function parseRA(s) {            // grados, o hh:mm:ss (horas)
    s = String(s).trim();
    if (!s) return NaN;
    return hasSexa(s) ? parseSexagesimal(s) * 15 : Number(s);
  }
  function parseDec(s) {           // grados, o ±dd:mm:ss
    s = String(s).trim();
    if (!s) return NaN;
    return hasSexa(s) ? parseSexagesimal(s) : Number(s);
  }

  /* ---------- Consulta a IRSA ---------- */
  function buildQuery(ra, dec, size) {
    return `SELECT TOP 12 'https://irsa.ipac.caltech.edu/' || a.uri || '?center=${ra},${dec}d&size=${size}' AS uri, ` +
      `p.time_bounds_lower, p.energy_bandpassname, p.provenance_version ` +
      `FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid ` +
      `WHERE 1 = CONTAINS(POINT('ICRS', ${ra}, ${dec}), p.poly) ORDER BY p.time_bounds_lower`;
  }

  function parseCSV(text) {
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function rowsToObjects(rows) {
    if (rows.length < 2) return [];
    const head = rows[0].map(h => h.trim());
    return rows.slice(1).map(r => Object.fromEntries(head.map((h, k) => [h, r[k]])));
  }

  const mjdToMs = mjd => (mjd - 40587) * 864e5;

  /* ---------- FITS ---------- */
  function parseHeaderValue(raw) {
    let v = raw.replace(/^\s+/, "");
    if (v.startsWith("'")) {
      let s = "", i = 1;
      while (i < v.length) {
        if (v[i] === "'") { if (v[i + 1] === "'") { s += "'"; i += 2; continue; } break; }
        s += v[i++];
      }
      return s.trim();
    }
    const k = v.indexOf("/");
    if (k >= 0) v = v.slice(0, k);
    v = v.trim();
    if (v === "T") return true;
    if (v === "F") return false;
    const n = Number(v.replace(/[dD]/, "e"));
    return v === "" || Number.isNaN(n) ? v : n;
  }

  function parseFits(buf, wantExt = "IMAGE") {
    const bytes = new Uint8Array(buf), td = new TextDecoder("latin1");
    let off = 0;
    while (off + 2880 <= bytes.length) {
      const hdr = {}; let pos = off, ended = false;
      while (!ended && pos + 2880 <= bytes.length) {
        for (let c = 0; c < 36; c++) {
          const s = pos + c * 80, card = td.decode(bytes.subarray(s, s + 80)), key = card.slice(0, 8).trim();
          if (key === "END") { ended = true; break; }
          if (key && card[8] === "=") hdr[key] = parseHeaderValue(card.slice(10));
        }
        pos += 2880;
      }
      if (!ended) throw new Error("Archivo FITS incompleto (cabecera)");
      const naxis = hdr.NAXIS || 0;
      let n = naxis > 0 ? 1 : 0;
      for (let i = 1; i <= naxis; i++) n *= hdr["NAXIS" + i];
      const nbytes = Math.abs(hdr.BITPIX || 8) / 8 * (hdr.GCOUNT || 1) * ((hdr.PCOUNT || 0) + n);
      if (hdr.EXTNAME === wantExt && naxis === 2) {
        const w = hdr.NAXIS1, h = hdr.NAXIS2, bp = hdr.BITPIX;
        if (pos + nbytes > bytes.length) throw new Error("Archivo FITS incompleto (datos)");
        const dv = new DataView(buf, pos), data = new Float32Array(w * h);
        const bs = hdr.BSCALE ?? 1, bz = hdr.BZERO ?? 0;
        for (let i = 0; i < w * h; i++) {
          let v;
          if (bp === -32) v = dv.getFloat32(i * 4, false);
          else if (bp === -64) v = dv.getFloat64(i * 8, false);
          else if (bp === 16) v = dv.getInt16(i * 2, false);
          else if (bp === 32) v = dv.getInt32(i * 4, false);
          else throw new Error("BITPIX no soportado: " + bp);
          data[i] = v * bs + bz;
        }
        return { hdr, w, h, data };
      }
      off = pos + Math.ceil(nbytes / 2880) * 2880;
    }
    throw new Error("No se encontró la extensión " + wantExt + " en el FITS");
  }

  /* ---------- WCS (proyección TAN) y alineación ---------- */
  function makeWCS(h) {
    if (h.CRPIX1 === undefined || h.CRVAL1 === undefined) return null;
    let cd;
    if (h.CD1_1 !== undefined) {
      cd = [[h.CD1_1, h.CD1_2 || 0], [h.CD2_1 || 0, h.CD2_2]];
    } else if (h.CDELT1 !== undefined) {
      const pc = [[h.PC1_1 ?? 1, h.PC1_2 ?? 0], [h.PC2_1 ?? 0, h.PC2_2 ?? 1]];
      cd = [[pc[0][0] * h.CDELT1, pc[0][1] * h.CDELT1], [pc[1][0] * h.CDELT2, pc[1][1] * h.CDELT2]];
    } else return null;
    const det = cd[0][0] * cd[1][1] - cd[0][1] * cd[1][0];
    if (!Number.isFinite(det) || det === 0) return null;
    const inv = [[cd[1][1] / det, -cd[0][1] / det], [-cd[1][0] / det, cd[0][0] / det]];
    return { crpix: [h.CRPIX1, h.CRPIX2], crval: [h.CRVAL1, h.CRVAL2], cd, inv };
  }

  function bilinear(data, w, h, u, v) {
    if (u < 0 || v < 0 || u > w - 1 || v > h - 1) return NaN;
    const x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const fx = u - x0, fy = v - y0;
    const a = data[y0 * w + x0], b = data[y0 * w + x1], c = data[y1 * w + x0], d = data[y1 * w + x1];
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d))
      return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    const near = data[Math.round(v) * w + Math.round(u)];
    return Number.isFinite(near) ? near : NaN;
  }

  // Cuadrícula común: N x N, norte arriba, este a la izquierda, centrada en (ra0, dec0).
  function reproject(img, wcs, N, ra0, dec0, scaleArcsec) {
    const out = new Float32Array(N * N).fill(NaN);
    const scale = scaleArcsec / 3600 * D2R, c = (N - 1) / 2;
    const a0 = ra0 * D2R, d0 = dec0 * D2R, sd0 = Math.sin(d0), cd0 = Math.cos(d0);
    const A = wcs.crval[0] * D2R, D = wcs.crval[1] * D2R, sD = Math.sin(D), cD = Math.cos(D);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const xi = -(i - c) * scale, eta = (c - j) * scale, rho = Math.hypot(xi, eta);
        let ra, dec;
        if (rho === 0) { ra = a0; dec = d0; }
        else {
          const cc = Math.atan(rho), sc = Math.sin(cc), co = Math.cos(cc);
          dec = Math.asin(co * sd0 + eta * sc * cd0 / rho);
          ra = a0 + Math.atan2(xi * sc, rho * cd0 * co - eta * sd0 * sc);
        }
        const dra = ra - A, sdec = Math.sin(dec), cdec = Math.cos(dec);
        const cosc = sD * sdec + cD * cdec * Math.cos(dra);
        if (cosc <= 0) continue;
        const x2 = cdec * Math.sin(dra) / cosc / D2R;
        const y2 = (cD * sdec - sD * cdec * Math.cos(dra)) / cosc / D2R;
        const u = wcs.inv[0][0] * x2 + wcs.inv[0][1] * y2 + wcs.crpix[0] - 1;
        const v = wcs.inv[1][0] * x2 + wcs.inv[1][1] * y2 + wcs.crpix[1] - 1;
        out[j * N + i] = bilinear(img.data, img.w, img.h, u, v);
      }
    }
    return out;
  }

  /* ---------- Brillo -> gris (estiramiento asinh) ---------- */
  function toGray(arr) {
    const vals = [];
    for (let k = 0; k < arr.length; k++) if (Number.isFinite(arr[k])) vals.push(arr[k]);
    if (vals.length < arr.length * 0.5) return null;   // el objetivo cae casi fuera del detector
    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(0.01 * (vals.length - 1))];
    let hi = vals[Math.floor(0.997 * (vals.length - 1))];
    if (!(hi > lo)) hi = lo + 1e-9;
    const gray = new Uint8ClampedArray(arr.length), valid = new Uint8Array(arr.length), k10 = Math.asinh(10);
    for (let k = 0; k < arr.length; k++) {
      if (!Number.isFinite(arr[k])) continue;
      const x = Math.min(1, Math.max(0, (arr[k] - lo) / (hi - lo)));
      gray[k] = Math.round(255 * Math.asinh(10 * x) / k10);
      valid[k] = 1;
    }
    return { gray, valid };
  }

  return { parseRA, parseDec, buildQuery, parseCSV, rowsToObjects, mjdToMs,
           parseFits, makeWCS, reproject, toGray };
})();

if (typeof module !== "undefined") module.exports = SkyLib;
