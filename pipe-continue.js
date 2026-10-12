/* ============================================================
   FlowMark — continue an existing pipe run
   Loaded straight after app.js. app.js is a classic script, so its functions
   and state (draft, sel, state, pipePress, finishPipe …) are shared globals;
   this file wraps a handful of them rather than duplicating their logic.

   How it works for the user:
   • Pipe tool: hover / tap the open (free) end of a run of the SAME pipe type
     and it highlights. Click it and you carry on drawing from that end, with
     the usual bends, curves, asset connections and double-click / Enter to
     finish. The new legs are added to the original run (one pipe, not two).
   • Select a pipe: the inspector has Continue run → From start / From end.
     Works from any end, including one connected to an asset.
   • Shortcut: with a pipe selected, press C to continue from its end (or from
     its start when the start point is the active point).
   Undo removes the whole extension in one step. Esc abandons it untouched.
   ============================================================ */
(function () {
  'use strict';

  let pipeHover = null;   // { p, end } — open end under the cursor in pipe mode
  const PIPE_HINT = 'Click to start a run, or click the open end of a run to continue it. Click bends (hold and drag to curve), then click an asset or double-click to finish.';
  const HOVER_HINT = 'Click to continue this run from its end';

  /* Open (not asset-bound) end of a run of `type` near world point w. */
  function hitPipeEnd(w, type, touch) {
    const tol = (touch ? 16 : 9) / view.scale;
    let best = null, bd = tol;
    for (let i = state.pipes.length - 1; i >= 0; i--) {
      const p = state.pipes[i];
      if (p.type !== type || p.pts.length < 2) continue;
      const rp = resolvePipePts(p.pts);
      const ends = [['start', 0], ['end', p.pts.length - 1]];
      for (const [end, k] of ends) {
        if (p.pts[k].node) continue;
        const d = Math.hypot(rp[k].x - w.x, rp[k].y - w.y);
        if (d < bd) { bd = d; best = { p, end }; }
      }
    }
    return best;
  }

  /* Reverse a run's point list. A bend lives on the point a segment arrives
     at, so when the direction flips each bend moves to the other end of its
     segment — re-expressed as an offset from that point, so the curve's
     corner stays exactly where it was. */
  function reverseRun(pts) {
    const n = pts.length;
    const out = pts.slice().reverse().map(pt => { const q = { ...pt }; delete q.h; return q; });
    for (let k = 1; k < n; k++) {
      if (!hasCurve(pts[k])) continue;
      const c = curveCtrl(pts[k]), a = ptPos(pts[k - 1]);
      out[n - k].h = { x: c.x - a.x, y: c.y - a.y };
    }
    return out;
  }

  /* Graft the drafted legs onto run p. add[0] is the joint (a copy of the end
     being continued); add[1..] are the new points in the order drawn. */
  function joinRun(p, add, end) {
    if (end === 'end') { p.pts = p.pts.concat(add.slice(1)); return; }
    // Continuing from the start: the new legs become the front of the run.
    const rev = reverseRun(add);                     // last item is the joint
    const joint = { ...p.pts[0] };
    const jh = rev[rev.length - 1].h;                // bend of the first new leg
    if (jh) joint.h = jh; else delete joint.h;
    p.pts = rev.slice(0, -1).concat([joint], p.pts.slice(1));
  }

  /* Begin a draft that grows run p from one of its ends. */
  function startContinue(p, end) {
    const src = end === 'start' ? p.pts[0] : p.pts[p.pts.length - 1];
    const pt = { x: src.x, y: src.y };
    if (src.node) pt.node = src.node;
    draft = { type: p.type, pts: [pt], preview: null, cont: { id: p.id, end } };
    pipeHover = null;
    hint(DRAFT_HINT); draw();
  }

  /* Entry point from the inspector / C key: switch to that run's pipe tool. */
  function continueRun(p, end) {
    if (!p) return;
    setTool('pipe', { pipe: p.type });
    startContinue(p, end);
    if (window.innerWidth <= 880) $('#inspector').classList.remove('open');
  }

  /* ---- hooks into app.js ---- */

  const basePipePress = pipePress;
  pipePress = function (w, e) {
    if (!draft) {
      const hit = hitPipeEnd(w, pipeKind, e && e.pointerType === 'touch');
      if (hit) { startContinue(hit.p, hit.end); return; }
    }
    basePipePress(w, e);
  };

  const baseFinishPipe = finishPipe;
  finishPipe = function () {
    if (!draft || !draft.cont) { baseFinishPipe(); return; }
    const c = draft.cont;
    // drop zero-length straight legs left by a double-click (same rule as a new run)
    const pts = [];
    for (const pt of draft.pts) { const prev = pts[pts.length - 1]; if (!prev || hasCurve(pt) || !samePt(prev, pt)) pts.push(pt); }
    const p = state.pipes.find(q => q.id === c.id);
    draft = null; hint('');
    if (p && pts.length >= 2) {
      mutate(() => {
        joinRun(p, pts, c.end);
        select({ kind: 'pipe', id: p.id });
        sel.vi = c.end === 'end' ? p.pts.length - 1 : 0;   // the new open end is the active point
      });
      renderInspector();
      toast('Run extended');
    }
    draw();
  };

  const baseOnMove = onMove;
  onMove = function (e) {
    baseOnMove(e);
    if (tool !== 'pipe' || draft || drag) { if (pipeHover) { pipeHover = null; draw(); } return; }
    const h = hitPipeEnd(pointerWorld(e), pipeKind, e.pointerType === 'touch');
    const key = h ? h.p.id + h.end : '', cur = pipeHover ? pipeHover.p.id + pipeHover.end : '';
    if (key === cur) return;
    pipeHover = h;
    hint(h ? HOVER_HINT : PIPE_HINT);
    draw();
  };

  const baseDraw = draw;
  draw = function () {
    baseDraw();
    if (!pipeHover || tool !== 'pipe' || draft) return;
    const p = pipeHover.p;
    if (!state.pipes.includes(p)) { pipeHover = null; return; }
    const rp = resolvePipePts(p.pts);
    const q = pipeHover.end === 'start' ? rp[0] : rp[rp.length - 1];
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.strokeStyle = (PIPES[p.type] || PIPES.coldMains).color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx(q.x), sy(q.y), 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath(); ctx.arc(sx(q.x), sy(q.y), 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };

  const baseSetTool = setTool;
  setTool = function (t, opts) {
    pipeHover = null;
    baseSetTool(t, opts);
    if (t === 'pipe') hint(PIPE_HINT);
  };

  const baseRender = renderInspector;
  renderInspector = function () {
    baseRender();
    if (group.length || !sel || sel.kind !== 'pipe') return;
    const p = state.pipes.find(q => q.id === sel.id); if (!p) return;
    const body = $('#inspBody');
    const row = document.createElement('div');
    row.className = 'insp-row';
    row.innerHTML = '<label>Continue run</label><div class="cap-row">'
      + '<button type="button" data-pcont="start" title="Keep drawing from the first point of this run">From start</button>'
      + '<button type="button" data-pcont="end" title="Keep drawing from the last point of this run (C)">From end</button></div>';
    const anchor = $('.btn-sub', body) || $('.btn-del', body);
    if (anchor) body.insertBefore(row, anchor); else body.appendChild(row);
    $$('[data-pcont]', row).forEach(b => b.addEventListener('click', () => continueRun(p, b.dataset.pcont)));
  };

  // C — continue the selected run (from the start if that's the active point)
  window.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'c') return;
    if (draft || group.length || !sel || sel.kind !== 'pipe') return;
    const p = state.pipes.find(q => q.id === sel.id); if (!p) return;
    e.preventDefault();
    continueRun(p, activePipePoint(p) === 0 ? 'start' : 'end');
  });

  // exposed for smoke tests / debugging
  window.FlowMarkContinue = { hitPipeEnd, reverseRun, joinRun, startContinue, continueRun };

  // refresh the inspector in case a pipe was already selected at load
  renderInspector();
})();
