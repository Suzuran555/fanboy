/* Canvas renderer for the board: used by the live game, the replay viewer and the lobby preview. */
(function (root) {
  'use strict';
  const Eng = root.DragonEngine;

  const TEAM = [
    { head: '#a5f3ff', from: [64, 205, 240], to: [18, 92, 120], text: '#032530', ring: '#4dd6ff' },
    { head: '#ffd9b3', from: [255, 154, 77], to: [132, 66, 20], text: '#2e1300', ring: '#ff9a4d' },
  ];
  const PORTALS = ['#c77dff', '#ffd166', '#ff5d8f', '#5be3a0', '#9bb5ff', '#f78c6b', '#7df9ff', '#e0aaff', '#caffbf', '#ffadad'];
  const DX = Eng.DX, DY = Eng.DY;

  class BoardView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.map = null;
      this.state = null;
      this.ox = 0; this.oy = 0;
      this.cell = 16; this.pad = 5;
      this.bg = null; this.bgKey = '';
      this.opt = { timers: false, vision: false, range: false, threat: false, ids: false };
      this.selected = null;        // dragon id
      this.awaiting = null;        // { id, team, start, end } (end < 0: unlimited)
      this.ghost = null;           // { id, actions: [{k:'m', d:[..]}|{k:'s'}], sprint: [dirs] }
      this.splitHover = null;      // { id, index }
      this.target = null;          // tile index of a goto target for the selected dragon
      this.flash = new Map();      // dragon id -> timestamp of its last move
      this.myTeam = null;
      this.occ = null; this.occDirty = true;
    }

    setMap(map) {
      this.map = map;
      this.n = map.w * map.h;
      this.geom = { w: map.w, h: map.h, edgeN: map.edgeN, edgeW: map.edgeW, partnerN: map.partnerN, partnerW: map.partnerW };
      const nbr = new Int32Array(this.n * 4);
      for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) for (let d = 0; d < 4; d++) {
        const r = Eng.look(this.geom, x, y, d);
        nbr[(y * map.w + x) * 4 + d] = r.kind === Eng.EDGE_KELP ? -1 : r.y * map.w + r.x;
      }
      this.nbr = nbr;
      this.ox = 0; this.oy = 0;
      this.bgKey = '';
      // Portal colours by id, in order of appearance.
      this.portalColor = new Map();
      const ids = new Set();
      for (let i = 0; i < this.n; i++) { if (map.edgeN[i] === 2) ids.add(map.portalN[i]); if (map.edgeW[i] === 2) ids.add(map.portalW[i]); }
      Array.from(ids).sort((a, b) => a - b).forEach((id, k) => this.portalColor.set(id, PORTALS[k % PORTALS.length]));
      // Spawn richness per tile, 0..1 on a log scale.
      this.rich = new Float32Array(this.n);
      for (let i = 0; i < this.n; i++) {
        if (!map.spawns[i]) continue;
        const avg = (Math.max(1, map.minGap[i]) + map.maxGap[i]) / 2;
        this.rich[i] = Math.max(0.12, Math.min(1, 1 - Math.log(avg) / Math.log(900)));
      }
    }

    /** Fit the board into maxW x maxH CSS pixels. */
    layout(maxW, maxH) {
      if (!this.map) return;
      const { w, h } = this.map;
      const cell = Math.max(5, Math.min(58, Math.floor(Math.min((maxW - 2 * this.pad) / w, (maxH - 2 * this.pad) / h))));
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      const cw = cell * w + 2 * this.pad, ch = cell * h + 2 * this.pad;
      if (cell !== this.cell || this.canvas.width !== Math.round(cw * dpr) || this.dpr !== dpr) {
        this.cell = cell; this.dpr = dpr;
        this.canvas.width = Math.round(cw * dpr); this.canvas.height = Math.round(ch * dpr);
        this.canvas.style.width = cw + 'px'; this.canvas.style.height = ch + 'px';
        this.bgKey = '';
      }
    }

    pan(dx, dy) {
      if (!this.map) return;
      this.ox = ((this.ox + dx) % this.map.w + this.map.w) % this.map.w;
      this.oy = ((this.oy + dy) % this.map.h + this.map.h) % this.map.h;
    }
    centerOn(x, y) { this.ox = ((x - (this.map.w >> 1)) % this.map.w + this.map.w) % this.map.w; this.oy = ((y - (this.map.h >> 1)) % this.map.h + this.map.h) % this.map.h; }

    sx(x) { return this.pad + (((x - this.ox) % this.map.w + this.map.w) % this.map.w) * this.cell; }
    sy(y) { return this.pad + (((y - this.oy) % this.map.h + this.map.h) % this.map.h) * this.cell; }

    /** Tile under a mouse event, or null. */
    tileAt(ev) {
      if (!this.map) return null;
      const rect = this.canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left - this.pad, py = ev.clientY - rect.top - this.pad;
      const cx = Math.floor(px / this.cell), cy = Math.floor(py / this.cell);
      if (cx < 0 || cy < 0 || cx >= this.map.w || cy >= this.map.h) return null;
      const x = (cx + this.ox) % this.map.w, y = (cy + this.oy) % this.map.h;
      return { x, y, i: y * this.map.w + x };
    }

    occupancy() {
      if (!this.occDirty && this.occ) return this.occ;
      const occ = this.occ && this.occ.length === this.n * 2 ? this.occ.fill(-1) : new Int32Array(this.n * 2).fill(-1);
      if (this.state) for (const d of this.state.dragons.values()) {
        for (let k = 0; k < d.segs.length; k += 3) { const i = d.segs[k + 1] * this.map.w + d.segs[k]; occ[2 * i] = d.id; occ[2 * i + 1] = k / 3; }
      }
      this.occ = occ; this.occDirty = false;
      return occ;
    }
    /** { id, index } of the dragon segment on a tile, or null. */
    segmentAt(i) { const occ = this.occupancy(); return occ[2 * i] < 0 ? null : { id: occ[2 * i], index: occ[2 * i + 1] }; }

    /** Tiles a dragon could move its head onto this turn: up to L-1 steps through free tiles. */
    reach(d) {
      const occ = this.occupancy(), L = d.segs.length / 3, out = new Map();
      const start = d.segs[1] * this.map.w + d.segs[0];
      let frontier = [start]; const seen = new Set([start]);
      for (let depth = 1; depth <= L - 1 && frontier.length; depth++) {
        const next = [];
        for (const t of frontier) for (let dir = 0; dir < 4; dir++) {
          const nt = this.nbr[t * 4 + dir];
          if (nt < 0 || seen.has(nt)) continue;
          seen.add(nt);
          if (occ[2 * nt] >= 0) { if (occ[2 * nt + 1] === 0 && occ[2 * nt] !== d.id) out.set(nt, -depth); continue; } // a head we could ram
          out.set(nt, depth); next.push(nt);
        }
        frontier = next;
      }
      return out;
    }

    // ------------------------------------------------------------ background
    drawBackground() {
      const key = [this.cell, this.ox, this.oy, this.dpr, this.map.name, this.map.w, this.map.h].join('|');
      if (key === this.bgKey && this.bg) return;
      this.bgKey = key;
      const c = this.bg || (this.bg = document.createElement('canvas'));
      c.width = this.canvas.width; c.height = this.canvas.height;
      const g = c.getContext('2d');
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const { w, h } = this.map, cell = this.cell;
      g.fillStyle = '#04151d'; g.fillRect(0, 0, c.width, c.height);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, r = this.rich[i];
        const base = (x + y) & 1 ? [9, 36, 48] : [8, 32, 43];
        const col = r > 0 ? [base[0] + 6 * r, base[1] + 34 * r, base[2] + 36 * r] : [6, 22, 30];
        g.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
        g.fillRect(this.sx(x), this.sy(y), cell, cell);
      }
      // The wrap seam, so you can see where the map's own (0,0) corner is after panning.
      g.strokeStyle = 'rgba(140,200,220,.16)'; g.lineWidth = 1; g.setLineDash([3, 4]);
      g.beginPath(); g.moveTo(this.sx(0) + 0.5, this.pad); g.lineTo(this.sx(0) + 0.5, this.pad + h * cell);
      g.moveTo(this.pad, this.sy(0) + 0.5); g.lineTo(this.pad + w * cell, this.sy(0) + 0.5); g.stroke(); g.setLineDash([]);
      // Edges: kelp and portals. An edge on the first screen row/column is drawn on both sides.
      const lw = Math.max(2, cell * 0.16);
      g.lineCap = 'round';
      const edge = (x1, y1, x2, y2, kind, pid) => {
        if (kind === 1) { g.strokeStyle = '#3fbf78'; g.lineWidth = lw; g.shadowBlur = 0; }
        else { g.strokeStyle = this.portalColor.get(pid) || '#c77dff'; g.lineWidth = lw * 1.15; g.shadowColor = g.strokeStyle; g.shadowBlur = cell * 0.5; }
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.shadowBlur = 0;
      };
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, px = this.sx(x), py = this.sy(y);
        if (this.map.edgeN[i]) { edge(px, py, px + cell, py, this.map.edgeN[i], this.map.portalN[i]); if (py === this.pad) edge(px, py + h * cell, px + cell, py + h * cell, this.map.edgeN[i], this.map.portalN[i]); }
        if (this.map.edgeW[i]) { edge(px, py, px, py + cell, this.map.edgeW[i], this.map.portalW[i]); if (px === this.pad) edge(px + w * cell, py, px + w * cell, py + cell, this.map.edgeW[i], this.map.portalW[i]); }
      }
      if (cell >= 17) {
        g.font = `600 ${Math.max(8, cell * 0.34) | 0}px ui-monospace, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x, px = this.sx(x), py = this.sy(y);
          if (this.map.edgeN[i] === 2) { g.fillStyle = this.portalColor.get(this.map.portalN[i]); g.fillText(String(this.map.portalN[i]), px + cell * 0.5, py + cell * 0.22); }
          if (this.map.edgeW[i] === 2) { g.fillStyle = this.portalColor.get(this.map.portalW[i]); g.fillText(String(this.map.portalW[i]), px + cell * 0.22, py + cell * 0.5); }
        }
      }
    }

    // ------------------------------------------------------------ frame
    draw(now) {
      if (!this.map) return;
      const ctx = this.ctx, cell = this.cell, st = this.state;
      this.drawBackground();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.bg, 0, 0);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (!st) return;
      const w = this.map.w;
      const sel = this.selected !== null ? st.dragons.get(this.selected) : null;

      if (this.opt.threat && this.myTeam !== null) {
        const seen = new Set();
        for (const e of st.dragons.values()) if (e.team !== this.myTeam) for (const [t, depth] of this.reach(e)) if (depth > 0) seen.add(t);
        ctx.fillStyle = 'rgba(255,90,110,.16)';
        for (const t of seen) ctx.fillRect(this.sx(t % w), this.sy((t / w) | 0), cell, cell);
      }
      if (this.opt.range && sel) {
        for (const [t, depth] of this.reach(sel)) {
          const x = this.sx(t % w), y = this.sy((t / w) | 0);
          if (depth < 0) { ctx.strokeStyle = '#ff5d7a'; ctx.lineWidth = 2; ctx.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3); }
          else { ctx.fillStyle = `rgba(255,214,110,${0.26 - 0.16 * (depth / Math.max(2, sel.segs.length / 3))})`; ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2); }
        }
      }
      if (this.opt.vision && sel) {
        ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.2;
        const hx = sel.segs[0], hy = sel.segs[1];
        // Drawn tile by tile so it wraps with the map.
        ctx.beginPath();
        for (let k = -3; k <= 3; k++) {
          let x = this.sx(hx + k), y = this.sy(hy - 3); ctx.moveTo(x, y); ctx.lineTo(x + cell, y);
          y = this.sy(hy + 3) + cell; ctx.moveTo(x, y); ctx.lineTo(x + cell, y);
          y = this.sy(hy + k); x = this.sx(hx - 3); ctx.moveTo(x, y); ctx.lineTo(x, y + cell);
          x = this.sx(hx + 3) + cell; ctx.moveTo(x, y); ctx.lineTo(x, y + cell);
        }
        ctx.stroke(); ctx.setLineDash([]);
      }

      // Spawn timers
      if (this.opt.timers && st.cd) {
        const big = cell >= 15;
        if (big) { ctx.font = `600 ${(cell * 0.42) | 0}px ui-monospace, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; }
        for (let i = 0; i < this.n; i++) {
          if (!this.map.spawns[i] || st.pearls[i]) continue;
          const cd = st.cd[this.map.cdGroup[i]];
          if (cd < 0 || cd > 9) continue;
          const x = this.sx(i % w), y = this.sy((i / w) | 0), a = 0.25 + 0.6 * (1 - cd / 9);
          if (big) { ctx.fillStyle = `rgba(255,227,239,${a})`; ctx.fillText(String(cd), x + cell / 2, y + cell / 2 + 0.5); }
          else { ctx.fillStyle = `rgba(255,227,239,${a * 0.8})`; ctx.fillRect(x + cell * 0.4, y + cell * 0.4, Math.max(1.5, cell * 0.2), Math.max(1.5, cell * 0.2)); }
        }
      }

      // Pearls
      const pr = Math.max(1.6, cell * 0.2);
      ctx.fillStyle = 'rgba(255,190,215,.22)';
      ctx.beginPath();
      for (let i = 0; i < this.n; i++) if (st.pearls[i]) { const x = this.sx(i % w) + cell / 2, y = this.sy((i / w) | 0) + cell / 2; ctx.moveTo(x + pr * 1.9, y); ctx.arc(x, y, pr * 1.9, 0, 6.2832); }
      ctx.fill();
      ctx.fillStyle = '#ffe3ef';
      ctx.beginPath();
      for (let i = 0; i < this.n; i++) if (st.pearls[i]) { const x = this.sx(i % w) + cell / 2, y = this.sy((i / w) | 0) + cell / 2; ctx.moveTo(x + pr, y); ctx.arc(x, y, pr, 0, 6.2832); }
      ctx.fill();

      // Dragons
      for (const d of st.dragons.values()) if (d.id !== this.selected) this.drawDragon(d, now, false);
      if (sel) this.drawDragon(sel, now, true);

      if (this.splitHover && sel && this.splitHover.id === sel.id) {
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        for (let k = this.splitHover.index; k < sel.segs.length / 3; k++) ctx.fillRect(this.sx(sel.segs[3 * k]) + 2, this.sy(sel.segs[3 * k + 1]) + 2, cell - 4, cell - 4);
      }
      if (this.ghost && sel && this.ghost.id === sel.id) this.drawGhost(sel);
      if (this.target !== null && sel) {
        const x = this.sx(this.target % w) + cell / 2, y = this.sy((this.target / w) | 0) + cell / 2;
        ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, cell * 0.36, 0, 6.2832); ctx.moveTo(x - cell * 0.18, y); ctx.lineTo(x + cell * 0.18, y); ctx.moveTo(x, y - cell * 0.18); ctx.lineTo(x, y + cell * 0.18); ctx.stroke();
      }

      // The dragon the game is waiting on
      if (this.awaiting) {
        const d = st.dragons.get(this.awaiting.id);
        if (d) {
          const x = this.sx(d.segs[0]) + cell / 2, y = this.sy(d.segs[1]) + cell / 2;
          const pulse = 0.5 + 0.5 * Math.sin(now / 140);
          ctx.strokeStyle = `rgba(255,209,102,${0.55 + 0.45 * pulse})`; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.arc(x, y, cell * (0.78 + 0.1 * pulse), 0, 6.2832); ctx.stroke();
          if (this.awaiting.end > 0) {
            const frac = Math.max(0, Math.min(1, (this.awaiting.end - now) / (this.awaiting.end - this.awaiting.start)));
            ctx.strokeStyle = '#fff3cf'; ctx.lineWidth = 3.5;
            ctx.beginPath(); ctx.arc(x, y, cell * 1.05, -1.5708, -1.5708 + 6.2832 * frac); ctx.stroke();
          }
        }
      }
    }

    drawDragon(d, now, selected) {
      const ctx = this.ctx, cell = this.cell, T = TEAM[d.team];
      const L = d.segs.length / 3;
      const t = cell * 0.7, inset = (cell - t) / 2, rad = Math.min(t * 0.32, 6);
      const shape = (grow) => {
        ctx.beginPath();
        for (let k = 0; k < L; k++) {
          const x = this.sx(d.segs[3 * k]), y = this.sy(d.segs[3 * k + 1]);
          roundRect(ctx, x + inset - grow, y + inset - grow, t + 2 * grow, t + 2 * grow, rad + grow);
          if (k >= 1) {
            const dir = d.segs[3 * k + 2];
            stub(ctx, x, y, cell, inset - grow, dir);                              // this segment, towards the head
            const px = this.sx(d.segs[3 * (k - 1)]), py = this.sy(d.segs[3 * (k - 1) + 1]);
            stub(ctx, px, py, cell, inset - grow, (dir + 2) & 3);                   // the previous one, back towards us
          }
        }
      };
      if (selected) { ctx.fillStyle = 'rgba(255,255,255,.95)'; shape(2.2); ctx.fill(); }
      // Body gradient head -> tail, drawn tail first so the head end stays on top.
      for (let k = L - 1; k >= 0; k--) {
        const f = L > 1 ? k / (L - 1) : 0;
        ctx.fillStyle = k === 0 ? T.head : `rgb(${mix(T.from[0], T.to[0], f)},${mix(T.from[1], T.to[1], f)},${mix(T.from[2], T.to[2], f)})`;
        const x = this.sx(d.segs[3 * k]), y = this.sy(d.segs[3 * k + 1]);
        ctx.beginPath();
        roundRect(ctx, x + inset, y + inset, t, t, rad);
        if (k >= 1) stub(ctx, x, y, cell, inset, d.segs[3 * k + 2]);
        if (k < L - 1) stub(ctx, x, y, cell, inset, (d.segs[3 * (k + 1) + 2] + 2) & 3);
        ctx.fill();
      }
      // Head: length number and a nose marking the facing.
      const hx = this.sx(d.segs[0]), hy = this.sy(d.segs[1]), dir = d.segs[2];
      ctx.fillStyle = T.text;
      const cx = hx + cell / 2 + DX[dir] * cell * 0.3, cy = hy + cell / 2 + DY[dir] * cell * 0.3;
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, cell * 0.07), 0, 6.2832); ctx.fill();
      if (cell >= 13) {
        ctx.font = `700 ${Math.max(8, (cell * (L > 99 ? 0.36 : L > 9 ? 0.44 : 0.52)) | 0)}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(L), hx + cell / 2 - DX[dir] * cell * 0.06, hy + cell / 2 + 0.5 - DY[dir] * cell * 0.06);
      }
      if (this.opt.ids && cell >= 16) {
        // The id rides on the head's top-right corner.
        const lx = hx + cell * 0.98, ly = hy + cell * 0.04;
        ctx.font = `600 ${Math.max(8, (cell * 0.3) | 0)}px ui-monospace, monospace`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(4,21,29,.75)'; const tw = ctx.measureText('#' + d.id).width + 4; ctx.fillRect(lx - tw / 2, ly - cell * 0.18, tw, cell * 0.36);
        ctx.fillStyle = T.ring; ctx.fillText('#' + d.id, lx, ly + 0.5);
      }
      const fl = this.flash.get(d.id);
      if (fl !== undefined) {
        const age = now - fl;
        if (age < 260) { ctx.strokeStyle = `rgba(255,255,255,${0.75 * (1 - age / 260)})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(hx + cell / 2, hy + cell / 2, cell * (0.5 + 0.35 * age / 260), 0, 6.2832); ctx.stroke(); }
        else this.flash.delete(d.id);
      }
    }

    /** Preview of the selected dragon's queued orders (and the sprint being typed). */
    drawGhost(d) {
      const ctx = this.ctx, cell = this.cell, w = this.map.w;
      let x = d.segs[0], y = d.segs[1];
      const pts = [];
      let blocked = null, n = 0;
      const walk = (dirs, sprint) => {
        for (let k = 0; k < dirs.length; k++) {
          const r = Eng.look(this.geom, x, y, dirs[k]);
          if (r.kind === Eng.EDGE_KELP) { blocked = { x, y, dir: dirs[k] }; return false; }
          x = r.x; y = r.y; n++;
          pts.push({ x, y, sprint: sprint && k > 0, jump: r.kind === Eng.EDGE_PORTAL });
        }
        return true;
      };
      for (const a of this.ghost.actions) {
        if (a.k === 's') { pts.push({ x, y, split: true }); continue; }
        if (!walk(a.d, a.d.length > 1)) break;
      }
      if (!blocked && this.ghost.sprint && this.ghost.sprint.length) walk(this.ghost.sprint, true);
      pts.forEach((p, k) => {
        const px = this.sx(p.x) + cell / 2, py = this.sy(p.y) + cell / 2;
        ctx.fillStyle = p.split ? '#ffffff' : p.sprint ? 'rgba(255,140,90,.95)' : 'rgba(255,209,102,.9)';
        ctx.globalAlpha = Math.max(0.35, 1 - k * 0.05);
        ctx.beginPath(); ctx.arc(px, py, p.split ? cell * 0.3 : cell * 0.16, 0, 6.2832); ctx.fill();
        if (p.split) { ctx.fillStyle = '#04151d'; ctx.font = `700 ${(cell * 0.4) | 0}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('✂', px, py + 1); }
      });
      ctx.globalAlpha = 1;
      if (blocked) {
        const px = this.sx(blocked.x) + cell / 2 + DX[blocked.dir] * cell / 2, py = this.sy(blocked.y) + cell / 2 + DY[blocked.dir] * cell / 2;
        ctx.strokeStyle = '#ff5d7a'; ctx.lineWidth = 2.5; const s = cell * 0.2;
        ctx.beginPath(); ctx.moveTo(px - s, py - s); ctx.lineTo(px + s, py + s); ctx.moveTo(px + s, py - s); ctx.lineTo(px - s, py + s); ctx.stroke();
      }
    }
  }

  function mix(a, b, f) { return (a + (b - a) * f) | 0; }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
  }
  /** A half-cell connector from a segment's body towards one side of its tile. */
  function stub(ctx, x, y, cell, inset, dir) {
    const t = cell - 2 * inset;
    if (dir === 0) ctx.rect(x + inset, y - 0.5, t, cell / 2 + 0.5);
    else if (dir === 2) ctx.rect(x + inset, y + cell / 2, t, cell / 2 + 0.5);
    else if (dir === 3) ctx.rect(x - 0.5, y + inset, cell / 2 + 0.5, t);
    else ctx.rect(x + cell / 2, y + inset, cell / 2 + 0.5, t);
  }

  root.BoardView = BoardView;
  root.TEAM_COLORS = ['#4dd6ff', '#ff9a4d'];
})(window);
