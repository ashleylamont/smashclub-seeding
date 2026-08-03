# The Jakeman scale (Jk)

One Jakeman (1.0 Jk) is the stock ratio a player is expected to take off
Matt J in a 7-minute battle: stocks taken from Matt divided by stocks Matt
takes back. 2.0 Jk means winning the exchange two stocks to one; 0.5 Jk
means losing it at the same rate.

## Calibration

Three ratios were observed empirically and anchored to the players' WHR
skill ratings on the live leaderboard (nemesis.ashl.dev, 2026-08-03,
Matt J rated 1514):

| Player | Rating | Observed | Fitted |
| --- | --- | --- | --- |
| Shirley Z | 1387 | 0.8 Jk | 0.8007 Jk |
| Ashley L | 1508 | 1.2 Jk | 1.1985 Jk |
| Mitchell M | 1812 | 3.3 Jk | 3.3012 Jk |

A least-squares fit of ln(Jk) on rating puts all three anchors on one
exponential to within 0.2%:

```
Jk(R) = exp((R − 1453.6) / 299.9)
```

Properties of the curve:

- **One e-fold (×2.72) per ~300 rating points**, i.e. the stock ratio
  doubles every ~208 points. For comparison, WHR/Elo win odds use a 400/ln10
  ≈ 174-point e-fold, so the stock ratio grows a little more slowly with
  rating than win odds do — plausible, since a timed battle aggregates many
  stocks and single-set upsets wash out.
- **The Jakeman-neutral rating (1.0 Jk) is 1453.6**, about 60 points *below*
  Matt's own bracket rating of 1514. The anchors are unanimous on this:
  Ashley is rated dead even with Matt (1508 vs 1514) yet takes 1.2 stocks
  per stock given. Either Matt underperforms his bracket rating by ~60
  points in 7-minute free-for-all format, or the original 1 Jk unit was
  defined generously. The scale keeps the anchors as ground truth.

The three-point fit leaves one degree of freedom for validation and the fit
is near-exact, which is decent evidence a log-linear model is the right
shape — but the anchors span only 1387–1812, so tails beyond that range
(Djani at 10.9 Jk, Ana at 0.31 Jk) are extrapolation.

## Tooling

`pnpm jakeman` fetches the live leaderboard, re-runs the calibration
against current ratings (the anchors are fixed ratios pinned to player
IDs), and prints every player's Jakeman rating with a ±1σ band derived
from their rating uncertainty. `pnpm jakeman --player <name>` filters to
one player.

## Snapshot (2026-08-03)

| Board rank | Player | Rating | Jk |
| --- | --- | --- | --- |
| 1 | Djani D | 2171 | 10.9 |
| 5 | Victor | 2052 | 7.36 |
| 2 | Sam A | 2049 | 7.28 |
| 3 | Kai M | 2030 | 6.83 |
| 6 | Joseph | 2007 | 6.34 |
| 4 | Caleb C | 1992 | 6.03 |
| 9 | Vincent | 1958 | 5.37 |
| 11 | Cormac K | 1895 | 4.35 |
| 7 | Alex H | 1887 | 4.24 |
| 8 | Anthy T | 1882 | 4.17 |
| 10 | Kazuki N | 1877 | 4.10 |
| 13 | Maurice | 1872 | 4.03 |
| 21 | David B | 1866 | 3.96 |
| 12 | Tim S | 1850 | 3.75 |
| 26 | Matt W | 1834 | 3.56 |
| 14 | Dillon | 1816 | 3.35 |
| 15 | Mitchell M *(anchor)* | 1812 | 3.30 |
| 19 | Raymond W | 1805 | 3.23 |
| 16 | Jackson L | 1797 | 3.14 |
| 17 | Leonardo A | 1784 | 3.01 |
| 18 | Josh C | 1782 | 2.99 |
| 20 | Tom L | 1754 | 2.73 |
| 22 | Harry T | 1740 | 2.60 |
| 23 | Franco | 1731 | 2.52 |
| 29 | Luke E | 1729 | 2.50 |
| 24 | Keller H | 1720 | 2.43 |
| 25 | Sean Z | 1716 | 2.40 |
| 27 | Joshua L | 1701 | 2.28 |
| 39 | Reece | 1695 | 2.23 |
| 40 | Victor K | 1692 | 2.21 |
| 31 | Matt W | 1672 | 2.07 |
| 28 | Caleb M | 1658 | 1.98 |
| 33 | Will | 1655 | 1.96 |
| 41 | Christos K | 1650 | 1.93 |
| 30 | Ivor | 1641 | 1.87 |
| 49 | Buu L | 1632 | 1.81 |
| 53 | Justin | 1625 | 1.77 |
| 32 | Yiwei | 1618 | 1.73 |
| 34 | Mendel L | 1614 | 1.71 |
| 43 | Luca K | 1605 | 1.66 |
| 55 | Michael | 1605 | 1.66 |
| 35 | Lesley L | 1603 | 1.65 |
| 36 | Tom M | 1598 | 1.62 |
| 60 | Justin O | 1596 | 1.61 |
| 62 | Jiamin | 1594 | 1.60 |
| 50 | Dom | 1592 | 1.58 |
| 37 | Matthew C | 1589 | 1.57 |
| 38 | Hayley F | 1576 | 1.50 |
| 42 | Zachary C | 1566 | 1.45 |
| 56 | Dason W | 1565 | 1.45 |
| 44 | Paul J | 1561 | 1.43 |
| 71 | Mark | 1561 | 1.43 |
| 76 | Jerome | 1549 | 1.37 |
| 77 | Darryl | 1545 | 1.36 |
| 45 | Jamie V | 1537 | 1.32 |
| 82 | Connor | 1535 | 1.31 |
| 68 | William T | 1533 | 1.30 |
| 46 | Jonah D | 1531 | 1.29 |
| 58 | Vicky W | 1521 | 1.25 |
| 47 | Oliver H | 1518 | 1.24 |
| 86 | Brandon | 1515 | 1.23 |
| 48 | Matthew J — **Matt J himself** | 1514 | 1.22 |
| 64 | Hugh R | 1511 | 1.21 |
| 51 | Thomas K | 1511 | 1.21 |
| 87 | Brenton | 1509 | 1.20 |
| 75 | Matthew K | 1509 | 1.20 |
| 52 | Ashley L *(anchor)* | 1508 | 1.20 |
| 89 | George M | 1504 | 1.18 |
| 92 | Irwan | 1496 | 1.15 |
| 54 | Luke P | 1496 | 1.15 |
| 81 | Blake R | 1495 | 1.15 |
| 57 | Aidan H | 1483 | 1.10 |
| 59 | Hugh M | 1479 | 1.09 |
| 97 | Reede | 1479 | 1.09 |
| 61 | Lucas H | 1474 | 1.07 |
| 63 | Jamal E | 1472 | 1.06 |
| 73 | Jean Y | 1472 | 1.06 |
| 65 | Caitlin N | 1467 | 1.05 |
| 104 | JZab | 1467 | 1.04 |
| 66 | Ben | 1463 | 1.03 |
| 67 | Alfred A | 1461 | 1.02 |
| 79 | Lawrence N | 1460 | 1.02 |
| 69 | Darin H | 1449 | 0.99 |
| 70 | Tom L | 1444 | 0.97 |
| 72 | Navid B | 1433 | 0.93 |
| 74 | Roy L | 1431 | 0.93 |
| 78 | Jeremy | 1421 | 0.90 |
| 80 | Christian M | 1420 | 0.89 |
| 90 | Zabdiel J | 1419 | 0.89 |
| 114 | Matthew S | 1418 | 0.89 |
| 91 | Rex Y | 1417 | 0.88 |
| 93 | Eric H | 1407 | 0.86 |
| 94 | Ethan Z | 1406 | 0.85 |
| 83 | Ignacio T | 1403 | 0.85 |
| 84 | Phoebe P | 1400 | 0.84 |
| 119 | Dominic | 1399 | 0.83 |
| 85 | Adam H | 1397 | 0.83 |
| 110 | Charlie W | 1394 | 0.82 |
| 98 | Morgan M S | 1393 | 0.82 |
| 101 | Yubi G | 1392 | 0.82 |
| 88 | Shirley Z *(anchor)* | 1387 | 0.80 |
| 105 | Ronald P | 1384 | 0.79 |
| 125 | Omar | 1381 | 0.78 |
| 127 | Kabir | 1375 | 0.77 |
| 133 | Sim | 1370 | 0.76 |
| 117 | Tom N | 1370 | 0.76 |
| 95 | Scott S | 1364 | 0.74 |
| 107 | Eddy S | 1362 | 0.74 |
| 96 | Paavn G | 1362 | 0.74 |
| 135 | Franklin | 1359 | 0.73 |
| 136 | Celina | 1356 | 0.72 |
| 99 | Tamon M | 1353 | 0.71 |
| 100 | Sarah B | 1353 | 0.71 |
| 122 | Isaac K | 1349 | 0.71 |
| 102 | Paul W | 1349 | 0.70 |
| 103 | Yifan L | 1347 | 0.70 |
| 139 | Lucia | 1347 | 0.70 |
| 140 | Paul | 1344 | 0.69 |
| 142 | Calvin | 1337 | 0.68 |
| 106 | Eoin | 1336 | 0.68 |
| 128 | Danial K | 1333 | 0.67 |
| 143 | Jonathan | 1331 | 0.67 |
| 130 | Amelia G | 1331 | 0.67 |
| 131 | Belinda W | 1331 | 0.66 |
| 132 | Donna Z | 1331 | 0.66 |
| 146 | Byron | 1325 | 0.65 |
| 108 | Nyah I | 1321 | 0.64 |
| 109 | Nicolas | 1318 | 0.64 |
| 148 | Caylim P | 1314 | 0.63 |
| 111 | Matthew L | 1311 | 0.62 |
| 150 | Akshay | 1310 | 0.62 |
| 138 | Jacky K | 1308 | 0.62 |
| 151 | Bryan | 1306 | 0.61 |
| 123 | Martin | 1306 | 0.61 |
| 124 | Fraser | 1305 | 0.61 |
| 112 | Etkin T | 1302 | 0.60 |
| 152 | Davin | 1298 | 0.60 |
| 113 | Ethan Z | 1298 | 0.60 |
| 115 | Andre R | 1297 | 0.59 |
| 126 | Jason L | 1296 | 0.59 |
| 116 | Daniel Z | 1296 | 0.59 |
| 129 | Udit S | 1292 | 0.58 |
| 134 | Tony L | 1282 | 0.57 |
| 118 | Tim Y | 1282 | 0.56 |
| 147 | Freya | 1281 | 0.56 |
| 149 | Jordan C | 1274 | 0.55 |
| 120 | Anthony | 1272 | 0.55 |
| 121 | Salina H | 1272 | 0.55 |
| 137 | Tim C | 1270 | 0.54 |
| 153 | Andrew C | 1265 | 0.53 |
| 141 | Richard M | 1261 | 0.53 |
| 144 | Han | 1247 | 0.50 |
| 154 | Elena | 1245 | 0.50 |
| 155 | Henry | 1242 | 0.49 |
| 156 | Craig D | 1236 | 0.48 |
| 145 | Nathan | 1207 | 0.44 |
| 158 | Nazif A | 1180 | 0.40 |
| 157 | Ana K | 1102 | 0.31 |
