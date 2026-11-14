#!/usr/bin/env python3
"""
SPHEREx Sky Timeline - descarga de recortes.

Consulta el archivo IRSA (TAP) por todas las imagenes espectrales de SPHEREx que
cubren una posicion del cielo, descarga recortes pequenos, los reproyecta a una
cuadricula comun (norte arriba) y los guarda como PNG + manifest.json para el visor web.

Uso:
  python fetch_cutouts.py --name "Ejemplo IRSA" --ra 305.59875 --dec 41.14889 \
      --size 0.15 --max-images 60

La consulta TAP puede tardar ~40 s (es normal). Los datos son de NASA/IPAC IRSA.
"""
import argparse
import copy
import http.client
import json
import os
import re
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.utils.data import conf
from astropy.wcs import WCS
from astroquery.ipac.irsa import Irsa
from PIL import Image
from reproject import reproject_interp

conf.remote_timeout = 120  # los archivos de SPHEREx pueden tardar en abrirse

PIXEL_SCALE_ARCSEC = 6.2  # escala nativa aproximada de SPHEREx


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "objetivo"


def query_images(ra, dec, size_deg):
    query = f"""
    SELECT
        'https://irsa.ipac.caltech.edu/' || a.uri || '?center={ra},{dec}d&size={size_deg}' AS uri,
        p.time_bounds_lower, p.time_bounds_upper, p.energy_bandpassname, p.provenance_version
    FROM spherex.artifact a
    JOIN spherex.plane p ON a.planeid = p.planeid
    WHERE 1 = CONTAINS(POINT('ICRS', {ra}, {dec}), p.poly)
    ORDER BY p.time_bounds_lower
    """
    print("Consultando IRSA (TAP)... puede tardar ~40 s")
    t0 = time.time()
    table = Irsa.query_tap(query).to_table()
    print(f"  {len(table)} imagenes encontradas en {time.time() - t0:.0f} s")
    return table


def download_cutout(url, retries=3):
    for attempt in range(retries):
        try:
            with fits.open(url) as hdul:
                hdul_copy = copy.deepcopy(hdul)
            data = hdul_copy["IMAGE"].data.astype(float)
            return data, WCS(hdul_copy["IMAGE"].header)
        except (TimeoutError, urllib.error.HTTPError, http.client.IncompleteRead,
                http.client.RemoteDisconnected, OSError):
            if attempt == retries - 1:
                return None
            time.sleep(5 * (attempt + 1))
    return None


def target_wcs(ra, dec, npix):
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra, dec]
    w.wcs.crpix = [(npix + 1) / 2, (npix + 1) / 2]
    w.wcs.cdelt = [-PIXEL_SCALE_ARCSEC / 3600, PIXEL_SCALE_ARCSEC / 3600]
    return w


def to_png(data, path, upscale):
    finite = np.isfinite(data)
    lo, hi = np.nanpercentile(data[finite], [1, 99.7])
    if hi <= lo:
        hi = lo + 1e-6
    x = np.clip((data - lo) / (hi - lo), 0, 1)
    x = np.arcsinh(10 * x) / np.arcsinh(10)  # estiramiento asinh: resalta lo debil
    x = np.nan_to_num(x, nan=0.0)
    img = Image.fromarray((x * 255).astype(np.uint8), mode="L")
    img = img.resize((img.width * upscale, img.height * upscale), Image.BICUBIC)
    img.save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="Nombre del objetivo")
    ap.add_argument("--ra", type=float, required=True, help="Ascension recta (grados)")
    ap.add_argument("--dec", type=float, required=True, help="Declinacion (grados)")
    ap.add_argument("--size", type=float, default=0.15, help="Tamano del recorte (grados)")
    ap.add_argument("--max-images", type=int, default=60, help="Maximo de cuadros (muestreo uniforme en el tiempo)")
    ap.add_argument("--upscale", type=int, default=5, help="Factor de ampliacion del PNG")
    ap.add_argument("--out", default="data", help="Carpeta de salida")
    args = ap.parse_args()

    tid = slugify(args.name)
    out_dir = os.path.join(args.out, tid)
    os.makedirs(out_dir, exist_ok=True)

    table = query_images(args.ra, args.dec, args.size)
    if len(table) == 0:
        raise SystemExit("IRSA no devolvio imagenes para esa posicion.")

    idx = np.unique(np.linspace(0, len(table) - 1, min(args.max_images, len(table))).astype(int))
    rows = [table[i] for i in idx]

    npix = max(8, int(round(args.size * 3600 / PIXEL_SCALE_ARCSEC)))
    out_wcs = target_wcs(args.ra, args.dec, npix)

    print(f"Descargando {len(rows)} recortes...")
    results = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(download_cutout, str(r["uri"])): k for k, r in enumerate(rows)}
        for fut in as_completed(futures):
            k = futures[fut]
            res = fut.result()
            if res is not None:
                results[k] = res
            print(f"  {len(results)}/{len(rows)}", end="\r")
    print()

    frames = []
    for k in sorted(results):
        data, wcs_in = results[k]
        reproj, _ = reproject_interp((data, wcs_in), out_wcs, shape_out=(npix, npix))
        if np.isfinite(reproj).mean() < 0.5:
            continue  # el objetivo cae en el borde del detector
        fname = f"f{len(frames):03d}.png"
        to_png(reproj, os.path.join(out_dir, fname), args.upscale)
        r = rows[k]
        mjd = float(r["time_bounds_lower"])
        try:
            date = Time(mjd, format="mjd").iso[:16] + " UTC"  # se asume MJD; verificar en la documentacion
        except Exception:
            date = str(mjd)
        frames.append({
            "file": fname,
            "mjd": mjd,
            "date": date,
            "band": str(r["energy_bandpassname"]),
            "version": str(r["provenance_version"]),
        })

    manifest = {"id": tid, "name": args.name, "ra": args.ra, "dec": args.dec,
                "size_deg": args.size, "frames": frames}
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    index_path = os.path.join(args.out, "index.json")
    index = []
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as f:
            index = json.load(f)
    index = [t for t in index if t["id"] != tid] + [{"id": tid, "name": args.name}]
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)

    print(f"Listo: {len(frames)} cuadros en {out_dir}/  (abre el visor con: python -m http.server)")


if __name__ == "__main__":
    main()
