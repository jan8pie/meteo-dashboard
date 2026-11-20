# Meteo dashboard – Slovenský Grob

Jednoduchá stránka s počasím pre tablet a e-ink čítačku. Dáta sú z [Open-Meteo](https://open-meteo.com) (zadarmo, bez kľúča).

- Prepínač **Tablet / Čítačka** (pamätá si voľbu; dá sa aj cez adresu `?rezim=tablet` alebo `?rezim=citacka`)
- Tlačidlo **Celá obrazovka**
- Obnova: 6:00–9:00 každých 5 min, 9:00–20:00 každých 10 min, 20:00–6:00 každých 30 min
- Grafy teploty a tlaku za posledných 24 h + predpoveď na 24 h, predpoveď na 7 dní

Súbory: `index.html`, `style.css`, `app.js` (starší JavaScript, aby to bežalo aj na starom Androide).
