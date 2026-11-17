'use strict';

/*
 * Plot Weaver — an Obsidian plugin for outlining novels with
 * multiple simultaneous plotlines, POVs, off-screen events,
 * cause-and-effect links between threads, and chapters.
 */

const {
  Plugin, ItemView, Modal, Setting, Notice, Menu, PluginSettingTab, setIcon, normalizePath, TFile,
} = require('obsidian');

const VIEW_TYPE = 'plot-weaver-board';
const PALETTE = ['#4f8fd6', '#d9534f', '#5cb85c', '#e0a030', '#9b6ad6', '#3fb6b2', '#d97a3f', '#c05c8a', '#7a8b99'];
const SVGNS = 'http://www.w3.org/2000/svg';

const DEFAULT_SETTINGS = {
  notesFolder: 'Novel Notes',
  confirmDelete: true,
  columnWidth: 250,
  laneWidth: 170,
  templateFolder: 'Templates',
  defaultTemplate: '',
  askTemplate: true,
  addProperties: true,
  fullscreenWindow: true,
};
const DEFAULT_UI = { mode: 'board', columns: 'time', shelfTab: 'unplaced', shelfCollapsed: false, showArrows: true, showOffscreen: true, povFilter: 'all' };

/** Book structure. A Part is a divider that groups the chapters after it; a card assigned to a Part is its summary. */
const SECTION_KINDS = [
  { key: 'part', label: 'Part', icon: 'library' },
  { key: 'prologue', label: 'Prologue', icon: 'sunrise' },
  { key: 'chapter', label: 'Chapter', icon: 'book-open' },
  { key: 'interlude', label: 'Interlude', icon: 'coffee' },
  { key: 'epilogue', label: 'Epilogue', icon: 'sunset' },
];

const SHELF_TABS = [
  { key: 'unplaced', label: 'Unplaced', icon: 'inbox', hint: 'Active ideas not yet placed in story time or a chapter. Drag one onto the board to place it.' },
  { key: 'parked', label: 'Later', icon: 'clock', hint: 'Saved for later: kept safe, but off the board. Restoring returns an idea to where it was.' },
  { key: 'archived', label: 'Archive', icon: 'archive', hint: 'Retired ideas. Nothing is lost; restore any time.' },
];

/* ---------------------------------------------------------------- helpers */

function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }
function nextColor(used) { return PALETTE.find(c => !used.includes(c)) || PALETTE[used.length % PALETTE.length]; }
function sanitizeFileName(s) {
  return (s || 'Untitled').replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function svg(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
  return e;
}
function createSpanEl(cls) { const e = document.createElement('span'); e.className = cls; return e; }
function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }
function pad(x) { return String(x).padStart(2, '0'); }

function makeBeat(fields) {
  return Object.assign({
    id: uid(), title: 'Untitled', summary: '', plotlineId: null, povId: null, slotId: null, chapterId: null,
    offscreen: false, status: 'active', order: 0, shelfOrder: Date.now(),
    notePath: null, influences: [], created: Date.now(),
  }, fields || {});
}

function makeNovel(title) {
  return {
    id: uid(),
    title: title || 'My Novel',
    plotlines: [
      { id: uid(), name: 'Main plot', color: PALETTE[0], description: '', archived: false, collapsed: false },
      { id: uid(), name: 'Subplot', color: PALETTE[2], description: '', archived: false, collapsed: false },
    ],
    povs: [],
    slots: ['Opening', 'Inciting incident', 'Midpoint', 'Crisis', 'Climax', 'Resolution'].map(label => ({ id: uid(), label })),
    chapters: [],
    beats: [],
    manuscriptOrder: [],
  };
}

function normalizeNovel(n) {
  n.plotlines = (n.plotlines || []).map(p => Object.assign({ description: '', archived: false, collapsed: false, color: PALETTE[0] }, p));
  n.povs = n.povs || [];
  n.slots = n.slots || [];
  n.manuscriptOrder = n.manuscriptOrder || [];
  n.beats = (n.beats || []).map(b => makeBeat(b));
  const ids = new Set(n.beats.map(b => b.id));
  n.links = Array.isArray(n.links) ? n.links.filter(x => x && x !== n.id) : [];
  for (const b of n.beats) {
    b.influences = (b.influences || []).filter(i => i && i.to && (i.novel && i.novel !== n.id ? true : ids.has(i.to) && i.to !== b.id));
    for (const i of b.influences) if (i.novel === n.id) delete i.novel;
  }
  if (!Array.isArray(n.chapters)) {
    // Migrate v1 free-text chapter labels into chapter objects, in reading order.
    n.chapters = [];
    const seq = NV.sequence(n);
    const rest = n.beats.filter(b => !seq.includes(b));
    for (const b of seq.concat(rest)) {
      const label = (b.chapter || '').trim();
      if (!label) continue;
      let c = n.chapters.find(x => x.title === label);
      if (!c) { c = { id: uid(), title: label }; n.chapters.push(c); }
      b.chapterId = c.id;
    }
  }
  for (const b of n.beats) delete b.chapter;
  n.chapters = n.chapters.map(c => Object.assign({ kind: 'chapter' }, c));
  const beatIds = new Set(n.beats.map(b => b.id));
  for (const b of n.beats) {
    delete b.where; // older versions let a card show on the board or outline only; every card now shows in both
    // Older versions could break a card into scene cards. Scenes become ordinary cards and keep their story time.
    if (b.parentId) {
      const par = n.beats.find(x => x.id === b.parentId);
      if (!b.slotId && par && par.slotId) b.slotId = par.slotId;
    }
    delete b.parentId;
  }
  return n;
}

/* An original example story that shows every feature. */
function makeExampleNovel() {
  const n = { id: uid(), title: 'The Lantern Heist (example)', plotlines: [], povs: [], slots: [], chapters: [], beats: [], manuscriptOrder: [] };
  const heist = { id: uid(), name: 'The Heist', color: '#4f8fd6', description: 'Mara’s crew plans to steal the Harrow Lantern.', archived: false, collapsed: false };
  const inv = { id: uid(), name: 'The Investigation', color: '#d9534f', description: 'Inspector Hale closes in.', archived: false, collapsed: false };
  const syn = { id: uid(), name: 'The Syndicate', color: '#9b6ad6', description: 'Mostly off-screen: the people pulling the strings.', archived: false, collapsed: false };
  n.plotlines.push(heist, inv, syn);
  const mara = { id: uid(), name: 'Mara', color: '#3fb6b2' };
  const hale = { id: uid(), name: 'Hale', color: '#e0a030' };
  const quill = { id: uid(), name: 'Quill', color: '#c05c8a' };
  n.povs.push(mara, hale, quill);
  const S = ['Ten years earlier', 'The offer', 'Preparations', 'The night of the job', 'Morning after', 'One month later'].map(label => ({ id: uid(), label }));
  n.slots = S;
  const C = [
    ['Chapter 1: A Fortune in Glass'], ['Chapter 2: Demotion'], ['Chapter 3: Rag Paper'], ['Interlude: Constable Hale', 'interlude'],
    ['Chapter 4: The Supplier'], ['Chapter 5: Ten Minutes Past Two'], ['Chapter 6: Two Lanterns'],
  ].map(([title, kind]) => ({ id: uid(), title, kind: kind || 'chapter' }));
  const part1 = { id: uid(), title: 'Part One: The Job', kind: 'part' };
  const part2 = { id: uid(), title: 'Part Two: Two Thefts', kind: 'part' };
  const epilogue = { id: uid(), title: 'Epilogue', kind: 'epilogue' };
  n.chapters = [part1, C[0], C[1], C[2], C[3], C[4], part2, C[5], C[6], epilogue];
  const B = (o) => { const b = makeBeat(o); n.beats.push(b); return b; };
  const flash = B({ title: 'Mara’s mentor is arrested', summary: 'Teenage Mara watches the only person who trusted her taken away — by a young constable named Hale.', plotlineId: heist.id, povId: mara.id, slotId: S[0].id, chapterId: C[3].id });
  const offer = B({ title: 'Mara gets the offer', summary: 'An anonymous client offers a fortune for the Harrow Lantern.', plotlineId: heist.id, povId: mara.id, slotId: S[1].id, chapterId: C[0].id });
  const insurer = B({ title: 'Syndicate buys the museum’s insurer', summary: 'A shell company quietly takes control of the policy on the Lantern.', plotlineId: syn.id, slotId: S[1].id, offscreen: true });
  const reassign = B({ title: 'Hale is reassigned to art crimes', summary: 'A demotion, as far as Hale is concerned.', plotlineId: inv.id, povId: hale.id, slotId: S[1].id, chapterId: C[1].id });
  const forge = B({ title: 'Quill forges the Lantern', summary: 'Three weeks of work. Quill keeps one detail deliberately wrong.', plotlineId: heist.id, povId: quill.id, slotId: S[2].id, chapterId: C[2].id });
  const rota = B({ title: 'The guards’ rota changes', summary: 'Mara notices the new schedule is suspiciously convenient.', plotlineId: heist.id, povId: mara.id, slotId: S[2].id, chapterId: C[2].id, order: 1 });
  const paper = B({ title: 'Hale finds Quill’s paper supplier', summary: 'A receipt for 18th-century rag paper leads Hale to the forger.', plotlineId: inv.id, povId: hale.id, slotId: S[2].id, chapterId: C[4].id });
  const breakin = B({ title: 'The break-in', summary: 'Everything goes to plan. That should have worried her.', plotlineId: heist.id, povId: mara.id, slotId: S[3].id, chapterId: C[5].id, order: 1 });
  const cold = B({ title: 'Quill tries to back out', summary: 'An hour before the job, Quill’s nerve fails. Not in a chapter yet — where does it belong?', plotlineId: heist.id, povId: quill.id, slotId: S[3].id });
  const swap = B({ title: 'The Syndicate swaps the forgery', summary: 'Their own man replaces Quill’s forgery with a second, cruder fake.', plotlineId: syn.id, slotId: S[3].id, offscreen: true, order: 1 });
  const fake = B({ title: 'The Lantern in the vault is fake', summary: 'Hale realises two thefts happened on the same night.', plotlineId: inv.id, povId: hale.id, slotId: S[4].id, chapterId: C[6].id });
  const fence = B({ title: 'The Syndicate’s buyer arrives', summary: 'A private collector lands in the city, expecting the real Lantern.', plotlineId: syn.id, slotId: S[4].id, offscreen: true });
  insurer.influences.push({ to: rota.id, note: 'The insurer cuts the security budget' });
  paper.influences.push({ to: breakin.id, note: 'Hale is watching the night of the job' });
  swap.influences.push({ to: fake.id, note: 'The crude fake gives the game away' });
  forge.influences.push({ to: fake.id, note: 'Quill’s deliberate flaw is missing' });
  flash.influences.push({ to: reassign.id, note: 'Hale’s history with Mara' });
  cold.influences.push({ to: breakin.id, note: 'Mara has to cover Quill’s part' });
  B({ title: 'Does Mara have a twin?', summary: 'Might explain the alibi problem in Act 3.', status: 'parked', plotlineId: heist.id });
  B({ title: 'Rooftop chase in the rain', summary: 'Hale nearly catches Quill.', plotlineId: inv.id });
  B({ title: 'Hale was in on it all along', summary: 'Too much of a cheat. Retired.', status: 'archived', plotlineId: inv.id });
  void fence;
  // A part summary, a board card broken down into outline scenes, and an outline-only epilogue scene.
  B({ title: 'Two thefts, one night', summary: 'Part Two follows the fallout: what was really taken, and by whom.', plotlineId: inv.id, slotId: S[3].id, chapterId: part2.id });
  B({ title: 'Mara watches the museum reopen', summary: 'A new Lantern in the case. She knows exactly what it is.', plotlineId: heist.id, povId: mara.id, slotId: S[5].id, chapterId: epilogue.id });
  n.manuscriptOrder = [offer, reassign, forge, rota, flash, paper, breakin, fake].map(b => b.id);
  return n;
}

/** A linked example series: a worldbuilding history that feeds Book 1, and Book 2 that draws on both. */
function makeExampleSeries() {
  const world = {
    id: uid(), title: 'Lantern World (worldbuilding)', povs: [], chapters: [], beats: [], manuscriptOrder: [], links: [],
    plotlines: [
      { id: uid(), name: 'History of the Lantern', color: '#7a8b99', description: 'How the Harrow Lantern came to be.', archived: false, collapsed: false },
      { id: uid(), name: 'Rise of the Syndicate', color: '#9b6ad6', description: 'The organisation behind everything.', archived: false, collapsed: false },
    ],
    slots: ['Three centuries ago', 'Fifty years ago', 'Twenty years ago'].map(label => ({ id: uid(), label })),
  };
  const W = o => { const b = makeBeat(o); world.beats.push(b); return b; };
  const made = W({ title: 'The Harrow Lantern is made', summary: 'A glassmaker hides a map of the city’s old tunnels inside the lens.', plotlineId: world.plotlines[0].id, slotId: world.slots[0].id, offscreen: true });
  const founded = W({ title: 'The Syndicate is founded', summary: 'Its first rule: never steal what you can insure.', plotlineId: world.plotlines[1].id, slotId: world.slots[1].id, offscreen: true });
  const fire = W({ title: 'The museum fire', summary: 'Half the collection burns. Someone has to be blamed.', plotlineId: world.plotlines[0].id, slotId: world.slots[2].id, offscreen: true });

  const book1 = makeExampleNovel();
  book1.title = 'Book 1: The Lantern Heist';
  book1.links = [world.id];
  const b1 = t => book1.beats.find(b => b.title.startsWith(t));

  const book2 = {
    id: uid(), title: 'Book 2: The Second Lantern', chapters: [], beats: [], manuscriptOrder: [], links: [world.id, book1.id],
    plotlines: [
      { id: uid(), name: 'The Tunnels', color: '#3fb6b2', description: 'What the real Lantern was hiding.', archived: false, collapsed: false },
      { id: uid(), name: 'Hale’s Reckoning', color: '#d9534f', description: 'The inquiry into the night of two thefts.', archived: false, collapsed: false },
    ],
    povs: [{ id: uid(), name: 'Mara', color: '#3fb6b2' }, { id: uid(), name: 'Hale', color: '#e0a030' }],
    slots: ['A year later', 'Below the city', 'The inquiry'].map(label => ({ id: uid(), label })),
  };
  book2.chapters = ['1. Glass and Dust', '2. Under the Museum', '3. Testimony'].map(title => ({ id: uid(), title }));
  const B2 = o => { const b = makeBeat(o); book2.beats.push(b); return b; };
  const map = B2({ title: 'Mara finds the map in the real Lantern', summary: 'The lens holds lines that match no street she knows.', plotlineId: book2.plotlines[0].id, povId: book2.povs[0].id, slotId: book2.slots[0].id, chapterId: book2.chapters[0].id });
  const tunnels = B2({ title: 'The tunnels under the museum', summary: 'The map leads straight back to where it all started.', plotlineId: book2.plotlines[0].id, povId: book2.povs[0].id, slotId: book2.slots[1].id, chapterId: book2.chapters[1].id });
  const inquiry = B2({ title: 'Hale is called before an inquiry', summary: 'Two thefts on one night, on his watch.', plotlineId: book2.plotlines[1].id, povId: book2.povs[1].id, slotId: book2.slots[2].id, chapterId: book2.chapters[2].id });
  map.influences.push({ to: tunnels.id, note: 'The map is a route' });

  // Worldbuilding → Book 1 and Book 2
  made.influences.push({ to: b1('Quill forges').id, novel: book1.id, note: 'The hidden map is the one detail Quill can’t copy' });
  made.influences.push({ to: map.id, novel: book2.id, note: 'The map is still in the lens' });
  founded.influences.push({ to: b1('Syndicate buys').id, novel: book1.id, note: 'Never steal what you can insure' });
  fire.influences.push({ to: b1('Mara’s mentor').id, novel: book1.id, note: 'Her mentor is blamed for the fire' });
  fire.influences.push({ to: tunnels.id, novel: book2.id, note: 'The fire was set to hide the tunnel entrance' });
  // Book 1 → Book 2
  b1('The Lantern in the vault').influences.push({ to: inquiry.id, novel: book2.id, note: 'How did two thefts happen on his watch?' });
  b1('The Syndicate’s buyer').influences.push({ to: map.id, novel: book2.id, note: 'The buyer still wants the real Lantern' });
  return [world, book1, book2];
}

/* ------------------------------------------------------------ novel model */

const NV = {
  plotline: (n, id) => n.plotlines.find(p => p.id === id) || null,
  pov: (n, id) => n.povs.find(p => p.id === id) || null,
  slot: (n, id) => n.slots.find(s => s.id === id) || null,
  chapter: (n, id) => (n.chapters || []).find(c => c.id === id) || null,
  beat: (n, id) => n.beats.find(b => b.id === id) || null,
  slotIndex: (n, id) => n.slots.findIndex(s => s.id === id),
  chapterIndex: (n, id) => (n.chapters || []).findIndex(c => c.id === id),
  laneIndex: (n, id) => n.plotlines.findIndex(p => p.id === id),

  /** Placed in story time (a board column). */
  hasTime(n, b) { return !!NV.slot(n, b.slotId); },
  kind: c => (c && c.kind) || 'chapter',
  kindInfo: c => SECTION_KINDS.find(k => k.key === NV.kind(c)) || SECTION_KINDS[2],
  /** A card attached to a Part (rather than a chapter) is that Part's summary. */
  /** In a Part: that part's summary. */
  isPartSummary(n, b) { return NV.hasChapter(n, b) && NV.kind(NV.chapter(n, b.chapterId)) === 'part'; },
  /** A summary rather than a numbered scene (a card placed in a Part). */
  isSummary(n, b) { return NV.isPartSummary(n, b); },
  partOf(n, sectionId) {
    const i = NV.chapterIndex(n, sectionId);
    for (let k = i; k >= 0; k--) if (NV.kind(n.chapters[k]) === 'part') return n.chapters[k];
    return null;
  },
  defaultSectionTitle(n, kind) {
    const count = n.chapters.filter(c => NV.kind(c) === kind).length;
    if (kind === 'part') return `Part ${count + 1}`;
    if (kind === 'chapter') return `Chapter ${count + 1}`;
    if (kind === 'interlude') return count ? `Interlude ${count + 1}` : 'Interlude';
    return SECTION_KINDS.find(k => k.key === kind).label;
  },
  /** Assigned to a chapter or part (off-screen events never are). */
  hasChapter(n, b) { return !b.offscreen && !!NV.chapter(n, b.chapterId); },
  /** The story-time event a card sits in, if any. */
  timeOf(n, b) { return NV.slot(n, b.slotId); },
  isPlaced(n, b) { return !!NV.plotline(n, b.plotlineId) && (!!NV.timeOf(n, b) || NV.hasChapter(n, b)); },
  sectionLabel(n, id) { const c = NV.chapter(n, id); return c ? c.title : ''; },
  onBoard(n, b) {
    if (b.status !== 'active' || !NV.isPlaced(n, b)) return false;
    return !NV.plotline(n, b.plotlineId).archived;
  },
  shelfKind(n, b) {
    if (b.status === 'parked') return 'parked';
    if (b.status === 'archived') return 'archived';
    if (!NV.isPlaced(n, b)) return 'unplaced';
    return null;
  },
  /** Story-time cell. slotId null = the "no story time yet" column. */
  cell(n, slotId, plotlineId, excludeId) {
    return n.beats.filter(b => b.id !== excludeId && b.status === 'active' && b.plotlineId === plotlineId
      && (slotId ? b.slotId === slotId : (NV.onBoard(n, b) && !NV.timeOf(n, b))))
      .sort((a, b) => a.order - b.order);
  },
  /** Chapter cell, in reading order. chapterId null = the "no chapter yet" column. */
  chapterCell(n, chapterId, plotlineId) {
    return NV.manuscript(n).filter(b => b.plotlineId === plotlineId
      && (chapterId ? b.chapterId === chapterId && NV.hasChapter(n, b) : !NV.hasChapter(n, b)));
  },
  shelf(n, kind, excludeId) {
    return n.beats.filter(b => b.id !== excludeId && NV.shelfKind(n, b) === kind).sort((a, b) => a.shelfOrder - b.shelfOrder);
  },
  nextOrder(n, slotId, plotlineId) {
    const c = NV.cell(n, slotId, plotlineId);
    return c.length ? Math.max(...c.map(b => b.order)) + 1 : 0;
  },
  chronoCmp(n) {
    const si = b => { const t = NV.timeOf(n, b); const i = t ? NV.slotIndex(n, t.id) : -1; return i < 0 ? 1e6 : i; };
    return (a, b) => (si(a) - si(b)) || (NV.laneIndex(n, a.plotlineId) - NV.laneIndex(n, b.plotlineId)) || (a.order - b.order);
  },
  /** Insert b right after its chronological predecessor in list (or before its successor). */
  placeChrono(list, b, cmp) {
    let pred = -1;
    for (let i = 0; i < list.length; i++) {
      if (cmp(list[i], b) <= 0 && (pred < 0 || cmp(list[i], list[pred]) >= 0)) pred = i;
    }
    if (pred >= 0) { list.splice(pred + 1, 0, b); return; }
    let succ = -1;
    for (let i = 0; i < list.length; i++) {
      if (pred < 0 && (succ < 0 || cmp(list[i], list[succ]) < 0)) succ = i;
    }
    list.splice(succ >= 0 ? succ : list.length, 0, b);
  },
  /** On-screen scenes in the writer's manual order; new ones slot in by story time. */
  sequence(n, filter) {
    const keep = filter || (() => true);
    const eligible = n.beats.filter(b => NV.onBoard(n, b) && !b.offscreen && keep(b));
    const byId = new Map(eligible.map(b => [b.id, b]));
    const known = (n.manuscriptOrder || []).filter(id => byId.has(id)).map(id => byId.get(id));
    const knownSet = new Set(known.map(b => b.id));
    const cmp = NV.chronoCmp(n);
    const result = known.slice();
    for (const b of eligible.filter(x => !knownSet.has(x.id)).sort(cmp)) NV.placeChrono(result, b, cmp);
    return result;
  },
  /** Reading order: grouped by chapter (in chapter order), unassigned scenes last. */
  manuscript(n, filter) {
    const seq = NV.sequence(n, filter);
    const ci = b => (NV.hasChapter(n, b) ? NV.chapterIndex(n, b.chapterId) : (n.chapters || []).length);
    return seq.map((b, i) => ({ b, i })).sort((x, y) => (ci(x.b) - ci(y.b)) || (x.i - y.i)).map(x => x.b);
  },
  /** Off-screen events with a story time, each placed after its chronological predecessor. */
  withOffscreen(n, list) {
    const cmp = NV.chronoCmp(n);
    const off = n.beats.filter(b => NV.onBoard(n, b) && b.offscreen && NV.timeOf(n, b)).sort(cmp);
    // Weave into the chaptered manuscript when there is one; scenes still waiting for a chapter (and part summaries) don't anchor events.
    const chaptered = list.filter(b => NV.hasChapter(n, b) && NV.timeOf(n, b) && !NV.isSummary(n, b));
    if (!chaptered.length) {
      const out = list.slice();
      for (const b of off) NV.placeChrono(out, b, cmp);
      return out;
    }
    const anchors = chaptered.slice();
    for (const b of off) NV.placeChrono(anchors, b, cmp);
    // Rebuild: walk the full list, emitting each off-screen event right after the anchor it followed.
    const after = new Map(); // anchor id (or '' for start) -> off-screen events
    let prev = '';
    for (const b of anchors) {
      if (b.offscreen) { if (!after.has(prev)) after.set(prev, []); after.get(prev).push(b); }
      else prev = b.id;
    }
    const out = [...(after.get('') || [])];
    for (const b of list) { out.push(b); if (after.has(b.id)) out.push(...after.get(b.id)); }
    return out;
  },
  /** Split a reading-order list (incl. off-screen) into chapter groups. */
  groups(n, list) {
    const groups = (n.chapters || []).map(c => ({ chapter: c, items: [] }));
    const loose = { chapter: null, items: [] };
    groups.push(loose);
    const groupOf = b => (NV.hasChapter(n, b) ? groups[NV.chapterIndex(n, b.chapterId)] : loose);
    let cur = null, pending = [];
    for (const b of list) {
      if (b.offscreen) { if (cur) cur.items.push(b); else pending.push(b); continue; }
      cur = groupOf(b);
      if (pending.length) { cur.items.push(...pending); pending = []; }
      cur.items.push(b);
    }
    if (pending.length) loose.items.push(...pending);
    return groups;
  },
  influencedBy(n, id) {
    const out = [];
    for (const b of n.beats) for (const inf of b.influences) if (inf.to === id) out.push({ from: b, note: inf.note });
    return out;
  },
  insertAt(list, b, beforeId) {
    let idx = beforeId ? list.findIndex(x => x.id === beforeId) : list.length;
    if (idx < 0) idx = list.length;
    list.splice(idx, 0, b);
    return list;
  },
  moveToCell(n, id, slotId, plotlineId, beforeId) {
    const b = NV.beat(n, id); if (!b) return;
    const list = NV.insertAt(NV.cell(n, slotId, plotlineId, id), b, beforeId);
    b.slotId = slotId; b.plotlineId = plotlineId; b.status = 'active';
    list.forEach((x, i) => { x.order = i; });
  },
  /** Put a scene into a chapter (null = unassign) at a reading position. */
  assignChapter(n, id, chapterId, beforeId) {
    const b = NV.beat(n, id); if (!b) return;
    b.chapterId = chapterId || null;
    const seq = NV.sequence(n, () => true).map(x => x.id).filter(x => x !== id);
    let idx = beforeId ? seq.indexOf(beforeId) : -1;
    if (idx < 0) idx = seq.length; // manuscript() regroups, so the end of seq = end of its chapter
    seq.splice(idx, 0, id);
    n.manuscriptOrder = seq;
  },
  moveToChapterCell(n, id, chapterId, plotlineId, beforeId) {
    const b = NV.beat(n, id); if (!b) return;
    b.plotlineId = plotlineId; b.status = 'active';
    if (chapterId) b.offscreen = false;
    NV.assignChapter(n, id, chapterId, beforeId);
  },
  moveToShelf(n, id, kind, beforeId) {
    const b = NV.beat(n, id); if (!b) return;
    if (kind === 'unplaced') { b.status = 'active'; b.slotId = null; b.chapterId = null; }
    else b.status = kind; // parked/archived remember their last position
    const list = NV.insertAt(NV.shelf(n, kind, id), b, beforeId);
    list.forEach((x, i) => { x.shelfOrder = i; });
  },
  restore(n, id) {
    const b = NV.beat(n, id); if (!b) return;
    b.status = 'active';
    if (NV.isPlaced(n, b)) { if (NV.hasTime(n, b)) b.order = NV.nextOrder(n, b.slotId, b.plotlineId); }
    else { b.slotId = null; b.shelfOrder = Date.now(); }
  },
  remove(n, id) {
    n.beats = n.beats.filter(b => b.id !== id);
    n.manuscriptOrder = n.manuscriptOrder.filter(x => x !== id);
    for (const b of n.beats) b.influences = b.influences.filter(i => i.to !== id);
  },
  moveItem(arr, fromIdx, toIdx) {
    if (fromIdx < 0 || toIdx < 0 || toIdx >= arr.length) return;
    const [x] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, x);
  },
};

/* ------------------------------------------------- links between novels */

/**
 * A novel can "draw on" other novels (n.links): a worldbuilding history, earlier books in a series.
 * An influence that crosses novels is stored on the cause, with `novel` set to the id of the novel the effect is in.
 */
const XN = {
  novel: (novels, id) => novels.find(x => x.id === id) || null,
  targetNovelId: (src, inf) => inf.novel || src.id,
  incoming(novels, n, beatId) {
    const out = [];
    for (const nv of novels) for (const b of nv.beats) for (const inf of b.influences) {
      if (inf.to === beatId && XN.targetNovelId(nv, inf) === n.id) out.push({ from: b, fromNovel: nv, note: inf.note });
    }
    return out;
  },
  outgoing(novels, n, b) {
    return b.influences.map(inf => {
      const tn = XN.novel(novels, XN.targetNovelId(n, inf));
      const t = tn && NV.beat(tn, inf.to);
      return t ? { to: t, toNovel: tn, note: inf.note } : null;
    }).filter(Boolean);
  },
  upstream: (novels, n) => (n.links || []).map(id => XN.novel(novels, id)).filter(x => x && x.id !== n.id),
  downstream: (novels, n) => novels.filter(x => x.id !== n.id && (x.links || []).includes(n.id)),
  /** Events in other novels that shape this one, grouped by source novel (linked novels first, in link order). */
  externals(novels, n) {
    const order = n.links || [];
    const groups = [];
    for (const nv of novels) {
      if (nv.id === n.id) continue;
      const beats = nv.beats.filter(b => b.status === 'active' && b.influences.some(i => i.novel === n.id && NV.beat(n, i.to)));
      if (beats.length || order.includes(nv.id)) groups.push({ novel: nv, beats: beats.sort(NV.chronoCmp(nv)) });
    }
    const rank = g => { const i = order.indexOf(g.novel.id); return i < 0 ? 1e3 : i; };
    return groups.sort((a, b) => rank(a) - rank(b));
  },
  purgeBeat(novels, beatId) {
    for (const nv of novels) for (const b of nv.beats) b.influences = b.influences.filter(i => i.to !== beatId);
  },
  purgeNovel(novels, novelId) {
    for (const nv of novels) {
      nv.links = (nv.links || []).filter(x => x !== novelId);
      for (const b of nv.beats) b.influences = b.influences.filter(i => i.novel !== novelId);
    }
  },
  /** "Title" for the home novel, "Novel › Title" for an event in another novel. */
  name: (home, nv, b) => (nv && home && nv.id !== home.id ? `${nv.title} › ${b.title}` : b.title),
};

/* ------------------------------------------------------------------ modals */

class TextPromptModal extends Modal {
  constructor(app, title, placeholder, initial, onSubmit) {
    super(app);
    Object.assign(this, { heading: title, placeholder, initial: initial || '', onSubmit });
  }
  onOpen() {
    this.modalEl.addClass('pw-modal');
    this.titleEl.setText(this.heading);
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'pw-prompt-input' });
    input.placeholder = this.placeholder || '';
    input.value = this.initial;
    const submit = () => {
      const v = input.value.trim();
      if (!v) return;
      this.close();
      this.onSubmit(v);
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const foot = this.contentEl.createDiv('pw-modal-footer');
    foot.createDiv('pw-spacer');
    foot.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    const ok = foot.createEl('button', { text: 'OK', cls: 'mod-cta' });
    ok.onclick = submit;
    setTimeout(() => { input.focus(); input.select(); }, 20);
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmModal extends Modal {
  constructor(app, title, message, confirmText, onConfirm) {
    super(app);
    Object.assign(this, { heading: title, message, confirmText, onConfirm });
  }
  onOpen() {
    this.modalEl.addClass('pw-modal');
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('p', { text: this.message });
    const foot = this.contentEl.createDiv('pw-modal-footer');
    foot.createDiv('pw-spacer');
    foot.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    const ok = foot.createEl('button', { text: this.confirmText || 'Delete', cls: 'mod-warning' });
    ok.onclick = () => { this.close(); this.onConfirm(); };
  }
  onClose() { this.contentEl.empty(); }
}

/** After drawing a link: optionally say how the cause leads to the effect, or take the link back. */
class LinkNoteModal extends Modal {
  constructor(app, from, to, onSave, onUndo) { super(app); Object.assign(this, { from, to, onSave, onUndo }); }
  onOpen() {
    this.modalEl.addClass('pw-modal', 'pw-link-modal');
    this.titleEl.setText('New cause → effect');
    const pair = this.contentEl.createDiv('pw-link-pair');
    pair.createSpan({ cls: 'pw-link-end', text: this.from });
    pair.createSpan({ cls: 'pw-link-arrow', text: '→' });
    pair.createSpan({ cls: 'pw-link-end', text: this.to });
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'pw-prompt-input' });
    input.placeholder = 'How does it lead there? (optional)';
    const save = () => { const v = input.value.trim(); this.close(); if (v) this.onSave(v); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    const foot = this.contentEl.createDiv('pw-modal-footer');
    foot.createEl('button', { text: 'Undo link' }).onclick = () => { this.close(); this.onUndo(); };
    foot.createDiv('pw-spacer');
    foot.createEl('button', { text: 'Skip' }).onclick = () => this.close();
    foot.createEl('button', { text: 'Save', cls: 'mod-cta' }).onclick = save;
    setTimeout(() => input.focus(), 20);
  }
  onClose() { this.contentEl.empty(); }
}

class ColorModal extends Modal {
  constructor(app, title, current, onPick) { super(app); Object.assign(this, { heading: title, current, onPick }); }
  onOpen() {
    this.modalEl.addClass('pw-modal');
    this.titleEl.setText(this.heading);
    const row = this.contentEl.createDiv('pw-swatches');
    for (const c of PALETTE) {
      const sw = row.createDiv('pw-swatch');
      sw.style.background = c;
      sw.toggleClass('is-active', c === this.current);
      sw.onclick = () => { this.close(); this.onPick(c); };
    }
    const custom = row.createEl('input', { type: 'color' });
    custom.value = this.current || PALETTE[0];
    custom.setAttr('aria-label', 'Custom colour');
    custom.onchange = () => { this.close(); this.onPick(custom.value); };
  }
  onClose() { this.contentEl.empty(); }
}

/** A filterable list to pick one item: templates, notes, chapters. */
class PickerModal extends Modal {
  constructor(app, title, items, onPick, opts) {
    super(app);
    Object.assign(this, { heading: title, items, onPick, opts: opts || {} });
    this.active = 0;
  }
  onOpen() {
    this.modalEl.addClass('pw-modal', 'pw-picker');
    this.titleEl.setText(this.heading);
    if (this.opts.intro) this.contentEl.createDiv({ cls: 'pw-muted pw-picker-intro', text: this.opts.intro });
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'pw-prompt-input' });
    input.placeholder = this.opts.placeholder || 'Type to filter…';
    const list = this.contentEl.createDiv('pw-picker-list');
    let shown = [];
    const choose = it => { if (!it) return; this.close(); this.onPick(it.value); };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = this.items.filter(it => it.sticky || !q || `${it.label} ${it.desc || ''}`.toLowerCase().includes(q)).slice(0, 300);
      this.active = Math.max(0, Math.min(this.active, shown.length - 1));
      list.empty();
      shown.forEach((it, i) => {
        const row = list.createDiv('pw-picker-item');
        row.toggleClass('is-active', i === this.active);
        row.toggleClass('is-action', !!it.sticky);
        const top = row.createDiv('pw-picker-label');
        top.setText(it.label);
        if (it.badge) top.createSpan({ cls: 'pw-count', text: it.badge });
        if (it.desc) row.createDiv({ cls: 'pw-picker-desc', text: it.desc });
        row.onmouseenter = () => { this.active = i; list.querySelectorAll('.pw-picker-item').forEach((el, k) => el.toggleClass('is-active', k === i)); };
        row.onclick = () => choose(it);
      });
      if (!shown.length) list.createDiv({ cls: 'pw-empty', text: this.opts.empty || 'Nothing matches.' });
    };
    input.addEventListener('input', () => { this.active = 0; draw(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.active = Math.min(this.active + 1, shown.length - 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.active = Math.max(this.active - 1, 0); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(shown[this.active]); }
    });
    const pre = this.items.findIndex(it => this.opts.selected !== undefined && it.value === this.opts.selected);
    if (pre >= 0) this.active = pre;
    draw();
    setTimeout(() => input.focus(), 20);
  }
  onClose() { this.contentEl.empty(); }
}

class BeatModal extends Modal {
  constructor(plugin, novel, beat, isNew) {
    super(plugin.app);
    this.plugin = plugin; this.n = novel; this.beat = beat; this.isNew = isNew;
    this.d = clone(beat);
    this.focused = false;
    // Influence drafts as "novelId::beatId" keys, both directions, so links can cross novels.
    const novels = plugin.data.novels;
    this.d.influences = this.d.influences.map(i => ({ key: `${i.novel || novel.id}::${i.to}`, note: i.note || '' }));
    this.inc = isNew ? [] : XN.incoming(novels, novel, beat.id).map(x => ({ key: `${x.fromNovel.id}::${x.from.id}`, note: x.note || '' }));
  }
  onOpen() {
    this.modalEl.addClass('pw-modal', 'pw-beat-modal');
    this.titleEl.setText(this.isNew ? 'New event or idea' : 'Edit event');
    this.draw();
    this.contentEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.save(); }
    });
  }
  onClose() { this.contentEl.empty(); }

  /** Options for every event in the given novels (this one first), grouped by novel and plotline. */
  beatOptions(sel, novels) {
    for (const nv of novels) {
      const home = nv.id === this.n.id;
      const groups = [...nv.plotlines.map(p => ({ id: p.id, name: p.name })), { id: null, name: 'No plotline' }];
      for (const g of groups) {
        const items = nv.beats.filter(b => b.id !== this.d.id && (NV.plotline(nv, b.plotlineId) ? b.plotlineId : null) === g.id).sort(NV.chronoCmp(nv));
        if (!items.length) continue;
        const og = sel.createEl('optgroup');
        og.label = home ? g.name : `${nv.title} › ${g.name}`;
        for (const b of items) {
          const flags = [b.offscreen ? 'off-screen' : '', b.status === 'parked' ? 'later' : '', b.status === 'archived' ? 'archived' : ''].filter(Boolean);
          og.createEl('option', { value: `${nv.id}::${b.id}`, text: b.title + (flags.length ? ` (${flags.join(', ')})` : '') });
        }
      }
    }
  }

  influenceList(c, heading, arrow, rows, novels, hint) {
    const block = c.createDiv('pw-inf-block');
    const head = block.createDiv('pw-inf-head');
    head.createSpan({ cls: 'pw-field-label', text: heading });
    if (novels.length > 1) head.createSpan({ cls: 'pw-muted', text: `  incl. ${novels.slice(1).map(x => x.title).join(', ')}` });
    const list = block.createDiv('pw-inf-list');
    rows.forEach((r, idx) => {
      const row = list.createDiv('pw-inf-row');
      row.createSpan({ cls: 'pw-inf-arrow', text: arrow });
      const sel = row.createEl('select', { cls: 'dropdown' });
      sel.createEl('option', { value: '', text: 'Choose an event…' });
      this.beatOptions(sel, novels);
      sel.value = r.key || '';
      sel.onchange = () => { r.key = sel.value; };
      const note = row.createEl('input', { type: 'text' });
      note.placeholder = 'How? (optional)';
      note.value = r.note || '';
      note.oninput = () => { r.note = note.value; };
      const rm = row.createDiv('pw-icon-btn');
      setIcon(rm, 'x');
      rm.setAttr('aria-label', 'Remove');
      rm.onclick = () => { rows.splice(idx, 1); this.draw(); };
    });
    const add = block.createEl('button', { text: `＋ ${hint}`, cls: 'pw-small-btn' });
    add.onclick = () => { rows.push({ key: '', note: '' }); this.draw(); };
  }

  draw() {
    const c = this.contentEl, d = this.d, n = this.n;
    c.empty();

    new Setting(c).setName('Title').addText(t => {
      t.setValue(d.title).onChange(v => { d.title = v; });
      t.inputEl.addClass('pw-wide');
      if (!this.focused) { this.focused = true; setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 20); }
    });

    const sum = c.createDiv('pw-field');
    sum.createDiv({ cls: 'pw-field-label', text: 'Summary' });
    const ta = sum.createEl('textarea', { cls: 'pw-textarea' });
    ta.rows = 4; ta.value = d.summary; ta.placeholder = 'What happens? What changes?';
    ta.oninput = () => { d.summary = ta.value; };

    new Setting(c).setName('Plotline').addDropdown(dd => {
      dd.addOption('', '— none —');
      n.plotlines.forEach(p => dd.addOption(p.id, p.name + (p.archived ? ' (archived)' : '')));
      dd.setValue(NV.plotline(n, d.plotlineId) ? d.plotlineId : '');
      dd.onChange(v => { d.plotlineId = v || null; });
    });

    new Setting(c).setName('Point of view').setDesc('Whose eyes we see this through.').addDropdown(dd => {
      dd.addOption('', '— none / omniscient —');
      n.povs.forEach(p => dd.addOption(p.id, p.name));
      dd.addOption('__new', '＋ New POV character…');
      dd.setValue(NV.pov(n, d.povId) ? d.povId : '');
      dd.onChange(v => {
        if (v !== '__new') { d.povId = v || null; return; }
        dd.setValue(d.povId || '');
        new TextPromptModal(this.app, 'New POV character', 'Name', '', name => {
          const pov = { id: uid(), name, color: nextColor(n.povs.map(x => x.color)) };
          n.povs.push(pov);
          d.povId = pov.id;
          this.plugin.commit();
          this.draw();
        }).open();
      });
    });

    new Setting(c).setName('When (story time)').setDesc('The event or moment in the story world this belongs to.').addDropdown(dd => {
      dd.addOption('', '— not placed in time —');
      n.slots.forEach((s, i) => dd.addOption(s.id, `${i + 1}. ${s.label}`));
      dd.setValue(NV.slot(n, d.slotId) ? d.slotId : '');
      dd.onChange(v => { d.slotId = v || null; });
    });

    new Setting(c).setName('Chapter or section')
      .setDesc(d.offscreen ? 'Off-screen events aren’t part of the manuscript.' : 'Assign when you’re ready. Putting a card in a Part makes it that part’s summary.')
      .addDropdown(dd => {
        dd.addOption('', '— no chapter yet —');
        n.chapters.forEach(ch => {
          const kind = NV.kind(ch);
          const indent = kind !== 'part' && NV.partOf(n, ch.id) && kind !== 'prologue' && kind !== 'epilogue' ? '   ' : '';
          dd.addOption(ch.id, indent + (kind === 'part' ? `${ch.title}  (summary)` : ch.title));
        });
        for (const k of SECTION_KINDS) dd.addOption(`__new:${k.key}`, `＋ New ${k.label.toLowerCase()}…`);
        dd.setValue(NV.chapter(n, d.chapterId) ? d.chapterId : '');
        dd.selectEl.disabled = !!d.offscreen;
        dd.onChange(v => {
          if (!v.startsWith('__new:')) { d.chapterId = v || null; return; }
          dd.setValue(d.chapterId || '');
          this.plugin.addSection(n, v.slice(6), null, sec => { d.chapterId = sec.id; this.draw(); });
        });
      });


    new Setting(c).setName('Off-screen')
      .setDesc('Happens in the story world but isn’t shown on the page. It still sits on its plotline, appears in the outline at its point in story time, and can influence other events.')
      .addToggle(t => t.setValue(!!d.offscreen).onChange(v => { d.offscreen = v; this.draw(); }));

    new Setting(c).setName('Status').addDropdown(dd => dd
      .addOption('active', 'Active').addOption('parked', 'Saved for later').addOption('archived', 'Archived')
      .setValue(d.status).onChange(v => { d.status = v; }));

    c.createEl('h4', { text: 'Influences', cls: 'pw-h' });
    const novels = this.plugin.data.novels;
    const up = XN.upstream(novels, n), down = XN.downstream(novels, n);
    c.createDiv({ cls: 'pw-muted', text: 'Cause and effect between events: across plotlines, and across linked novels (a worldbuilding history, an earlier book).' });
    this.influenceList(c, 'Shaped by', '← from', this.inc, [n, ...up], 'Add a cause');
    this.influenceList(c, 'Leads to', 'leads to →', d.influences, [n, ...down], 'Add an effect');
    if (novels.length > 1 && !up.length && !down.length) {
      c.createDiv({ cls: 'pw-muted pw-inf-tip', text: 'Tip: link novels in Manage → Novel → Linked novels to connect events across books.' });
    }

    if (!this.isNew) {
      const s = new Setting(c).setName('Linked note').setDesc(d.notePath || 'No note yet. Create one from a template, or link a note you already have.');
      if (d.notePath) {
        s.addButton(b => b.setButtonText('Open note').onClick(() => { this.save(); this.plugin.openNote(n, this.beat); }));
      } else {
        s.addButton(b => b.setButtonText('Link existing…').onClick(() => { this.save(); this.plugin.linkExistingNote(n, this.beat); }));
        s.addButton(b => b.setButtonText('Create note…').setCta().onClick(() => { this.save(); this.plugin.createNoteFlow(n, this.beat); }));
      }
    }

    const foot = c.createDiv('pw-modal-footer');
    if (!this.isNew) {
      const del = foot.createEl('button', { text: 'Delete', cls: 'mod-warning' });
      del.onclick = () => { this.close(); this.plugin.deleteBeat(n, this.beat); };
    }
    foot.createDiv('pw-spacer');
    foot.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    const save = foot.createEl('button', { text: this.isNew ? 'Create' : 'Save', cls: 'mod-cta' });
    save.onclick = () => this.save();
  }

  save() {
    const d = this.d, n = this.n, b = this.beat;
    d.title = (d.title || '').trim() || 'Untitled';
    const novels = this.plugin.data.novels;
    const parse = k => { const [nid, bid] = String(k || '').split('::'); return { nid, bid }; };
    const seen = new Set();
    d.influences = d.influences.filter(i => i.key && !seen.has(i.key) && seen.add(i.key)).map(i => {
      const { nid, bid } = parse(i.key);
      const o = { to: bid, note: i.note || '' };
      if (nid !== n.id) o.novel = nid;
      return o;
    }).filter(o => o.to && o.to !== d.id);
    const moved = this.isNew || d.slotId !== b.slotId || d.plotlineId !== b.plotlineId;
    if (moved && d.slotId && d.plotlineId) d.order = NV.nextOrder(n, d.slotId, d.plotlineId);
    if (this.isNew || d.status !== b.status || (moved && !d.slotId)) d.shelfOrder = Date.now();
    const chapterChanged = !this.isNew && (d.chapterId || null) !== (b.chapterId || null);
    Object.assign(b, d);
    if (this.isNew) n.beats.push(b);
    if (chapterChanged) n.manuscriptOrder = n.manuscriptOrder.filter(x => x !== b.id); // re-slot by story time within its new chapter
    // "Shaped by" links live on their causes (which may be in other novels): rewrite them.
    for (const nv of novels) for (const src of nv.beats) {
      if (src.id !== b.id) src.influences = src.influences.filter(i => !(i.to === b.id && XN.targetNovelId(nv, i) === n.id));
    }
    const seenIn = new Set();
    for (const r of this.inc) {
      if (!r.key || seenIn.has(r.key)) continue;
      seenIn.add(r.key);
      const { nid, bid } = parse(r.key);
      const nv = XN.novel(novels, nid), src = nv && NV.beat(nv, bid);
      if (!src || src.id === b.id) continue;
      const o = { to: b.id, note: r.note || '' };
      if (nv.id !== n.id) o.novel = n.id;
      src.influences.push(o);
    }
    this.isNew = false;
    this.plugin.commit();
    this.close();
  }
}

class ManageModal extends Modal {
  constructor(plugin, tab) { super(plugin.app); this.plugin = plugin; this.tab = tab || 'plotlines'; }
  get n() { return this.plugin.activeNovel(); }
  onOpen() { this.modalEl.addClass('pw-modal', 'pw-manage'); this.titleEl.setText('Manage novel'); this.draw(); }
  onClose() { this.contentEl.empty(); this.plugin.commit(); }
  soft() { this.plugin.requestSave(); this.plugin.refreshViewsSoon(); }
  hard() { this.plugin.commit(); this.draw(); }

  draw() {
    const c = this.contentEl;
    c.empty();
    const tabs = c.createDiv('pw-mtabs');
    for (const [k, label] of [['novel', 'Novel'], ['plotlines', 'Plotlines'], ['povs', 'POV characters'], ['slots', 'Story time'], ['chapters', 'Chapters & parts']]) {
      const t = tabs.createDiv({ cls: 'pw-mtab', text: label });
      t.toggleClass('is-active', this.tab === k);
      t.onclick = () => { this.tab = k; this.draw(); };
    }
    const body = c.createDiv('pw-mbody');
    this['draw_' + this.tab](body);
  }

  rowButtons(row, arr, i) {
    const up = row.createDiv('pw-icon-btn'); setIcon(up, 'arrow-up'); up.setAttr('aria-label', 'Move up');
    up.onclick = () => { NV.moveItem(arr, i, i - 1); this.hard(); };
    const dn = row.createDiv('pw-icon-btn'); setIcon(dn, 'arrow-down'); dn.setAttr('aria-label', 'Move down');
    dn.onclick = () => { NV.moveItem(arr, i, i + 1); this.hard(); };
  }

  draw_novel(c) {
    const n = this.n;
    new Setting(c).setName('Title').addText(t => t.setValue(n.title).onChange(v => { n.title = v || 'Untitled'; this.soft(); }));
    const active = n.beats.filter(b => NV.onBoard(n, b)).length;
    c.createDiv({ cls: 'pw-muted', text: `${plural(active, 'event')} on the board · ${plural(n.chapters.length, 'chapter')} · ${plural(NV.shelf(n, 'unplaced').length, 'unplaced idea')} · ${NV.shelf(n, 'parked').length} saved for later · ${NV.shelf(n, 'archived').length} archived` });
    new Setting(c).setName('New novel').setDesc('Start a separate project. Switch between novels from the toolbar.')
      .addButton(b => b.setButtonText('New novel').onClick(() => {
        new TextPromptModal(this.app, 'New novel', 'Title', '', title => { this.plugin.addNovel(makeNovel(title)); this.draw(); }).open();
      }));
    new Setting(c).setName('Example series').setDesc('Add a small linked example: a worldbuilding history, Book 1 and Book 2, with off-screen events, influences across books, chapters and multiple POVs.')
      .addButton(b => b.setButtonText('Add example').onClick(() => { this.plugin.addSeries(makeExampleSeries()); this.draw(); }));

    const novels = this.plugin.data.novels;
    const others = novels.filter(x => x.id !== n.id);
    c.createEl('h4', { text: 'Linked novels', cls: 'pw-h' });
    if (!others.length) {
      c.createDiv({ cls: 'pw-muted', text: 'Create another novel (for example a worldbuilding history, or the previous book in a series) to link it here.' });
    } else {
      c.createDiv({ cls: 'pw-muted', text: `Choose the novels “${n.title}” draws on. Their events can then shape events here: pick them under “Shaped by” in an event’s edit dialog. They appear in a “From linked novels” column on the board.` });
      for (const o of others) {
        const on = (n.links || []).includes(o.id);
        const reverse = (o.links || []).includes(n.id);
        new Setting(c).setName(o.title)
          .setDesc(reverse ? `Already draws on “${n.title}”.` : (on ? 'Draws on this novel.' : ''))
          .addToggle(t => t.setValue(on).onChange(v => {
            n.links = (n.links || []).filter(x => x !== o.id);
            if (v) n.links.push(o.id);
            this.hard();
          }));
      }
      const down = XN.downstream(novels, n);
      if (down.length) c.createDiv({ cls: 'pw-muted', text: `Shapes: ${down.map(x => x.title).join(', ')}` });
    }
    new Setting(c).setName('Delete this novel').setDesc('Permanently removes this novel’s outline. Linked notes in your vault are kept.')
      .addButton(b => b.setButtonText('Delete novel').setWarning().onClick(() => {
        new ConfirmModal(this.app, 'Delete novel?', `Delete “${n.title}” and its whole outline? This can’t be undone.`, 'Delete novel', () => {
          this.plugin.deleteNovel(n.id); this.draw();
        }).open();
      }));
  }

  draw_plotlines(c) {
    const n = this.n;
    c.createDiv({ cls: 'pw-muted', text: 'Plotlines are the rows of the board: threads that run side by side. Archive one to hide it without losing anything.' });
    n.plotlines.forEach((p, i) => {
      const row = c.createDiv('pw-mrow');
      row.toggleClass('is-archived', p.archived);
      const ci = row.createEl('input', { type: 'color' });
      ci.value = p.color; ci.onchange = () => { p.color = ci.value; this.soft(); };
      const name = row.createEl('input', { type: 'text', cls: 'pw-mname' });
      name.value = p.name; name.oninput = () => { p.name = name.value || 'Untitled'; this.soft(); };
      const desc = row.createEl('input', { type: 'text', cls: 'pw-mdesc' });
      desc.placeholder = 'What is this thread about?'; desc.value = p.description || '';
      desc.oninput = () => { p.description = desc.value; this.soft(); };
      row.createSpan({ cls: 'pw-count', text: String(n.beats.filter(b => b.plotlineId === p.id).length) });
      this.rowButtons(row, n.plotlines, i);
      const ar = row.createDiv('pw-icon-btn'); setIcon(ar, p.archived ? 'archive-restore' : 'archive');
      ar.setAttr('aria-label', p.archived ? 'Unarchive' : 'Archive');
      ar.onclick = () => { p.archived = !p.archived; this.hard(); };
      const del = row.createDiv('pw-icon-btn pw-danger'); setIcon(del, 'trash-2'); del.setAttr('aria-label', 'Delete');
      del.onclick = () => this.plugin.deletePlotline(n, p, () => this.draw());
    });
    c.createEl('button', { text: '＋ Add plotline', cls: 'pw-small-btn' }).onclick = () => {
      n.plotlines.push({ id: uid(), name: 'New plotline', color: nextColor(n.plotlines.map(p => p.color)), description: '', archived: false, collapsed: false });
      this.hard();
    };
  }

  draw_povs(c) {
    const n = this.n;
    c.createDiv({ cls: 'pw-muted', text: 'Viewpoint characters. Each scene can have one POV; filter the board by POV from the toolbar.' });
    n.povs.forEach((p, i) => {
      const row = c.createDiv('pw-mrow');
      const ci = row.createEl('input', { type: 'color' });
      ci.value = p.color; ci.onchange = () => { p.color = ci.value; this.soft(); };
      const name = row.createEl('input', { type: 'text', cls: 'pw-mname' });
      name.value = p.name; name.oninput = () => { p.name = name.value || 'Unnamed'; this.soft(); };
      row.createSpan({ cls: 'pw-count', text: plural(n.beats.filter(b => b.povId === p.id).length, 'scene') });
      this.rowButtons(row, n.povs, i);
      const del = row.createDiv('pw-icon-btn pw-danger'); setIcon(del, 'trash-2'); del.setAttr('aria-label', 'Delete');
      del.onclick = () => {
        new ConfirmModal(this.app, 'Delete POV character?', `Remove “${p.name}”? Their scenes stay, with no POV set.`, 'Delete', () => {
          n.povs = n.povs.filter(x => x.id !== p.id);
          n.beats.forEach(b => { if (b.povId === p.id) b.povId = null; });
          this.hard();
        }).open();
      };
    });
    c.createEl('button', { text: '＋ Add POV character', cls: 'pw-small-btn' }).onclick = () => {
      n.povs.push({ id: uid(), name: 'New character', color: nextColor(n.povs.map(p => p.color)) });
      this.hard();
    };
  }

  draw_slots(c) {
    const n = this.n;
    c.createDiv({ cls: 'pw-muted', text: 'Story time: the general events and moments of your story world, in chronological order. They are not chapters — name them however helps you plan (“The wedding”, “Day 3”, “Ten years earlier”).' });
    n.slots.forEach((s, i) => {
      const row = c.createDiv('pw-mrow');
      row.createSpan({ cls: 'pw-slot-num', text: String(i + 1) });
      const name = row.createEl('input', { type: 'text', cls: 'pw-mname' });
      name.value = s.label; name.oninput = () => { s.label = name.value || 'Untitled'; this.soft(); };
      row.createSpan({ cls: 'pw-count', text: String(n.beats.filter(b => b.slotId === s.id && b.status === 'active').length) });
      this.rowButtons(row, n.slots, i);
      const del = row.createDiv('pw-icon-btn pw-danger'); setIcon(del, 'trash-2'); del.setAttr('aria-label', 'Delete');
      del.onclick = () => this.plugin.deleteSlot(n, s, () => this.draw());
    });
    c.createEl('button', { text: '＋ Add story event', cls: 'pw-small-btn' }).onclick = () => {
      n.slots.push({ id: uid(), label: `Event ${n.slots.length + 1}` });
      this.hard();
    };
  }

  draw_chapters(c) {
    const n = this.n;
    c.createDiv({ cls: 'pw-muted', text: 'The manuscript’s structure in reading order. A Part groups the chapters and interludes after it; a card assigned to a Part becomes its summary. Prologues and epilogues stand outside parts.' });
    n.chapters.forEach((ch, i) => {
      const kind = NV.kind(ch);
      const row = c.createDiv('pw-mrow');
      row.toggleClass('is-part', kind === 'part');
      row.toggleClass('is-in-part', kind !== 'part' && kind !== 'prologue' && kind !== 'epilogue' && !!NV.partOf(n, ch.id));
      const sel = row.createEl('select', { cls: 'dropdown pw-kind-select' });
      for (const k of SECTION_KINDS) sel.createEl('option', { value: k.key, text: k.label });
      sel.value = kind;
      sel.onchange = () => this.plugin.setSectionKind(n, ch, sel.value, () => this.draw());
      const name = row.createEl('input', { type: 'text', cls: 'pw-mname' });
      name.value = ch.title; name.oninput = () => { ch.title = name.value || 'Untitled'; this.soft(); };
      const cnt = n.beats.filter(b => b.chapterId === ch.id && NV.onBoard(n, b)).length;
      row.createSpan({ cls: 'pw-count', text: kind === 'part' ? (cnt ? 'summary' : '—') : plural(cnt, 'scene') });
      this.rowButtons(row, n.chapters, i);
      const del = row.createDiv('pw-icon-btn pw-danger'); setIcon(del, 'trash-2'); del.setAttr('aria-label', 'Delete');
      del.onclick = () => this.plugin.deleteChapter(n, ch, () => this.draw());
    });
    if (!n.chapters.length) c.createDiv({ cls: 'pw-empty', text: 'No chapters yet. Plan in story time first, and add chapters when you’re ready.' });
    const adds = c.createDiv('pw-add-kinds');
    for (const k of SECTION_KINDS) {
      adds.createEl('button', { text: `＋ ${k.label}`, cls: 'pw-small-btn' }).onclick = () => {
        const sec = { id: uid(), title: NV.defaultSectionTitle(n, k.key), kind: k.key };
        if (k.key === 'prologue') n.chapters.unshift(sec); else n.chapters.push(sec);
        this.hard();
      };
    }
  }
}

/* -------------------------------------------------------------------- view */

class PlotWeaverView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.drag = null;
    this.cardEls = new Map();
    this.indicator = null;
    this.gridEl = null;
    this.svgEl = null;
    this.arrowFrame = 0;
    this.markerKey = uid();
    this.shelfQuery = '';
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Plot Weaver'; }
  getIcon() { return 'git-fork'; }
  get ui() { return this.plugin.data.ui; }
  get novel() { return this.plugin.activeNovel(); }
  get byChapter() { return this.ui.columns === 'chapters'; }
  get novels() { return this.plugin.data.novels; }
  /** The novel an event belongs to: this one, or a linked novel shown in the "From linked novels" column. */
  homeOf(b) { return (this.extHome && this.extHome.get(b.id)) || this.novel; }
  findBeat(id) {
    const n = this.novel;
    const b = NV.beat(n, id);
    if (b) return { b, home: n };
    const home = this.extHome && this.extHome.get(id);
    return home ? { b: NV.beat(home, id), home } : null;
  }

  async onOpen() {
    this.contentEl.addClass('pw-root');
    this.registerDomEvent(document, 'keydown', e => {
      if (e.key !== 'Escape' || !this.fsHost) return;
      if (document.querySelector('.modal-container, .menu')) return; // let dialogs and menus handle their own Esc
      e.preventDefault();
      this.setFullscreen(false);
    });
    this.registerDomEvent(window, 'resize', () => { if (this.fsHost) this.scheduleArrows(); });
    this.render();
  }
  async onClose() { this.setFullscreen(false, true); this.contentEl.empty(); }
  onResize() { this.scheduleArrows(); }

  /**
   * Full screen: the board is lifted out of its tab into an overlay covering the whole Obsidian window
   * (so Obsidian's dialogs and menus, which live on <body>, still appear above it), and the window itself
   * goes full screen where the platform allows.
   */
  get isFullscreen() { return !!this.fsHost; }
  setFullscreen(on, quiet) {
    if (on && !this.fsHost) {
      this.fsHost = document.body.createDiv('pw-fs-host');
      this.fsHost.appendChild(this.contentEl);
      this.contentEl.addClass('is-fullscreen');
      this.fsWindow = false;
      const want = this.plugin.data.settings.fullscreenWindow;
      if (want && document.fullscreenEnabled && !document.fullscreenElement && document.documentElement.requestFullscreen) {
        try {
          const pr = document.documentElement.requestFullscreen();
          this.fsWindow = true;
          if (pr && pr.catch) pr.catch(() => { this.fsWindow = false; });
        } catch (err) { this.fsWindow = false; }
      }
    } else if (!on && this.fsHost) {
      this.containerEl.appendChild(this.contentEl);
      this.contentEl.removeClass('is-fullscreen');
      this.fsHost.remove();
      this.fsHost = null;
      if (this.fsWindow && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      this.fsWindow = false;
    } else {
      return;
    }
    if (!quiet) this.render();
  }

  setUi(patch) { Object.assign(this.ui, patch); this.plugin.commit(); }

  render() {
    const root = this.contentEl;
    const keep = {
      bl: this.boardScroller && this.boardScroller.scrollLeft, bt: this.boardScroller && this.boardScroller.scrollTop,
      ot: this.outlineScroller && this.outlineScroller.scrollTop, st: this.shelfList && this.shelfList.scrollTop,
    };
    root.empty();
    this.cardEls.clear();
    this.boardScroller = this.outlineScroller = this.shelfList = this.gridEl = this.svgEl = null;
    const s = this.plugin.data.settings;
    root.style.setProperty('--pw-col-w', `${s.columnWidth}px`);
    root.style.setProperty('--pw-lane-w', `${s.laneWidth}px`);

    const n = this.novel;
    this.renderToolbar(root.createDiv('pw-toolbar'), n);
    const body = root.createDiv('pw-body');
    const main = body.createDiv('pw-main');
    if (this.ui.mode === 'outline') this.renderOutline(main, n);
    else this.renderBoard(main, n);
    if (this.ui.shelfCollapsed) this.renderShelfRail(body.createDiv('pw-shelf-rail'), n);
    else this.renderShelf(body.createDiv('pw-shelf'), n);

    if (this.boardScroller) { this.boardScroller.scrollLeft = keep.bl || 0; this.boardScroller.scrollTop = keep.bt || 0; }
    if (this.outlineScroller) this.outlineScroller.scrollTop = keep.ot || 0;
    if (this.shelfList) this.shelfList.scrollTop = keep.st || 0;
    this.scheduleArrows();
  }

  /* ---------- toolbar */

  tbButton(parent, icon, label, onClick, active, tip) {
    const b = parent.createEl('button', { cls: 'pw-btn' });
    if (active !== undefined) b.toggleClass('is-active', !!active);
    setIcon(b.createSpan('pw-btn-icon'), icon);
    if (label) b.createSpan({ cls: 'pw-btn-label', text: label });
    if (tip) b.setAttr('aria-label', tip);
    b.onclick = onClick;
    return b;
  }

  renderToolbar(bar, n) {
    const g1 = bar.createDiv('pw-tb-group');
    const sel = g1.createEl('select', { cls: 'dropdown pw-novel-select' });
    for (const nv of this.plugin.data.novels) sel.createEl('option', { value: nv.id, text: nv.title });
    sel.createEl('option', { value: '__new', text: '＋ New novel…' });
    sel.value = n.id;
    sel.onchange = () => {
      if (sel.value === '__new') {
        sel.value = n.id;
        new TextPromptModal(this.app, 'New novel', 'Title', '', title => this.plugin.addNovel(makeNovel(title))).open();
      } else {
        this.plugin.data.activeNovelId = sel.value;
        this.plugin.commit();
      }
    };
    if (this.novels.length > 1) {
      const up = XN.upstream(this.novels, n);
      const chip = g1.createDiv('pw-links-chip');
      setIcon(chip.createSpan('pw-btn-icon'), 'link');
      chip.createSpan({ cls: 'pw-links-text', text: up.length ? `Draws on ${up.map(x => x.title).join(', ')}` : 'Link novels…' });
      chip.setAttr('aria-label', up.length ? 'Linked novels whose events shape this one (click to change)' : 'Let this novel draw on others: a worldbuilding history, an earlier book');
      chip.toggleClass('is-empty', !up.length);
      chip.onclick = () => new ManageModal(this.plugin, 'novel').open();
    }
    const seg = g1.createDiv('pw-seg');
    this.tbButton(seg, 'layout-grid', 'Board', () => this.setUi({ mode: 'board' }), this.ui.mode !== 'outline', 'Board: plotlines × story time or chapters');
    this.tbButton(seg, 'list-ordered', 'Outline', () => this.setUi({ mode: 'outline' }), this.ui.mode === 'outline', 'Manuscript order, grouped by chapter');

    if (this.ui.mode !== 'outline') {
      const cols = g1.createDiv('pw-seg pw-seg-cols');
      cols.createSpan({ cls: 'pw-seg-label', text: 'Columns' });
      this.tbButton(cols, 'clock', 'Story time', () => this.setUi({ columns: 'time' }), !this.byChapter, 'Columns are story-world events, in chronological order (for loose planning)');
      this.tbButton(cols, 'book-open', 'Chapters', () => this.setUi({ columns: 'chapters' }), this.byChapter, 'Columns are chapters, in reading order — drag scenes in to assign them');
    }

    const g2 = bar.createDiv('pw-tb-group');
    const pov = g2.createEl('select', { cls: 'dropdown' });
    pov.createEl('option', { value: 'all', text: 'All POVs' });
    for (const p of n.povs) pov.createEl('option', { value: p.id, text: `POV: ${p.name}` });
    pov.createEl('option', { value: 'none', text: 'No POV set' });
    const valid = this.ui.povFilter === 'all' || this.ui.povFilter === 'none' || NV.pov(n, this.ui.povFilter);
    pov.value = valid ? this.ui.povFilter : 'all';
    pov.onchange = () => this.setUi({ povFilter: pov.value });
    this.tbButton(g2, 'eye-off', 'Off-screen', () => this.setUi({ showOffscreen: !this.ui.showOffscreen }), this.ui.showOffscreen, 'Show off-screen events (board and outline)');
    this.tbButton(g2, 'git-merge', 'Influences', () => this.setUi({ showArrows: !this.ui.showArrows }), this.ui.showArrows, 'Draw cause-and-effect arrows');
    this.tbButton(g2, 'inbox', 'Shelf', () => this.setUi({ shelfCollapsed: !this.ui.shelfCollapsed }), !this.ui.shelfCollapsed, this.ui.shelfCollapsed ? 'Expand the idea shelf' : 'Collapse the idea shelf');

    const g3 = bar.createDiv('pw-tb-group pw-tb-actions');
    this.tbButton(g3, 'plus', 'Idea', () => this.newBeat({}), undefined, 'New event or idea');
    this.tbButton(g3, 'rows-3', 'Plotline', () => this.plugin.addPlotline(n), undefined, 'Add a plotline (row)');
    if (this.byChapter || this.ui.mode === 'outline') {
      const secBtn = this.tbButton(g3, 'book-open', 'Section', () => {}, undefined, 'Add a chapter, part, prologue, interlude or epilogue');
      secBtn.onclick = e => this.plugin.addSectionMenu(n, n.chapters.length, e);
    }
    else this.tbButton(g3, 'columns-3', 'Story event', () => this.plugin.addSlot(n, n.slots.length), undefined, 'Add a story-time event (column)');
    this.tbButton(g3, 'settings', '', () => new ManageModal(this.plugin).open(), undefined, 'Manage plotlines, POVs, story time, chapters and novels');
    this.tbButton(g3, 'file-output', '', () => this.plugin.exportOutline(n), undefined, 'Export outline to a note');
    const fs = this.tbButton(g3, this.isFullscreen ? 'minimize-2' : 'maximize-2', '', () => this.setFullscreen(!this.isFullscreen),
      this.isFullscreen, this.isFullscreen ? 'Exit full screen (Esc)' : 'Full screen');
    fs.addClass('pw-fs-btn');
  }

  matchesPov(b) {
    const f = this.ui.povFilter;
    if (!f || f === 'all') return true;
    if (f === 'none') return !b.povId;
    return b.povId === f;
  }

  newBeat(preset) {
    const b = makeBeat(preset);
    new BeatModal(this.plugin, this.novel, b, true).open();
  }
  editBeat(b) { new BeatModal(this.plugin, this.novel, b, false).open(); }

  /* ---------- board */

  renderBoard(main, n) {
    const scroller = main.createDiv('pw-board-scroll');
    this.boardScroller = scroller;
    const lanes = n.plotlines.filter(p => !p.archived);
    const byChapter = this.byChapter;
    let cols;
    if (byChapter) {
      cols = n.chapters.map((c, i) => ({ id: c.id, label: c.title, item: c, i, kind: NV.kind(c) }));
      cols.push({ id: null, label: 'No chapter yet', staging: true, hint: 'On-screen scenes placed in story time but not yet in a chapter. Drag them into a chapter when you’re ready.' });
    } else {
      cols = n.slots.map((s, i) => ({ id: s.id, label: s.label, item: s, i }));
      if (n.beats.some(b => NV.onBoard(n, b) && !NV.timeOf(n, b))) {
        cols.push({ id: null, label: 'No story time yet', staging: true, hint: 'Scenes assigned to a chapter but not yet placed in story time.' });
      }
    }

    // Events in linked novels that shape this one sit in a lead column, level with the plotline they affect.
    const ext = XN.externals(this.novels, n);
    this.extHome = new Map();
    const extByLane = new Map(lanes.map(p => [p.id, []]));
    const cmp = NV.chronoCmp(n);
    for (const g of ext) {
      for (const b of g.beats) {
        this.extHome.set(b.id, g.novel);
        const targets = b.influences.filter(i => i.novel === n.id).map(i => NV.beat(n, i.to))
          .filter(t => t && extByLane.has(t.plotlineId) && NV.onBoard(n, t)).sort(cmp);
        const laneId = targets.length ? targets[0].plotlineId : (lanes[0] && lanes[0].id);
        if (laneId) extByLane.get(laneId).push({ b, nv: g.novel });
      }
    }
    const lead = [...extByLane.values()].some(list => list.length);

    const grid = scroller.createDiv('pw-grid');
    this.gridEl = grid;
    grid.style.gridTemplateColumns = `var(--pw-lane-w) ${lead ? 'var(--pw-col-w) ' : ''}repeat(${cols.length}, var(--pw-col-w)) 56px`;

    const corner = grid.createDiv('pw-corner');
    corner.createDiv({ cls: 'pw-corner-x', text: byChapter ? 'Chapters →' : 'Story time →' });
    corner.createDiv({ cls: 'pw-corner-y', text: 'Plotlines ↓' });
    if (lead) {
      const lh = grid.createDiv('pw-slot-header pw-lead-header');
      setIcon(lh.createSpan('pw-btn-icon'), 'link');
      lh.createSpan({ cls: 'pw-slot-label', text: 'From linked novels' });
      lh.setAttr('aria-label', 'Events in linked novels (worldbuilding, earlier books) that shape this one');
    }
    for (const col of cols) this.renderColHeader(grid, n, col, byChapter);
    const addCol = grid.createDiv('pw-add-col');
    setIcon(addCol, 'plus');
    addCol.setAttr('aria-label', byChapter ? 'Add chapter' : 'Add story-time event');
    addCol.onclick = e => (byChapter ? this.plugin.addSectionMenu(n, n.chapters.length, e) : this.plugin.addSlot(n, n.slots.length));

    for (const p of lanes) {
      this.renderLaneHeader(grid, n, p);
      if (lead) this.renderLeadCell(grid, p, extByLane.get(p.id));
      for (const col of cols) this.renderCell(grid, n, p, col, byChapter);
      grid.createDiv('pw-cell-filler');
    }
    const addLane = grid.createDiv('pw-add-lane');
    addLane.style.gridColumn = '1 / -1';
    const ab = addLane.createEl('button', { cls: 'pw-small-btn', text: '＋ Add plotline' });
    ab.onclick = () => this.plugin.addPlotline(n);
    const hidden = n.plotlines.length - lanes.length;
    if (hidden) addLane.createSpan({ cls: 'pw-muted', text: `  ${plural(hidden, 'archived plotline')} hidden (Manage → Plotlines)` });
    const quiet = ext.filter(g => !g.beats.length);
    if (quiet.length) {
      addLane.createSpan({ cls: 'pw-muted', text: `  · Draws on ${quiet.map(g => `“${g.novel.title}”`).join(', ')}: no events link here yet (add one under “Shaped by” in an event’s edit dialog).` });
    }
    if (byChapter) {
      const off = n.beats.filter(b => NV.onBoard(n, b) && b.offscreen).length;
      if (off) addLane.createSpan({ cls: 'pw-muted', text: `  · ${plural(off, 'off-screen event')} not shown — they aren’t part of chapters (see Story time or Outline)` });
      if (!n.chapters.length) addLane.createSpan({ cls: 'pw-muted', text: '  · No chapters yet: add one with ＋ at the top right.' });
    }

    if (this.ui.showArrows && n.beats.length) {
      const lg = addLane.createDiv('pw-legend');
      const item = (cls, text) => { const it = lg.createSpan('pw-legend-item'); it.createSpan(cls); it.createSpan({ text }); };
      item('pw-lg-solid', 'cause → effect');
      item('pw-lg-dashed', 'off-screen cause');
      lg.createSpan({ cls: 'pw-legend-hint', text: 'Hover a card to trace its links. Drag a card’s → handle onto another card to link them.' });
    }

    this.svgEl = svg('svg', { class: 'pw-svg' });
    grid.appendChild(this.svgEl);
  }

  renderLeadCell(grid, p, items) {
    const cell = grid.createDiv('pw-cell pw-lead-cell');
    if (!items.length) { cell.addClass('pw-lead-empty'); return; }
    if (p.collapsed) {
      cell.addClass('pw-collapsed');
      const chip = cell.createDiv({ cls: 'pw-collapsed-count', text: plural(items.length, 'linked event') });
      chip.setAttr('aria-label', items.map(x => `${x.nv.title} › ${x.b.title}`).join('\n'));
      items.forEach(x => this.cardEls.set(x.b.id, chip));
      return;
    }
    for (const x of items) this.renderCard(cell, x.nv, x.b, 'external');
  }

  externalMenu(e, nv, b) {
    const m = new Menu();
    m.addItem(it => it.setTitle(`Edit (in “${nv.title}”)…`).setIcon('pencil').onClick(() => new BeatModal(this.plugin, nv, b, false).open()));
    if (b.notePath) m.addItem(it => it.setTitle('Open linked note').setIcon('file-text').onClick(() => this.plugin.openNote(nv, b)));
    m.addItem(it => it.setTitle(`Go to “${nv.title}”`).setIcon('arrow-right').onClick(() => this.plugin.openNovel(nv.id)));
    m.addSeparator();
    m.addItem(it => it.setTitle('Linked novels…').setIcon('link').onClick(() => new ManageModal(this.plugin, 'novel').open()));
    m.showAtMouseEvent(e);
  }

  renderColHeader(grid, n, col, byChapter) {
    const h = grid.createDiv('pw-slot-header');
    if (byChapter) h.addClass('pw-chapter-header');
    if (col.staging) {
      h.addClass('pw-staging-header');
      h.createSpan({ cls: 'pw-slot-label', text: col.label });
      h.setAttr('aria-label', col.hint);
      return;
    }
    if (byChapter && col.item) {
      const k = NV.kindInfo(col.item);
      h.addClass(`pw-kind-${k.key}`);
      const ic = h.createSpan('pw-kind-icon');
      setIcon(ic, k.icon);
      ic.setAttr('aria-label', k.label);
    } else {
      h.createSpan({ cls: 'pw-slot-num', text: String(col.i + 1) });
    }
    const label = h.createSpan({ cls: 'pw-slot-label', text: col.label || 'Untitled' });
    label.setAttr('aria-label', 'Double-click to rename · drag to reorder');
    const count = byChapter
      ? n.beats.filter(b => b.chapterId === col.id && NV.onBoard(n, b) && NV.hasChapter(n, b)).length
      : n.beats.filter(b => b.slotId === col.id && NV.onBoard(n, b)).length;
    if (count) h.createSpan({ cls: 'pw-count', text: String(count) });
    const more = h.createDiv('pw-icon-btn');
    setIcon(more, 'more-horizontal');
    const arr = byChapter ? n.chapters : n.slots;
    const i = col.i;
    const noun = byChapter ? NV.kindInfo(col.item).label.toLowerCase() : 'event';
    const rename = () => (byChapter ? this.plugin.renameChapter(n, col.item) : this.plugin.renameSlot(n, col.item));
    const add = at => (byChapter ? this.plugin.addSectionMenu(n, at, null) : this.plugin.addSlot(n, at));
    const menu = e => {
      const m = new Menu();
      m.addItem(it => it.setTitle('Rename').setIcon('pencil').onClick(rename));
      m.addItem(it => it.setTitle(`Insert ${noun} before`).setIcon('arrow-left').onClick(() => add(i)));
      m.addItem(it => it.setTitle(`Insert ${noun} after`).setIcon('arrow-right').onClick(() => add(i + 1)));
      m.addSeparator();
      m.addItem(it => it.setTitle('Move left').setIcon('chevron-left').onClick(() => { NV.moveItem(arr, i, i - 1); this.plugin.commit(); }));
      m.addItem(it => it.setTitle('Move right').setIcon('chevron-right').onClick(() => { NV.moveItem(arr, i, i + 1); this.plugin.commit(); }));
      if (byChapter) {
        m.addSeparator();
        for (const k of SECTION_KINDS) {
          if (k.key === NV.kind(col.item)) continue;
          m.addItem(it => it.setTitle(`Make it a ${k.label}`).setIcon(k.icon).onClick(() => this.plugin.setSectionKind(n, col.item, k.key)));
        }
      }
      m.addSeparator();
      m.addItem(it => it.setTitle(`Delete ${noun}…`).setIcon('trash-2').onClick(() => (byChapter ? this.plugin.deleteChapter(n, col.item) : this.plugin.deleteSlot(n, col.item))));
      m.showAtMouseEvent(e);
    };
    more.onclick = e => { e.stopPropagation(); menu(e); };
    h.addEventListener('contextmenu', e => { e.preventDefault(); menu(e); });
    label.addEventListener('dblclick', rename);
    this.makeReorderable(h, byChapter ? 'chapter' : 'slot', col.id, () => {
      const from = arr.findIndex(x => x.id === this.drag.id);
      NV.moveItem(arr, from, i);
    });
  }

  renderLaneHeader(grid, n, p) {
    const h = grid.createDiv('pw-lane-header');
    h.style.setProperty('--pw-color', p.color);
    const top = h.createDiv('pw-lane-top');
    const chev = top.createDiv('pw-icon-btn');
    setIcon(chev, p.collapsed ? 'chevron-right' : 'chevron-down');
    chev.setAttr('aria-label', p.collapsed ? 'Expand' : 'Collapse');
    chev.onclick = () => { p.collapsed = !p.collapsed; this.plugin.commit(); };
    const name = top.createDiv({ cls: 'pw-lane-name', text: p.name });
    name.addEventListener('dblclick', () => this.plugin.renamePlotline(n, p));
    const more = top.createDiv('pw-icon-btn');
    setIcon(more, 'more-horizontal');
    const count = n.beats.filter(b => b.plotlineId === p.id && NV.onBoard(n, b)).length;
    const off = n.beats.filter(b => b.plotlineId === p.id && NV.onBoard(n, b) && b.offscreen).length;
    h.createDiv({ cls: 'pw-lane-meta', text: plural(count, 'event') + (off ? ` · ${off} off-screen` : '') });
    if (p.description && !p.collapsed) h.createDiv({ cls: 'pw-lane-desc', text: p.description });
    const lanes = n.plotlines;
    const idx = lanes.indexOf(p);
    const menu = e => {
      const m = new Menu();
      m.addItem(it => it.setTitle('Rename').setIcon('pencil').onClick(() => this.plugin.renamePlotline(n, p)));
      m.addItem(it => it.setTitle('Change colour').setIcon('palette').onClick(() => {
        new ColorModal(this.app, `Colour for “${p.name}”`, p.color, c => { p.color = c; this.plugin.commit(); }).open();
      }));
      m.addItem(it => it.setTitle('Edit description').setIcon('align-left').onClick(() => {
        new TextPromptModal(this.app, 'Plotline description', 'What is this thread about?', p.description, v => { p.description = v; this.plugin.commit(); }).open();
      }));
      m.addSeparator();
      m.addItem(it => it.setTitle('Move up').setIcon('arrow-up').onClick(() => { NV.moveItem(lanes, idx, idx - 1); this.plugin.commit(); }));
      m.addItem(it => it.setTitle('Move down').setIcon('arrow-down').onClick(() => { NV.moveItem(lanes, idx, idx + 1); this.plugin.commit(); }));
      m.addItem(it => it.setTitle(p.collapsed ? 'Expand' : 'Collapse').setIcon('fold-vertical').onClick(() => { p.collapsed = !p.collapsed; this.plugin.commit(); }));
      m.addSeparator();
      m.addItem(it => it.setTitle('Archive plotline').setIcon('archive').onClick(() => { p.archived = true; this.plugin.commit(); new Notice(`Archived “${p.name}”. Restore it from Manage → Plotlines.`); }));
      m.addItem(it => it.setTitle('Delete plotline…').setIcon('trash-2').onClick(() => this.plugin.deletePlotline(n, p)));
      m.showAtMouseEvent(e);
    };
    more.onclick = e => { e.stopPropagation(); menu(e); };
    h.addEventListener('contextmenu', e => { e.preventDefault(); menu(e); });
    this.makeReorderable(h, 'lane', p.id, () => {
      const from = NV.laneIndex(n, this.drag.id);
      NV.moveItem(lanes, from, idx);
    });
  }

  renderCell(grid, n, p, col, byChapter) {
    const cell = grid.createDiv('pw-cell');
    cell.style.setProperty('--pw-color', p.color);
    if (col.staging) cell.addClass('pw-staging');
    let beats = byChapter ? NV.chapterCell(n, col.id, p.id) : NV.cell(n, col.id, p.id);
    if (!this.ui.showOffscreen) beats = beats.filter(b => !b.offscreen);
    if (p.collapsed) {
      cell.addClass('pw-collapsed');
      if (beats.length) {
        const chip = cell.createDiv({ cls: 'pw-collapsed-count', text: plural(beats.length, 'event') });
        chip.setAttr('aria-label', beats.map(b => b.title).join('\n'));
        beats.forEach(b => this.cardEls.set(b.id, chip));
      }
    } else {
      beats.forEach(b => this.renderCard(cell, n, b, byChapter ? 'board-chapters' : 'board'));
      if (!col.staging) {
        const add = cell.createDiv('pw-cell-add');
        setIcon(add, 'plus');
        add.setAttr('aria-label', 'Add scene here');
        add.onclick = () => this.newBeat(byChapter ? { chapterId: col.id, plotlineId: p.id } : { slotId: col.id, plotlineId: p.id });
      }
    }
    if (!col.staging) {
      cell.addEventListener('dblclick', e => {
        if (e.target === cell) this.newBeat(byChapter ? { chapterId: col.id, plotlineId: p.id } : { slotId: col.id, plotlineId: p.id });
      });
    }
    this.setupDropList(cell, {
      accepts: d => d.kind === 'beat' && d.source !== 'outline',
      onDrop: (d, beforeId) => {
        if (byChapter) {
          const b = NV.beat(n, d.id);
          const wasOff = b && b.offscreen;
          NV.moveToChapterCell(n, d.id, col.id, p.id, beforeId);
          if (wasOff && col.id) new Notice(`“${b.title}” is now an on-screen scene.`);
          if (b && !NV.isPlaced(n, b)) new Notice(`“${b.title}” has no story time or chapter, so it went to the Unplaced shelf.`);
        } else {
          NV.moveToCell(n, d.id, col.id, p.id, beforeId);
          const b = NV.beat(n, d.id);
          if (b && !NV.isPlaced(n, b)) new Notice(`“${b.title}” has no story time or chapter, so it went to the Unplaced shelf.`);
        }
        this.plugin.commit();
      },
    });
  }

  renderCard(parent, n, b, where) {
    const p = NV.plotline(n, b.plotlineId);
    const pov = NV.pov(n, b.povId);
    const card = parent.createDiv('pw-card');
    card.dataset.id = b.id;
    card.style.setProperty('--pw-color', p ? p.color : 'var(--text-faint)');
    const external = where === 'external';
    if (b.offscreen) card.addClass('pw-offscreen');
    if (external) card.addClass('pw-external');
    else if (!this.matchesPov(b)) card.addClass('pw-dim');

    const top = card.createDiv('pw-card-top');
    if (pov) {
      const badge = top.createSpan({ cls: 'pw-pov', text: pov.name });
      badge.style.setProperty('--pw-pov', pov.color);
    }
    if (b.offscreen) {
      const t = top.createSpan('pw-tag pw-tag-off');
      setIcon(t, 'eye-off');
      t.createSpan({ text: 'off-screen' });
    }
    top.createDiv('pw-spacer');
    const outN = b.influences.length;
    const inN = XN.incoming(this.novels, n, b.id).length;
    if (outN || inN) {
      const t = top.createSpan({ cls: 'pw-tag pw-tag-inf', text: [inN ? `←${inN}` : '', outN ? `${outN}→` : ''].filter(Boolean).join(' ') });
      t.setAttr('aria-label', `Shaped by ${inN} · leads to ${outN}`);
    }
    if (b.notePath) {
      const l = top.createSpan('pw-tag pw-link');
      setIcon(l, 'file-text');
      l.setAttr('aria-label', 'Open linked note');
      l.onclick = e => { e.stopPropagation(); this.plugin.openNote(n, b); };
    }
    const more = top.createDiv('pw-icon-btn');
    setIcon(more, 'more-horizontal');
    more.onclick = e => { e.stopPropagation(); if (external) this.externalMenu(e, n, b); else this.cardMenu(e, n, b); };

    card.createDiv({ cls: 'pw-card-title', text: b.title || 'Untitled' });
    if (b.summary) card.createDiv({ cls: 'pw-card-summary', text: b.summary });
    const slot = NV.timeOf(n, b);
    const ch = NV.hasChapter(n, b) ? NV.chapter(n, b.chapterId) : null;
    if (NV.isSummary(n, b)) card.addClass('pw-summary-card');
    if (external) {
      const m = card.createDiv('pw-card-meta');
      m.createSpan({ cls: 'pw-novel-chip', text: n.title });
      if (slot) m.createSpan({ cls: 'pw-time-chip', text: slot.label });
    } else if (where === 'shelf') {
      const was = b.status !== 'active' ? [slot ? `was: ${slot.label}` : '', NV.chapter(n, b.chapterId) ? NV.chapter(n, b.chapterId).title : ''] : [];
      const meta = [p ? p.name : 'No plotline', ...was].filter(Boolean).join(' · ');
      card.createDiv({ cls: 'pw-card-meta', text: meta });
    } else if (where === 'board-chapters') {
      const m = card.createDiv('pw-card-meta');
      m.createSpan({ cls: 'pw-time-chip', text: slot ? slot.label : 'no story time yet' });
    } else if (ch) {
      const m = card.createDiv('pw-card-meta');
      m.createSpan({ cls: 'pw-chapter-chip', text: ch.title }).toggleClass('is-part', NV.kind(ch) === 'part');
    } else if (!b.offscreen && n.chapters.length && !NV.isSummary(n, b)) {
      card.createDiv({ cls: 'pw-card-meta pw-faint', text: 'no chapter yet' });
    }

    card.draggable = !external;
    if (external) card.setAttr('aria-label', `From “${n.title}”: double-click to edit it there`);
    card.addEventListener('dragstart', e => {
      e.stopPropagation();
      if (external || this.linking) { e.preventDefault(); return; }
      this.drag = { kind: 'beat', id: b.id, source: where === 'shelf' ? 'shelf' : 'board' };
      if (e.dataTransfer) { e.dataTransfer.setData('text/plain', b.title); e.dataTransfer.effectAllowed = 'move'; }
      setTimeout(() => card.addClass('pw-dragging'), 0);
    });
    card.addEventListener('dragend', () => this.endDrag());
    card.addEventListener('dblclick', e => { e.stopPropagation(); if (external) new BeatModal(this.plugin, n, b, false).open(); else this.editBeat(b); });
    card.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); if (external) this.externalMenu(e, n, b); else this.cardMenu(e, n, b); });
    if (where !== 'shelf') {
      card.addEventListener('mouseenter', () => { if (!this.linking) this.highlight(b.id); });
      card.addEventListener('mouseleave', () => { if (!this.linking) this.highlight(null); });
      this.cardEls.set(b.id, card);
      if (this.ui.showArrows) {
        const handle = card.createDiv('pw-link-handle');
        setIcon(handle, 'arrow-right');
        handle.setAttr('aria-label', 'Drag onto another card to link: this leads to that');
        handle.addEventListener('pointerdown', e => this.startLink(e, b, card));
        handle.addEventListener('dblclick', e => e.stopPropagation());
      }
    }
    return card;
  }

  /* ---------- drag a link from one card to another */

  startLink(e, b, card) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const grid = this.gridEl, sv = this.svgEl;
    if (!grid || !sv) return;
    this.highlight(null);
    const temp = svg('g', { class: 'pw-link-temp' });
    const path = svg('path', { d: '' });
    const tip = svg('circle', { r: '4.5' });
    temp.appendChild(path);
    temp.appendChild(tip);
    sv.appendChild(temp);
    card.addClass('pw-link-source');
    this.contentEl.addClass('pw-linking');
    const L = this.linking = { id: b.id, card, temp, path, tip, target: null };

    const toGrid = (x, y) => { const r = grid.getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; };
    const move = ev => {
      const g = grid.getBoundingClientRect(), c = card.getBoundingClientRect();
      const p = toGrid(ev.clientX, ev.clientY);
      const leftward = ev.clientX < c.left + c.width / 2;
      const x1 = (leftward ? c.left : c.right) - g.left, y1 = c.top + c.height / 2 - g.top;
      const dx = Math.max(24, Math.abs(p.x - x1) / 2) * (leftward ? -1 : 1);
      path.setAttribute('d', `M${x1},${y1} C${x1 + dx},${y1} ${p.x - dx},${p.y} ${p.x},${p.y}`);
      tip.setAttribute('cx', p.x); tip.setAttribute('cy', p.y);
      // Which card is under the pointer?
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const hit = under && under.closest ? under.closest('.pw-card') : null;
      const ok = hit && grid.contains(hit) && hit.dataset.id && hit.dataset.id !== b.id ? hit : null;
      if (L.target !== ok) {
        if (L.target) L.target.removeClass('pw-link-target');
        L.target = ok;
        if (ok) ok.addClass('pw-link-target');
      }
      // Scroll the board when dragging near its edges.
      const sc = this.boardScroller;
      if (sc) {
        const r = sc.getBoundingClientRect(), edge = 40, step = 14;
        if (ev.clientX > r.right - edge) sc.scrollLeft += step; else if (ev.clientX < r.left + edge + 160) sc.scrollLeft -= step;
        if (ev.clientY > r.bottom - edge) sc.scrollTop += step; else if (ev.clientY < r.top + edge) sc.scrollTop -= step;
      }
    };
    const finish = commit => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('keydown', key, true);
      temp.remove();
      card.removeClass('pw-link-source');
      if (L.target) L.target.removeClass('pw-link-target');
      this.contentEl.removeClass('pw-linking');
      this.linking = null;
      if (commit && L.target) this.createLink(b.id, L.target.dataset.id);
    };
    const up = () => finish(true);
    const key = ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); } };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('keydown', key, true);
    move(e);
  }

  /** Make "from leads to to": within this novel, or from a linked novel's event into this one. */
  createLink(fromId, toId) {
    const n = this.novel;
    const S = this.findBeat(fromId), T = this.findBeat(toId);
    if (!S || !T || S.b.id === T.b.id) return;
    if (T.home.id !== n.id) {
      new Notice(`“${T.b.title}” is in “${T.home.title}”. Links run from the novels this one draws on into this one, not back.`);
      return;
    }
    if (S.b.influences.some(i => i.to === T.b.id && XN.targetNovelId(S.home, i) === n.id)) {
      new Notice(`“${S.b.title}” already leads to “${T.b.title}”.`);
      return;
    }
    const inf = { to: T.b.id, note: '' };
    if (S.home.id !== n.id) inf.novel = n.id;
    S.b.influences.push(inf);
    this.plugin.commit();
    new LinkNoteModal(this.app, S.b.title, T.b.title,
      note => { inf.note = note; this.plugin.commit(); },
      () => { S.b.influences = S.b.influences.filter(i => i !== inf); this.plugin.commit(); new Notice('Link removed.'); }).open();
  }

  pickChapter(n, b) {
    const items = n.chapters.map((c, i) => {
      const k = NV.kindInfo(c), part = NV.kind(c) !== 'part' ? NV.partOf(n, c.id) : null;
      return {
        label: c.title, value: c.id, badge: String(n.beats.filter(x => x.chapterId === c.id && NV.onBoard(n, x)).length),
        desc: [k.key === 'part' ? 'Part: the card becomes its summary' : (part ? part.title : ''), i === NV.chapterIndex(n, b.chapterId) ? 'current' : ''].filter(Boolean).join(' · '),
      };
    });
    items.push({ label: '— No chapter yet —', value: '', sticky: true });
    for (const k of SECTION_KINDS) items.push({ label: `＋ New ${k.label.toLowerCase()}…`, value: `__new:${k.key}`, sticky: true });
    new PickerModal(this.app, `Chapter or section for “${b.title}”`, items, v => {
      if (v.startsWith('__new:')) {
        this.plugin.addSection(n, v.slice(6), null, sec => { NV.assignChapter(n, b.id, sec.id, null); this.plugin.commit(); });
        return;
      }
      NV.assignChapter(n, b.id, v || null, null);
      if (!NV.isPlaced(n, b)) new Notice(`“${b.title}” has no story time or chapter now, so it moved to the Unplaced shelf.`);
      this.plugin.commit();
    }, { selected: b.chapterId || '', placeholder: 'Find a chapter, part, prologue…' }).open();
  }

  cardMenu(e, n, b) {
    const m = new Menu();
    const commit = () => this.plugin.commit();
    m.addItem(it => it.setTitle('Edit…').setIcon('pencil').onClick(() => this.editBeat(b)));
    if (b.notePath) {
      m.addItem(it => it.setTitle('Open linked note').setIcon('file-text').onClick(() => this.plugin.openNote(n, b)));
      m.addItem(it => it.setTitle('Unlink note').setIcon('unlink').onClick(() => { b.notePath = null; commit(); }));
    } else {
      m.addItem(it => it.setTitle('Create note from template…').setIcon('file-plus').onClick(() => this.plugin.createNoteFlow(n, b)));
      m.addItem(it => it.setTitle('Link existing note…').setIcon('link').onClick(() => this.plugin.linkExistingNote(n, b)));
    }
    m.addSeparator();
    if (!b.offscreen) m.addItem(it => it.setTitle(NV.hasChapter(n, b) ? 'Move to chapter…' : 'Assign to chapter…').setIcon('book-open').onClick(() => this.pickChapter(n, b)));
    m.addSeparator();
    m.addItem(it => it.setTitle(b.offscreen ? 'Mark as on-screen' : 'Mark as off-screen').setIcon('eye-off').onClick(() => { b.offscreen = !b.offscreen; commit(); }));
    m.addItem(it => it.setTitle('Duplicate').setIcon('copy').onClick(() => {
      const c = makeBeat(Object.assign(clone(b), { id: uid(), title: `${b.title} (copy)`, notePath: null, influences: clone(b.influences), order: b.order + 0.5, shelfOrder: b.shelfOrder + 0.5 }));
      n.beats.push(c); commit();
    }));
    m.addSeparator();
    if (b.status === 'active') {
      if (NV.isPlaced(n, b)) m.addItem(it => it.setTitle('Remove from board').setIcon('inbox').onClick(() => { NV.moveToShelf(n, b.id, 'unplaced', null); commit(); }));
      m.addItem(it => it.setTitle('Save for later').setIcon('clock').onClick(() => { NV.moveToShelf(n, b.id, 'parked', null); commit(); }));
      m.addItem(it => it.setTitle('Archive').setIcon('archive').onClick(() => { NV.moveToShelf(n, b.id, 'archived', null); commit(); }));
    } else {
      const where = NV.timeOf(n, b) ? `“${NV.timeOf(n, b).label}”` : NV.hasChapter(n, b) ? `“${NV.chapter(n, b.chapterId).title}”` : null;
      m.addItem(it => it.setTitle(where && NV.plotline(n, b.plotlineId) ? `Restore to ${where}` : 'Restore to Unplaced').setIcon('rotate-ccw').onClick(() => { NV.restore(n, b.id); commit(); }));
      if (b.status === 'parked') m.addItem(it => it.setTitle('Archive').setIcon('archive').onClick(() => { NV.moveToShelf(n, b.id, 'archived', null); commit(); }));
      if (b.status === 'archived') m.addItem(it => it.setTitle('Save for later').setIcon('clock').onClick(() => { NV.moveToShelf(n, b.id, 'parked', null); commit(); }));
    }
    m.addSeparator();
    m.addItem(it => it.setTitle('Delete permanently…').setIcon('trash-2').onClick(() => this.plugin.deleteBeat(n, b)));
    m.showAtMouseEvent(e);
  }

  /* ---------- shelf */

  /** Dropping a card on a shelf tab (or its rail icon) moves it to that shelf. */
  shelfDropTarget(el, n, key) {
    el.addEventListener('dragover', e => {
      if (!this.drag || this.drag.kind !== 'beat') return;
      e.preventDefault(); el.addClass('pw-drop-target');
    });
    el.addEventListener('dragleave', () => el.removeClass('pw-drop-target'));
    el.addEventListener('drop', e => {
      if (!this.drag || this.drag.kind !== 'beat') return;
      e.preventDefault();
      const d = this.drag; this.endDrag();
      const b = NV.beat(n, d.id);
      NV.moveToShelf(n, d.id, key, null);
      if (b && this.ui.shelfCollapsed) new Notice(`“${b.title}” → ${SHELF_TABS.find(t => t.key === key).label}`);
      this.plugin.commit();
    });
  }

  /** Collapsed shelf: a slim strip that still shows counts and still accepts dropped cards. */
  renderShelfRail(rail, n) {
    const exp = rail.createDiv('pw-rail-btn');
    setIcon(exp, 'chevrons-left');
    exp.setAttr('aria-label', 'Expand the idea shelf');
    exp.onclick = () => this.setUi({ shelfCollapsed: false });
    for (const t of SHELF_TABS) {
      const count = NV.shelf(n, t.key).length;
      const tab = rail.createDiv('pw-rail-tab');
      setIcon(tab.createSpan('pw-btn-icon'), t.icon);
      tab.createSpan({ cls: 'pw-count', text: String(count) });
      tab.setAttr('aria-label', `${t.label} (${count}): click to open · drop a card here to move it`);
      tab.onclick = () => this.setUi({ shelfCollapsed: false, shelfTab: t.key });
      this.shelfDropTarget(tab, n, t.key);
    }
    const add = rail.createDiv('pw-rail-btn pw-rail-add');
    setIcon(add, 'plus');
    add.setAttr('aria-label', 'Jot down an idea');
    add.onclick = () => new TextPromptModal(this.app, 'Capture an idea', 'Idea…', '', title => {
      n.beats.push(makeBeat({ title, shelfOrder: Date.now() }));
      this.plugin.commit();
      new Notice(`Added to Unplaced: “${title}”`);
    }).open();
    rail.createDiv({ cls: 'pw-rail-label', text: 'Idea shelf' });
  }

  renderShelf(shelf, n) {
    const kind = this.ui.shelfTab || 'unplaced';
    const head = shelf.createDiv('pw-shelf-head');
    head.createSpan({ cls: 'pw-shelf-title', text: 'Idea shelf' });
    head.createDiv('pw-spacer');
    const col = head.createEl('button', { cls: 'pw-btn pw-shelf-collapse' });
    col.createSpan({ cls: 'pw-btn-label', text: 'Collapse' });
    setIcon(col.createSpan('pw-btn-icon'), 'chevrons-right');
    col.setAttr('aria-label', 'Collapse the idea shelf to a slim strip');
    col.onclick = () => this.setUi({ shelfCollapsed: true });
    const tabs = shelf.createDiv('pw-shelf-tabs');
    for (const t of SHELF_TABS) {
      const tab = tabs.createDiv('pw-shelf-tab');
      tab.toggleClass('is-active', kind === t.key);
      setIcon(tab.createSpan('pw-btn-icon'), t.icon);
      tab.createSpan({ text: t.label });
      tab.createSpan({ cls: 'pw-count', text: String(NV.shelf(n, t.key).length) });
      tab.setAttr('aria-label', `${t.hint} Drop a card here to move it.`);
      tab.onclick = () => this.setUi({ shelfTab: t.key });
      this.shelfDropTarget(tab, n, t.key);
    }

    const tabInfo = SHELF_TABS.find(t => t.key === kind);
    shelf.createDiv({ cls: 'pw-shelf-hint', text: tabInfo.hint });

    if (kind !== 'archived') {
      const input = shelf.createEl('input', { type: 'text', cls: 'pw-quick-add' });
      input.placeholder = kind === 'parked' ? 'Save an idea for later… ↵' : 'Jot down an idea… ↵';
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || !input.value.trim()) return;
        n.beats.push(makeBeat({ title: input.value.trim(), status: kind === 'parked' ? 'parked' : 'active', shelfOrder: Date.now() }));
        this.refocusQuickAdd = true;
        this.plugin.commit();
      });
      if (this.refocusQuickAdd) { this.refocusQuickAdd = false; setTimeout(() => input.focus(), 0); }
    }
    const filter = shelf.createEl('input', { type: 'search', cls: 'pw-shelf-filter' });
    filter.placeholder = 'Filter…';
    filter.value = this.shelfQuery;

    const list = shelf.createDiv('pw-shelf-list');
    this.shelfList = list;
    const items = NV.shelf(n, kind);
    for (const b of items) this.renderCard(list, n, b, 'shelf');
    if (!items.length) list.createDiv({ cls: 'pw-empty', text: kind === 'unplaced' ? 'No loose ideas. Jot one above, or drag a card here from the board.' : 'Nothing here yet. Drag cards here, or use a card’s ⋯ menu.' });
    const applyFilter = () => {
      const q = this.shelfQuery.toLowerCase();
      list.querySelectorAll('.pw-card').forEach(el => {
        const b = NV.beat(n, el.dataset.id);
        const hit = !q || (`${b.title} ${b.summary}`).toLowerCase().includes(q);
        el.toggleClass('pw-hidden', !hit);
      });
    };
    filter.addEventListener('input', () => { this.shelfQuery = filter.value; applyFilter(); });
    applyFilter();

    if (kind === 'archived' && items.length) {
      const emp = shelf.createEl('button', { cls: 'pw-small-btn pw-empty-archive', text: 'Empty archive…' });
      emp.onclick = () => new ConfirmModal(this.app, 'Empty archive?', `Permanently delete ${plural(items.length, 'archived idea')}?`, 'Delete all', () => {
        items.forEach(b => { NV.remove(n, b.id); XN.purgeBeat(this.plugin.data.novels, b.id); }); this.plugin.commit();
      }).open();
    }

    this.setupDropList(list, {
      accepts: d => d.kind === 'beat',
      onDrop: (d, beforeId) => { NV.moveToShelf(n, d.id, kind, beforeId); this.plugin.commit(); },
    });
  }

  /* ---------- outline (manuscript order) */

  renderOutline(main, n) {
    const scroller = main.createDiv('pw-outline-scroll');
    this.outlineScroller = scroller;
    const head = scroller.createDiv('pw-outline-head');
    head.createEl('h3', { text: 'Manuscript order' });
    const up = XN.upstream(this.novels, n), down = XN.downstream(this.novels, n);
    if (up.length || down.length) {
      const links = head.createDiv('pw-outline-links');
      if (up.length) links.createSpan({ text: `Draws on: ${up.map(x => x.title).join(', ')}` });
      if (down.length) links.createSpan({ text: `Shapes: ${down.map(x => x.title).join(', ')}` });
    }
    head.createDiv({ cls: 'pw-muted', text: 'The order readers meet your scenes, part by part and chapter by chapter. Drag scenes to rearrange them or move them between chapters; drag a heading to reorder sections. Off-screen events are woven in automatically at their point in story time.' });
    const actions = head.createDiv('pw-outline-actions');
    const addSec = this.tbButton(actions, 'plus', 'Add section', () => {});
    addSec.onclick = e => this.plugin.addSectionMenu(n, n.chapters.length, e);
    this.tbButton(actions, 'rotate-ccw', 'Re-sort scenes by story time', () => {
      new ConfirmModal(this.app, 'Re-sort by story time?', 'Within each chapter, re-sort scenes chronologically, discarding your manual order. Chapter assignments are kept.', 'Re-sort', () => {
        n.manuscriptOrder = []; this.plugin.commit();
      }).open();
    });

    const onscreen = NV.manuscript(n);
    const merged = this.ui.showOffscreen ? NV.withOffscreen(n, onscreen) : onscreen;
    const groups = NV.groups(n, merged);
    const scenesOnly = onscreen.filter(b => !NV.isSummary(n, b));
    const numbers = new Map(scenesOnly.map((b, i) => [b.id, i + 1]));
    let maxSlot = -1;
    const jumps = new Set();
    for (const b of scenesOnly) {
      const t = NV.timeOf(n, b);
      const si = t ? NV.slotIndex(n, t.id) : -1;
      if (si < 0) continue;
      if (si < maxSlot) jumps.add(b.id);
      maxSlot = Math.max(maxSlot, si);
    }

    if (!onscreen.length && !n.chapters.length) {
      scroller.createDiv({ cls: 'pw-empty', text: 'No scenes yet. Place events on the board and they’ll appear here.' });
    }

    let inPart = false;
    for (const g of groups) {
      if (!g.chapter && !g.items.length && !n.chapters.length) continue;
      const kind = g.chapter ? NV.kind(g.chapter) : null;
      if (kind === 'part') inPart = true;
      else if (kind === 'prologue' || kind === 'epilogue' || !g.chapter) inPart = false;
      const sec = scroller.createDiv('pw-ogroup');
      if (kind) sec.addClass(`pw-og-${kind}`);
      if (inPart && kind !== 'part') sec.addClass('pw-in-part');
      const gh = sec.createDiv('pw-chapter');
      if (g.chapter) {
        const ch = g.chapter;
        const ci = NV.chapterIndex(n, ch.id);
        const k = NV.kindInfo(ch);
        setIcon(gh.createSpan('pw-grip'), 'grip-vertical');
        const ic = gh.createSpan('pw-kind-icon');
        setIcon(ic, k.icon);
        ic.setAttr('aria-label', k.label);
        const t = gh.createSpan({ cls: 'pw-chapter-title', text: ch.title });
        t.addEventListener('dblclick', () => this.plugin.renameChapter(n, ch));
        const nScenes = g.items.filter(b => !b.offscreen && !NV.isSummary(n, b)).length;
        if (kind !== 'part' || nScenes) gh.createSpan({ cls: 'pw-count', text: plural(nScenes, 'scene') });
        gh.createDiv('pw-spacer');
        const more = gh.createDiv('pw-icon-btn');
        setIcon(more, 'more-horizontal');
        const menu = e => {
          const m = new Menu();
          m.addItem(it => it.setTitle('Rename').setIcon('pencil').onClick(() => this.plugin.renameChapter(n, ch)));
          m.addItem(it => it.setTitle('Insert section before…').setIcon('arrow-up').onClick(() => this.plugin.addSectionMenu(n, ci, e)));
          m.addItem(it => it.setTitle('Insert section after…').setIcon('arrow-down').onClick(() => this.plugin.addSectionMenu(n, ci + 1, e)));
          m.addSeparator();
          for (const kk of SECTION_KINDS) {
            if (kk.key === kind) continue;
            m.addItem(it => it.setTitle(`Make it a ${kk.label}`).setIcon(kk.icon).onClick(() => this.plugin.setSectionKind(n, ch, kk.key)));
          }
          m.addSeparator();
          m.addItem(it => it.setTitle(`Delete ${k.label.toLowerCase()}…`).setIcon('trash-2').onClick(() => this.plugin.deleteChapter(n, ch)));
          m.showAtMouseEvent(e);
        };
        more.onclick = e => { e.stopPropagation(); menu(e); };
        gh.addEventListener('contextmenu', e => { e.preventDefault(); menu(e); });
        this.makeReorderable(gh, 'chapter', ch.id, () => {
          const from = NV.chapterIndex(n, this.drag.id);
          NV.moveItem(n.chapters, from, ci);
        });
      } else {
        gh.addClass('pw-chapter-loose');
        gh.createSpan({ cls: 'pw-chapter-title', text: n.chapters.length ? 'Not in a chapter yet' : 'Scenes' });
        gh.createSpan({ cls: 'pw-count', text: plural(g.items.filter(b => !b.offscreen).length, 'scene') });
        if (n.chapters.length) sec.createDiv({ cls: 'pw-muted pw-loose-hint', text: 'Planned in story time but not yet assigned. Drag them into a chapter above when you’re ready.' });
      }
      const list = sec.createDiv('pw-outline-list');
      const items = g.items.filter(b => NV.isSummary(n, b)).concat(g.items.filter(b => !NV.isSummary(n, b)));
      for (const b of items) {
        if (b.offscreen) this.renderOffscreenRow(list, n, b);
        else if (NV.isSummary(n, b)) this.renderSummaryRow(list, n, b);
        else this.renderOutlineRow(list, n, b, numbers.get(b.id), jumps.has(b.id));
      }
      if (!g.items.length) {
        const hint = kind === 'part' ? 'Drop a card here to make it this part’s summary (optional)' : g.chapter ? 'Drop scenes here' : 'All scenes are in chapters.';
        list.createDiv({ cls: 'pw-empty pw-drop-hint', text: hint });
      }
      const chapterId = g.chapter ? g.chapter.id : null;
      this.setupDropList(list, {
        itemSelector: '.pw-orow:not(.pw-orow-off)',
        accepts: d => d.kind === 'beat' && d.source === 'outline',
        onDrop: (d, beforeId) => {
          const b = NV.beat(n, d.id);
          NV.assignChapter(n, d.id, chapterId, beforeId);
          if (b && !NV.isPlaced(n, b)) new Notice(`“${b.title}” has no story time or chapter now, so it moved to the Unplaced shelf.`);
          this.plugin.commit();
        },
      });
    }
  }

  renderOutlineRow(list, n, b, num, jump) {
    const p = NV.plotline(n, b.plotlineId), pov = NV.pov(n, b.povId), slot = NV.timeOf(n, b);
    const row = list.createDiv('pw-orow');
    row.dataset.id = b.id;
    row.style.setProperty('--pw-color', p.color);
    if (!this.matchesPov(b)) row.addClass('pw-dim');
    setIcon(row.createDiv('pw-grip'), 'grip-vertical');
    row.createDiv({ cls: 'pw-onum', text: String(num) });
    const body = row.createDiv('pw-obody');
    const top = body.createDiv('pw-otop');
    top.createSpan({ cls: 'pw-otitle', text: b.title });
    if (pov) { const badge = top.createSpan({ cls: 'pw-pov', text: pov.name }); badge.style.setProperty('--pw-pov', pov.color); }
    top.createSpan({ cls: 'pw-plot-chip', text: p.name });
    top.createSpan({ cls: 'pw-time-chip', text: slot ? slot.label : 'no story time yet' });
    if (jump) top.createSpan({ cls: 'pw-tag pw-tag-jump', text: '↺ earlier in story time' });
    if (b.notePath) { const l = top.createSpan('pw-tag pw-link'); setIcon(l, 'file-text'); l.onclick = e => { e.stopPropagation(); this.plugin.openNote(n, b); }; }
    if (b.summary) body.createDiv({ cls: 'pw-osummary', text: b.summary });
    this.renderInfluences(body, n, b);
    const more = row.createDiv('pw-icon-btn');
    setIcon(more, 'more-horizontal');
    more.onclick = e => { e.stopPropagation(); this.cardMenu(e, n, b); };
    row.draggable = true;
    row.addEventListener('dragstart', e => {
      this.drag = { kind: 'beat', id: b.id, source: 'outline' };
      if (e.dataTransfer) { e.dataTransfer.setData('text/plain', b.title); e.dataTransfer.effectAllowed = 'move'; }
      setTimeout(() => row.addClass('pw-dragging'), 0);
    });
    row.addEventListener('dragend', () => this.endDrag());
    row.addEventListener('dblclick', () => this.editBeat(b));
    row.addEventListener('contextmenu', e => { e.preventDefault(); this.cardMenu(e, n, b); });
  }

  /** A card assigned to a Part: shown as that part's summary, not numbered as a scene. */
  renderSummaryRow(list, n, b) {
    const p = NV.plotline(n, b.plotlineId), slot = NV.timeOf(n, b);
    const row = list.createDiv('pw-orow pw-orow-summary');
    row.dataset.id = b.id;
    row.style.setProperty('--pw-color', p.color);
    setIcon(row.createDiv('pw-grip'), 'grip-vertical');
    const ic = row.createDiv('pw-onum');
    setIcon(ic, 'library');
    const body = row.createDiv('pw-obody');
    const top = body.createDiv('pw-otop');
    top.createSpan({ cls: 'pw-off-label', text: 'Part summary' });
    top.createSpan({ cls: 'pw-otitle', text: b.title });
    top.createSpan({ cls: 'pw-plot-chip', text: p.name });
    if (slot) top.createSpan({ cls: 'pw-time-chip', text: slot.label });
    if (b.summary) body.createDiv({ cls: 'pw-osummary', text: b.summary });
    this.renderInfluences(body, n, b);
    const more = row.createDiv('pw-icon-btn');
    setIcon(more, 'more-horizontal');
    more.onclick = e => { e.stopPropagation(); this.cardMenu(e, n, b); };
    row.draggable = true;
    row.addEventListener('dragstart', e => {
      this.drag = { kind: 'beat', id: b.id, source: 'outline' };
      if (e.dataTransfer) { e.dataTransfer.setData('text/plain', b.title); e.dataTransfer.effectAllowed = 'move'; }
      setTimeout(() => row.addClass('pw-dragging'), 0);
    });
    row.addEventListener('dragend', () => this.endDrag());
    row.addEventListener('dblclick', () => this.editBeat(b));
    row.addEventListener('contextmenu', e => { e.preventDefault(); this.cardMenu(e, n, b); });
  }

  /** Influence links with their "how" notes, both directions, as readable lines. */
  renderInfluences(body, n, b) {
    const inc = XN.incoming(this.novels, n, b.id);
    const out = XN.outgoing(this.novels, n, b);
    if (!inc.length && !out.length) return;
    const box = body.createDiv('pw-oinf');
    const line = (dir, other, nv, note) => {
      const row = box.createDiv('pw-oinf-line');
      row.createSpan({ cls: 'pw-oinf-dir', text: dir });
      if (nv.id !== n.id) row.createSpan({ cls: 'pw-novel-chip', text: nv.title });
      const t = row.createSpan({ cls: 'pw-oinf-item' + (other.offscreen ? ' is-off' : ''), text: other.title + (other.offscreen ? ' (off-screen)' : '') });
      t.style.setProperty('--pw-color', (NV.plotline(nv, other.plotlineId) || {}).color || 'var(--text-faint)');
      if (note) row.createSpan({ cls: 'pw-oinf-note', text: ` — ${note}` });
    };
    for (const x of inc) line('← Shaped by', x.from, x.fromNovel, x.note);
    for (const x of out) line('→ Leads to', x.to, x.toNovel, x.note);
  }

  renderOffscreenRow(list, n, b) {
    const p = NV.plotline(n, b.plotlineId), slot = NV.slot(n, b.slotId);
    const row = list.createDiv('pw-orow pw-orow-off');
    row.dataset.id = b.id;
    row.style.setProperty('--pw-color', p.color);
    const ic = row.createDiv('pw-grip');
    setIcon(ic, 'eye-off');
    row.createDiv({ cls: 'pw-onum', text: '' });
    const body = row.createDiv('pw-obody');
    const top = body.createDiv('pw-otop');
    top.createSpan({ cls: 'pw-off-label', text: 'Meanwhile, off-screen' });
    top.createSpan({ cls: 'pw-otitle', text: b.title });
    top.createSpan({ cls: 'pw-plot-chip', text: p.name });
    top.createSpan({ cls: 'pw-time-chip', text: slot.label });
    if (b.summary) body.createDiv({ cls: 'pw-osummary', text: b.summary });
    this.renderInfluences(body, n, b);
    row.setAttr('aria-label', 'Placed automatically by story time. Move it on the board to change where it falls.');
    const more = row.createDiv('pw-icon-btn');
    setIcon(more, 'more-horizontal');
    more.onclick = e => { e.stopPropagation(); this.cardMenu(e, n, b); };
    row.addEventListener('dblclick', () => this.editBeat(b));
    row.addEventListener('contextmenu', e => { e.preventDefault(); this.cardMenu(e, n, b); });
  }

  /* ---------- drag & drop plumbing */

  makeReorderable(el, kind, id, apply) {
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      e.stopPropagation();
      this.drag = { kind, id };
      if (e.dataTransfer) { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; }
      el.addClass('pw-dragging');
    });
    el.addEventListener('dragend', () => this.endDrag());
    el.addEventListener('dragover', e => {
      if (!this.drag || this.drag.kind !== kind || this.drag.id === id) return;
      e.preventDefault(); el.addClass('pw-drop-target');
    });
    el.addEventListener('dragleave', () => el.removeClass('pw-drop-target'));
    el.addEventListener('drop', e => {
      if (!this.drag || this.drag.kind !== kind) return;
      e.preventDefault(); e.stopPropagation();
      apply();
      this.endDrag();
      this.plugin.commit();
    });
  }

  dropItems(listEl, sel) {
    const dragId = this.drag && this.drag.id;
    return Array.from(listEl.children).filter(el => el.matches(sel) && el.dataset.id !== dragId && !el.hasClass('pw-hidden'));
  }
  findBefore(listEl, sel, y) {
    for (const el of this.dropItems(listEl, sel)) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return el;
    }
    return null;
  }
  placeIndicator(listEl, sel, before) {
    if (!this.indicator) { this.indicator = document.createElement('div'); this.indicator.className = 'pw-drop-indicator'; }
    if (before) { listEl.insertBefore(this.indicator, before); return; }
    const its = this.dropItems(listEl, sel);
    const last = its[its.length - 1];
    if (last) last.after(this.indicator); else listEl.prepend(this.indicator);
  }
  setupDropList(listEl, opts) {
    const sel = opts.itemSelector || '.pw-card';
    listEl.addEventListener('dragover', e => {
      if (!this.drag || !opts.accepts(this.drag)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      listEl.addClass('pw-drop-target');
      this.placeIndicator(listEl, sel, this.findBefore(listEl, sel, e.clientY));
    });
    listEl.addEventListener('dragleave', e => {
      if (listEl.contains(e.relatedTarget)) return;
      listEl.removeClass('pw-drop-target');
      if (this.indicator && this.indicator.parentElement === listEl) this.indicator.remove();
    });
    listEl.addEventListener('drop', e => {
      if (!this.drag || !opts.accepts(this.drag)) return;
      e.preventDefault(); e.stopPropagation();
      const before = this.findBefore(listEl, sel, e.clientY);
      const d = this.drag;
      this.endDrag();
      opts.onDrop(d, before ? before.dataset.id : null);
    });
  }
  endDrag() {
    this.drag = null;
    if (this.indicator) this.indicator.remove();
    this.contentEl.querySelectorAll('.pw-drop-target, .pw-dragging').forEach(el => el.removeClass('pw-drop-target', 'pw-dragging'));
  }

  /* ---------- influence arrows */

  highlight(id) {
    const n = this.novel;
    this.contentEl.toggleClass('pw-highlighting', !!id && this.ui.showArrows);
    for (const el of this.cardEls.values()) el.removeClass('pw-related', 'pw-focus');
    if (this.svgEl) this.svgEl.querySelectorAll('.pw-arrow').forEach(p => p.classList.remove('pw-hot'));
    if (!id) return;
    const found = this.findBeat(id);
    if (!found) return;
    const b = found.b;
    const rel = new Set(b.influences.map(i => i.to));
    XN.incoming(this.novels, found.home, id).forEach(x => rel.add(x.from.id));
    const self = this.cardEls.get(id);
    if (self) self.addClass('pw-focus');
    rel.forEach(r => { const el = this.cardEls.get(r); if (el) el.addClass('pw-related'); });
    if (this.svgEl) this.svgEl.querySelectorAll('.pw-arrow').forEach(p => {
      if (p.getAttribute('data-from') === id || p.getAttribute('data-to') === id) p.classList.add('pw-hot');
    });
  }

  scheduleArrows() {
    if (this.arrowFrame) return;
    this.arrowFrame = requestAnimationFrame(() => { this.arrowFrame = 0; this.drawArrows(); });
  }

  /**
   * Anchor points and directions for a link. Links between columns leave and enter cards horizontally and
   * stay within the gutter between the two cards' facing edges, so they never cut across other cards in
   * those columns; links within one column loop out through the right-hand gutter.
   */
  routeArrow(A, T) {
    const acy = A.y + A.h / 2, tcy = T.y + T.h / 2;
    if (T.x - (A.x + A.w) > 0) return { p0: { x: A.x + A.w, y: acy }, p3: { x: T.x, y: tcy }, s: { x: 1, y: 0 }, u: { x: 1, y: 0 }, loop: false };
    if (A.x - (T.x + T.w) > 0) return { p0: { x: A.x, y: acy }, p3: { x: T.x + T.w, y: tcy }, s: { x: -1, y: 0 }, u: { x: -1, y: 0 }, loop: false };
    return { p0: { x: A.x + A.w, y: acy }, p3: { x: T.x + T.w, y: tcy }, s: { x: 1, y: 0 }, u: { x: -1, y: 0 }, loop: true };
  }

  drawArrows() {
    const grid = this.gridEl, sv = this.svgEl;
    if (!grid || !sv || !grid.isConnected) return;
    while (sv.firstChild) sv.removeChild(sv.firstChild);
    if (!this.ui.showArrows) return;
    const n = this.novel;
    sv.setAttribute('width', grid.scrollWidth);
    sv.setAttribute('height', grid.scrollHeight);
    const gr = grid.getBoundingClientRect();
    const box = el => { const r = el.getBoundingClientRect(); return { x: r.left - gr.left, y: r.top - gr.top, w: r.width, h: r.height }; };
    const HEAD_L = 9, HEAD_W = 9;
    const f = v => v.toFixed(1);
    const add = (p, v, k) => ({ x: p.x + v.x * k, y: p.y + v.y * k });
    const sources = n.beats.concat(...[...(this.extHome || new Map()).keys()].map(id => { const f = this.findBeat(id); return f ? [f.b] : []; }));
    for (const b of sources) {
      const fromEl = this.cardEls.get(b.id);
      if (!fromEl) continue;
      const pl = NV.plotline(this.homeOf(b), b.plotlineId);
      const color = pl ? pl.color : '#888888';
      for (const inf of b.influences) {
        const toEl = this.cardEls.get(inf.to);
        if (!toEl || toEl === fromEl) continue;
        const { p0, p3, s, u, loop } = this.routeArrow(box(fromEl), box(toEl));
        // Geometry: origin dot · straight lead-out · smooth curve · straight lead-in · head.
        // The lead-in is collinear with the head, so the line always meets the arrowhead dead straight.
        const base = add(p3, u, -HEAD_L);
        let lead = 6;
        if (!loop && (base.x - p0.x) * u.x < 2 * lead + 4) lead = 0;
        const q1 = add(p0, s, lead), q2 = add(base, u, -lead);
        const k = loop ? 18 : Math.max(2, Math.abs(q2.x - q1.x) / 2);
        const c1 = add(q1, s, k), c2 = add(q2, u, -k);
        const d = `M${f(p0.x)},${f(p0.y)} L${f(q1.x)},${f(q1.y)} C${f(c1.x)},${f(c1.y)} ${f(c2.x)},${f(c2.y)} ${f(q2.x)},${f(q2.y)} L${f(base.x)},${f(base.y)}`;
        const nx = -u.y * HEAD_W / 2, ny = u.x * HEAD_W / 2;
        const wing = add(p3, u, -HEAD_L - 1.5), notch = add(p3, u, -HEAD_L + 2.5);
        const head = `M${f(p3.x)},${f(p3.y)} L${f(wing.x + nx)},${f(wing.y + ny)} L${f(notch.x)},${f(notch.y)} L${f(wing.x - nx)},${f(wing.y - ny)} Z`;

        const g = svg('g', { class: 'pw-arrow' + (b.offscreen ? ' pw-arrow-off' : '') + (this.extHome && this.extHome.has(b.id) ? ' pw-arrow-ext' : ''), 'data-from': b.id, 'data-to': inf.to });
        g.appendChild(svg('path', { d, class: 'pw-arrow-halo' }));
        g.appendChild(svg('path', { d, class: 'pw-arrow-line', stroke: color }));
        g.appendChild(svg('circle', { cx: f(p0.x), cy: f(p0.y), r: '3.2', class: 'pw-arrow-origin', fill: color }));
        g.appendChild(svg('path', { d: head, class: 'pw-arrow-head', fill: color }));
        if (inf.note) {
          const mx = (q1.x + 3 * c1.x + 3 * c2.x + q2.x) / 8, my = (q1.y + 3 * c1.y + 3 * c2.y + q2.y) / 8;
          const label = svg('text', { x: f(mx), y: f(my - 6), class: 'pw-arrow-label', 'text-anchor': 'middle' });
          label.textContent = inf.note.length > 48 ? `${inf.note.slice(0, 47)}…` : inf.note;
          g.appendChild(label);
        }
        sv.appendChild(g);
      }
    }
  }
}

/* ----------------------------------------------------------------- settings */

class PlotWeaverSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const c = this.containerEl;
    c.empty();
    const s = this.plugin.data.settings;
    new Setting(c).setName('Notes folder').setDesc('Where scene notes and exported outlines are created (a sub-folder per novel).')
      .addText(t => t.setPlaceholder('Novel Notes').setValue(s.notesFolder).onChange(v => { s.notesFolder = v.trim(); this.plugin.requestSave(); }));

    c.createEl('h3', { text: 'Scene note templates' });
    new Setting(c).setName('Templates folder').setDesc('Notes in this folder are offered as templates when you create a scene note.')
      .addText(t => t.setPlaceholder('Templates').setValue(s.templateFolder).onChange(v => { s.templateFolder = v.trim(); this.plugin.requestSave(); }));
    new Setting(c).setName('Default template').setDesc(s.defaultTemplate || 'Built-in scene note (properties + summary).')
      .addButton(b => b.setButtonText('Choose…').onClick(() => {
        this.plugin.pickTemplate('Default scene template', '', path => { s.defaultTemplate = path || ''; this.plugin.requestSave(); this.display(); });
      }))
      .addButton(b => b.setButtonText('Use built-in').onClick(() => { s.defaultTemplate = ''; this.plugin.requestSave(); this.display(); }));
    new Setting(c).setName('Ask which template each time').setDesc('Off: “Create note” uses the default template straight away.')
      .addToggle(t => t.setValue(s.askTemplate).onChange(v => { s.askTemplate = v; this.plugin.requestSave(); }));
    new Setting(c).setName('Add Plot Weaver properties').setDesc('Add novel, plotline, POV, story time and chapter to the new note’s properties, alongside whatever your template has.')
      .addToggle(t => t.setValue(s.addProperties).onChange(v => { s.addProperties = v; this.plugin.requestSave(); }));
    const vars = c.createDiv('pw-muted pw-vars');
    vars.setText('Template variables: {{title}} {{summary}} {{novel}} {{plotline}} {{pov}} {{when}} {{chapter}} {{part}} {{offscreen}} {{status}} {{shapedBy}} {{leadsTo}} {{date}} {{time}} {{id}}. Anything else (e.g. Templater <% %> code) is left untouched.');

    c.createEl('h3', { text: 'Board' });
    new Setting(c).setName('Full screen fills the display').setDesc('When you turn on full screen, also make the Obsidian window full screen (desktop). Off: the board just fills the Obsidian window.')
      .addToggle(t => t.setValue(s.fullscreenWindow).onChange(v => { s.fullscreenWindow = v; this.plugin.requestSave(); }));
    new Setting(c).setName('Confirm before deleting').setDesc('Ask before permanently deleting an idea. (Archiving never asks.)')
      .addToggle(t => t.setValue(s.confirmDelete).onChange(v => { s.confirmDelete = v; this.plugin.requestSave(); }));
    new Setting(c).setName('Column width').setDesc('Width of each board column, in pixels.')
      .addSlider(sl => sl.setLimits(160, 360, 10).setValue(s.columnWidth).setDynamicTooltip().onChange(v => { s.columnWidth = v; this.plugin.commit(); }));
    new Setting(c).setName('Plotline label width').addSlider(sl => sl.setLimits(120, 280, 10).setValue(s.laneWidth).setDynamicTooltip()
      .onChange(v => { s.laneWidth = v; this.plugin.commit(); }));
  }
}

/* ------------------------------------------------------------------- plugin */

class PlotWeaverPlugin extends Plugin {
  async onload() {
    await this.loadAll();
    this.registerView(VIEW_TYPE, leaf => new PlotWeaverView(leaf, this));
    this.addRibbonIcon('git-fork', 'Open Plot Weaver', () => this.activateView());
    this.addCommand({ id: 'open-board', name: 'Open board', callback: () => this.activateView() });
    this.addCommand({
      id: 'capture-idea', name: 'Capture an idea',
      callback: () => new TextPromptModal(this.app, 'Capture an idea', 'Idea…', '', title => {
        this.activeNovel().beats.push(makeBeat({ title, shelfOrder: Date.now() }));
        this.commit();
        new Notice(`Added to Unplaced: “${title}”`);
      }).open(),
    });
    this.addCommand({
      id: 'toggle-fullscreen', name: 'Toggle full screen',
      callback: async () => {
        let view = this.boardView();
        if (!view) { await this.activateView(); view = this.boardView(); }
        if (view) view.setFullscreen(!view.isFullscreen);
      },
    });
    this.addCommand({ id: 'export-outline', name: 'Export outline to note', callback: () => this.exportOutline(this.activeNovel()) });
    this.addCommand({ id: 'manage', name: 'Manage plotlines, POVs, story time and chapters', callback: () => new ManageModal(this).open() });
    this.addCommand({ id: 'add-example', name: 'Add example series (linked novels)', callback: () => { this.addSeries(makeExampleSeries()); this.activateView(); } });
    this.addSettingTab(new PlotWeaverSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      let hit = false;
      for (const n of this.data.novels) for (const b of n.beats) if (b.notePath === oldPath) { b.notePath = file.path; hit = true; }
      if (this.data.settings.defaultTemplate === oldPath) { this.data.settings.defaultTemplate = file.path; hit = true; }
      if (hit) this.commit();
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      let hit = false;
      for (const n of this.data.novels) for (const b of n.beats) if (b.notePath === file.path) { b.notePath = null; hit = true; }
      if (hit) this.commit();
    }));
  }

  onunload() {
    this.leaveFullscreen();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveData(this.data); }
  }

  async loadAll() {
    const d = (await this.loadData()) || {};
    this.data = {
      novels: (d.novels || []).map(normalizeNovel),
      activeNovelId: d.activeNovelId,
      settings: Object.assign({}, DEFAULT_SETTINGS, d.settings),
      ui: Object.assign({}, DEFAULT_UI, d.ui, d.ui && d.ui.showShelf === false && d.ui.shelfCollapsed === undefined ? { shelfCollapsed: true } : {}),
    };
    if (!this.data.novels.length) {
      const series = makeExampleSeries();
      this.data.novels.push(...series);
      this.data.activeNovelId = series[1].id;
    }
    // Drop links to novels or events that no longer exist.
    const novels = this.data.novels;
    for (const nv of novels) {
      nv.links = nv.links.filter(id => XN.novel(novels, id));
      for (const b of nv.beats) {
        b.influences = b.influences.filter(i => { const tn = XN.novel(novels, XN.targetNovelId(nv, i)); return tn && NV.beat(tn, i.to); });
      }
    }
  }

  activeNovel() {
    const d = this.data;
    let n = d.novels.find(x => x.id === d.activeNovelId);
    if (!n) { n = d.novels[0]; d.activeNovelId = n.id; }
    return n;
  }

  requestSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveData(this.data); }, 300);
  }
  refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof PlotWeaverView) leaf.view.render();
    }
  }
  refreshViewsSoon() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshViews(), 250);
  }
  commit() { this.requestSave(); this.refreshViews(); }
  boardView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return leaf && leaf.view instanceof PlotWeaverView ? leaf.view : null;
  }
  /** Notes open in a normal tab, which the full-screen board would cover, so step out first. */
  leaveFullscreen() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof PlotWeaverView) leaf.view.setFullscreen(false);
    }
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /* ---- structure edits */

  addNovel(novel) {
    this.data.novels.push(novel);
    this.data.activeNovelId = novel.id;
    this.commit();
  }
  addSeries(list) {
    this.data.novels.push(...list);
    this.data.activeNovelId = (list[1] || list[0]).id;
    this.commit();
  }
  openNovel(id) {
    this.data.activeNovelId = id;
    this.commit();
  }
  deleteNovel(id) {
    this.data.novels = this.data.novels.filter(n => n.id !== id);
    XN.purgeNovel(this.data.novels, id);
    if (!this.data.novels.length) this.data.novels.push(makeNovel('My Novel'));
    this.data.activeNovelId = this.data.novels[0].id;
    this.commit();
  }
  addPlotline(n) {
    new TextPromptModal(this.app, 'New plotline', 'e.g. The romance, The villain’s scheme…', '', name => {
      n.plotlines.push({ id: uid(), name, color: nextColor(n.plotlines.map(p => p.color)), description: '', archived: false, collapsed: false });
      this.commit();
    }).open();
  }
  renamePlotline(n, p) {
    new TextPromptModal(this.app, 'Rename plotline', 'Name', p.name, v => { p.name = v; this.commit(); }).open();
  }
  deletePlotline(n, p, after) {
    const count = n.beats.filter(b => b.plotlineId === p.id).length;
    new ConfirmModal(this.app, 'Delete plotline?',
      `Delete “${p.name}”?${count ? ` Its ${plural(count, 'event')} will move to the Unplaced shelf — nothing is lost.` : ''} Tip: archiving hides a plotline without deleting it.`,
      'Delete plotline', () => {
        n.plotlines = n.plotlines.filter(x => x.id !== p.id);
        n.beats.forEach(b => { if (b.plotlineId === p.id) { b.plotlineId = null; b.shelfOrder = Date.now(); } });
        this.commit();
        if (after) after();
      }).open();
  }
  addSlot(n, index) {
    new TextPromptModal(this.app, 'New story-time event', 'e.g. The wedding, Day 3, Ten years earlier…', '', label => {
      n.slots.splice(Math.max(0, Math.min(index, n.slots.length)), 0, { id: uid(), label });
      this.commit();
    }).open();
  }
  renameSlot(n, s) {
    new TextPromptModal(this.app, 'Rename story-time event', 'Label', s.label, v => { s.label = v; this.commit(); }).open();
  }
  deleteSlot(n, s, after) {
    const count = n.beats.filter(b => b.slotId === s.id && b.status === 'active').length;
    const go = () => {
      n.slots = n.slots.filter(x => x.id !== s.id);
      n.beats.forEach(b => { if (b.slotId === s.id) { b.slotId = null; b.shelfOrder = Date.now(); } });
      this.commit();
      if (after) after();
    };
    if (!count) { go(); return; }
    new ConfirmModal(this.app, 'Delete story-time event?', `Delete “${s.label}”? Its ${plural(count, 'event')} lose their story time. Those already in a chapter stay in it; the rest move to the Unplaced shelf.`, 'Delete', go).open();
  }
  addChapter(n, index) { this.addSection(n, 'chapter', index); }
  /** Add a chapter, part, prologue, interlude or epilogue. Prologues go first and epilogues last unless a position is given. */
  addSection(n, kind, index, then) {
    const info = SECTION_KINDS.find(k => k.key === kind) || SECTION_KINDS[2];
    new TextPromptModal(this.app, `New ${info.label.toLowerCase()}`, 'Title', NV.defaultSectionTitle(n, info.key), title => {
      let at = index;
      if (at === null || at === undefined) at = info.key === 'prologue' ? 0 : n.chapters.length;
      const sec = { id: uid(), title, kind: info.key };
      n.chapters.splice(Math.max(0, Math.min(at, n.chapters.length)), 0, sec);
      if (then) then(sec);
      this.commit();
    }).open();
  }
  addSectionMenu(n, index, evt) {
    const m = new Menu();
    for (const k of SECTION_KINDS) {
      m.addItem(it => it.setTitle(k.label).setIcon(k.icon).onClick(() => this.addSection(n, k.key, k.key === 'prologue' && index === n.chapters.length ? null : index)));
    }
    if (evt) m.showAtMouseEvent(evt);
    else m.showAtPosition({ x: window.innerWidth / 2, y: window.innerHeight / 3 });
  }
  setSectionKind(n, sec, kind, after) {
    const old = NV.kind(sec);
    if (old === kind) return;
    const info = SECTION_KINDS.find(k => k.key === kind);
    const oldInfo = SECTION_KINDS.find(k => k.key === old);
    // Swap a default-looking prefix ("Chapter 6: Two Lanterns") for the new kind's numbering ("Interlude 2: Two Lanterns"); keep custom titles.
    const m = (sec.title || '').match(new RegExp(`^${oldInfo.label}(?:\\s+[0-9IVXLC]+)?(.*)$`, 'i'));
    const base = NV.defaultSectionTitle(n, kind);
    if (!sec.title) sec.title = base;
    else if (m) sec.title = base + m[1];
    sec.kind = kind;
    this.commit();
    if (after) after();
  }

  renameChapter(n, ch) {
    new TextPromptModal(this.app, `Rename ${NV.kindInfo(ch).label.toLowerCase()}`, 'Title', ch.title, v => { ch.title = v; this.commit(); }).open();
  }
  deleteChapter(n, ch, after) {
    const count = n.beats.filter(b => b.chapterId === ch.id).length;
    const go = () => {
      n.chapters = n.chapters.filter(x => x.id !== ch.id);
      n.beats.forEach(b => { if (b.chapterId === ch.id) { b.chapterId = null; if (!NV.isPlaced(n, b)) b.shelfOrder = Date.now(); } });
      this.commit();
      if (after) after();
    };
    if (!count) { go(); return; }
    const label = NV.kindInfo(ch).label.toLowerCase();
    new ConfirmModal(this.app, `Delete ${label}?`, `Delete “${ch.title}”? Its ${plural(count, 'card')} stay on the board in story time, just without a ${label}.`, `Delete ${label}`, go).open();
  }
  deleteBeat(n, b) {
    const go = () => { NV.remove(n, b.id); XN.purgeBeat(this.data.novels, b.id); this.commit(); new Notice(`Deleted “${b.title}”`); };
    if (!this.data.settings.confirmDelete) { go(); return; }
    new ConfirmModal(this.app, 'Delete permanently?', `Delete “${b.title}”? This can’t be undone. (Archive it instead to keep it out of the way.)`, 'Delete', go).open();
  }

  /* ---- vault integration: notes and templates */

  novelFolder(n) {
    return normalizePath([this.data.settings.notesFolder, sanitizeFileName(n.title)].filter(Boolean).join('/'));
  }
  async ensureFolder(path) {
    let cur = '';
    for (const part of normalizePath(path).split('/').filter(Boolean)) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) await this.app.vault.createFolder(cur);
    }
  }
  noteVars(n, b) {
    const p = NV.plotline(n, b.plotlineId), pov = NV.pov(n, b.povId), s = NV.timeOf(n, b);
    const ch = NV.hasChapter(n, b) ? NV.chapter(n, b.chapterId) : null;
    const ref = x => (x.notePath ? `[[${x.notePath.replace(/\.md$/, '')}|${x.title}]]` : x.title);
    const now = new Date();
    return {
      title: b.title, summary: b.summary || '', novel: n.title,
      plotline: p ? p.name : '', pov: pov ? pov.name : '', when: s ? s.label : '', chapter: ch ? ch.title : '',
      part: ch ? (NV.kind(ch) === 'part' ? ch.title : ((NV.partOf(n, ch.id) || {}).title || '')) : '',
      offscreen: String(!!b.offscreen), status: b.status, id: b.id,
      date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
      shapedBy: XN.incoming(this.data.novels, n, b.id).map(x => `- ${x.fromNovel.id !== n.id ? `${x.fromNovel.title} › ` : ''}${ref(x.from)}${x.from.offscreen ? ' (off-screen)' : ''}${x.note ? ` — ${x.note}` : ''}`).join('\n'),
      leadsTo: XN.outgoing(this.data.novels, n, b).map(x => `- ${x.toNovel.id !== n.id ? `${x.toNovel.title} › ` : ''}${ref(x.to)}${x.note ? ` — ${x.note}` : ''}`).join('\n'),
    };
  }
  noteProps(n, b) {
    const v = this.noteVars(n, b);
    return { novel: v.novel, plotline: v.plotline, pov: v.pov, when: v.when, chapter: v.chapter, offscreen: !!b.offscreen, 'plot-weaver-id': b.id };
  }
  builtInNote(n, b) {
    const q = v => `"${String(v === undefined || v === null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    const props = this.noteProps(n, b);
    const fm = Object.keys(props).map(k => `${k}: ${typeof props[k] === 'boolean' ? props[k] : q(props[k])}`);
    return ['---', ...fm, '---', '', `# ${b.title}`, '', b.summary || '', ''].join('\n');
  }
  fillTemplate(text, n, b) {
    const v = this.noteVars(n, b);
    return text.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(v, k) ? v[k] : m));
  }
  templateFiles() {
    const folder = normalizePath(this.data.settings.templateFolder || '');
    if (!folder) return [];
    return this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(`${folder}/`)).sort((a, b) => a.path.localeCompare(b.path));
  }
  /** Pick a template; calls back with a path ('' = built-in). */
  pickTemplate(title, intro, cb) {
    const s = this.data.settings;
    const items = [{ label: 'Built-in scene note', desc: 'Plot Weaver properties, title and summary', value: '' }];
    for (const f of this.templateFiles()) items.push({ label: f.basename, desc: f.path + (f.path === s.defaultTemplate ? ' · default' : ''), value: f.path });
    items.push({ label: 'Use any note as the template…', value: '__any', sticky: true });
    new PickerModal(this.app, title, items, v => {
      if (v !== '__any') { cb(v); return; }
      const all = this.app.vault.getMarkdownFiles().map(f => ({ label: f.basename, desc: f.path, value: f.path }));
      new PickerModal(this.app, 'Choose a note to use as the template', all, cb, { placeholder: 'Search notes…' }).open();
    }, {
      selected: s.defaultTemplate || '', intro,
      empty: 'No templates found.',
    }).open();
  }
  /** "Create note": choose a template (or link an existing note), then create and open. */
  createNoteFlow(n, b) {
    const s = this.data.settings;
    if (!s.askTemplate) { this.createNote(n, b, s.defaultTemplate || ''); return; }
    const folder = s.templateFolder ? `Templates come from “${s.templateFolder}” (change in settings).` : 'Set a templates folder in settings to list your templates here.';
    this.pickTemplate(`Create note for “${b.title}”`, folder, path => this.createNote(n, b, path));
  }
  linkExistingNote(n, b) {
    const items = this.app.vault.getMarkdownFiles()
      .sort((a, c) => (c.stat && a.stat ? c.stat.mtime - a.stat.mtime : a.path.localeCompare(c.path)))
      .map(f => ({ label: f.basename, desc: f.path, value: f.path }));
    new PickerModal(this.app, `Link a note to “${b.title}”`, items, path => {
      b.notePath = path;
      this.commit();
      new Notice(`Linked “${b.title}” to ${path}`);
    }, { placeholder: 'Search notes…', empty: 'No notes match.' }).open();
  }
  async createNote(n, b, templatePath) {
    try {
      const folder = this.novelFolder(n);
      await this.ensureFolder(folder);
      const path = normalizePath(`${folder}/${sanitizeFileName(b.title)}.md`);
      let file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        new Notice(`A note named “${file.basename}” already exists — linked to it instead.`);
      } else {
        let content = null;
        if (templatePath) {
          const t = this.app.vault.getAbstractFileByPath(templatePath);
          if (t instanceof TFile) content = this.fillTemplate(await this.app.vault.read(t), n, b);
          else new Notice(`Template not found (${templatePath}); used the built-in note.`);
        }
        const usedTemplate = content !== null;
        if (!usedTemplate) content = this.builtInNote(n, b);
        file = await this.app.vault.create(path, content);
        if (usedTemplate && this.data.settings.addProperties && this.app.fileManager && this.app.fileManager.processFrontMatter) {
          const props = this.noteProps(n, b);
          await this.app.fileManager.processFrontMatter(file, fm => {
            for (const k of Object.keys(props)) if (fm[k] === undefined || fm[k] === null || fm[k] === '') fm[k] = props[k];
          });
        }
      }
      b.notePath = file.path;
      this.commit();
      this.leaveFullscreen(); await this.app.workspace.getLeaf('tab').openFile(file);
    } catch (err) {
      console.error('Plot Weaver', err);
      new Notice(`Plot Weaver couldn’t create the note: ${err.message}`);
    }
  }
  async openNote(n, b) {
    const file = b.notePath ? this.app.vault.getAbstractFileByPath(b.notePath) : null;
    if (file instanceof TFile) { this.leaveFullscreen(); await this.app.workspace.getLeaf('tab').openFile(file); return; }
    if (b.notePath) { b.notePath = null; this.commit(); new Notice('The linked note no longer exists.'); }
    this.createNoteFlow(n, b);
  }

  buildOutlineMarkdown(n) {
    const L = [];
    const one = s => (s || '').replace(/\s*\n\s*/g, ' ');
    const novels = this.data.novels;
    L.push(`# ${n.title}: Outline`, '', `*Exported from Plot Weaver, ${new Date().toLocaleString()}*`, '');
    const up = XN.upstream(novels, n), down = XN.downstream(novels, n);
    if (up.length) L.push(`**Draws on:** ${up.map(x => x.title).join(', ')}  `);
    if (down.length) L.push(`**Shapes:** ${down.map(x => x.title).join(', ')}`);
    if (up.length || down.length) L.push('');
    const ext = XN.externals(novels, n).filter(g => g.beats.length);
    if (ext.length) {
      L.push('## From linked novels');
      for (const g of ext) {
        L.push('', `### ${g.novel.title}`);
        for (const b of g.beats) {
          const t = XN.outgoing(novels, g.novel, b).filter(x => x.toNovel.id === n.id);
          L.push(`- **${b.title}**${b.offscreen ? ' _(off-screen)_' : ''} → ${t.map(x => x.to.title + (x.note ? ` (${one(x.note)})` : '')).join('; ')}`);
        }
      }
      L.push('');
    }
    const lanes = n.plotlines.filter(p => !p.archived);
    L.push('## Plotlines');
    for (const p of lanes) L.push(`- **${p.name}**${p.description ? ` — ${one(p.description)}` : ''}`);
    if (n.povs.length) {
      L.push('', '## POV characters');
      for (const p of n.povs) L.push(`- **${p.name}** (${plural(n.beats.filter(b => b.povId === p.id && NV.onBoard(n, b)).length, 'scene')})`);
    }
    L.push('', '## Manuscript');
    const onscreen = NV.manuscript(n);
    const nums = new Map(onscreen.filter(b => !NV.isSummary(n, b)).map((b, i) => [b.id, i + 1]));
    const hasParts = n.chapters.some(c => NV.kind(c) === 'part');
    for (const g of NV.groups(n, NV.withOffscreen(n, onscreen))) {
      if (!g.items.length && !g.chapter) continue;
      const kind = g.chapter ? NV.kind(g.chapter) : null;
      const level = hasParts && kind !== 'part' ? '####' : '###';
      L.push('', `${level} ${g.chapter ? g.chapter.title : 'Not in a chapter yet'}`);
      if (!g.items.length && kind !== 'part') L.push('*(empty)*');
      const ordered = g.items.filter(b => NV.isSummary(n, b)).concat(g.items.filter(b => !NV.isSummary(n, b)));
      for (const b of ordered) {
        const p = NV.plotline(n, b.plotlineId), s = NV.timeOf(n, b);
        if (NV.isSummary(n, b)) {
          L.push(`> **${b.title}**${b.summary ? ` — ${one(b.summary)}` : ''}`);
          continue;
        }
        if (b.offscreen) {
          const t = XN.outgoing(novels, n, b).map(x => XN.name(n, x.toNovel, x.to) + (x.note ? ` (${one(x.note)})` : ''));
          L.push(`- *Meanwhile, off-screen (${s.label}, ${p.name}):* ${b.title}${t.length ? ` → ${t.join('; ')}` : ''}`);
          continue;
        }
        const pov = NV.pov(n, b.povId);
        const bits = [p.name, pov ? `POV: ${pov.name}` : null, s ? `When: ${s.label}` : 'When: —'].filter(Boolean);
        L.push(`${nums.get(b.id)}. **${b.title}** — ${bits.join(' · ')}`);
        if (b.summary) L.push(`    ${one(b.summary)}`);
        const inc = XN.incoming(novels, n, b.id);
        if (inc.length) L.push(`    *Shaped by:* ${inc.map(x => XN.name(n, x.fromNovel, x.from) + (x.from.offscreen ? ' (off-screen)' : '') + (x.note ? ` — ${one(x.note)}` : '')).join('; ')}`);
        const outs = XN.outgoing(novels, n, b);
        if (outs.length) L.push(`    *Leads to:* ${outs.map(x => XN.name(n, x.toNovel, x.to) + (x.note ? ` — ${one(x.note)}` : '')).join('; ')}`);
        if (b.notePath) L.push(`    [[${b.notePath.replace(/\.md$/, '')}|Scene note]]`);
      }
    }
    L.push('', '## Story-world timeline');
    n.slots.forEach((s, i) => {
      const rows = [];
      for (const p of lanes) for (const b of NV.cell(n, s.id, p.id)) {
        const ch = NV.hasChapter(n, b) ? ` [${NV.chapter(n, b.chapterId).title}]` : '';
        rows.push(`- *${p.name}:* ${b.title}${b.offscreen ? ' _(off-screen)_' : ch}`);
        for (const x of XN.outgoing(novels, n, b)) rows.push(`    - → ${XN.name(n, x.toNovel, x.to)}${x.note ? ` (${one(x.note)})` : ''}`);
      }
      if (rows.length) L.push('', `### ${i + 1}. ${s.label}`, ...rows);
    });
    for (const [kind, title] of [['unplaced', 'Unplaced ideas'], ['parked', 'Saved for later'], ['archived', 'Archive']]) {
      const items = NV.shelf(n, kind);
      if (!items.length) continue;
      L.push('', `## ${title}`);
      for (const b of items) L.push(`- ${b.title}${b.summary ? ` — ${one(b.summary)}` : ''}`);
    }
    return L.join('\n') + '\n';
  }

  async exportOutline(n) {
    try {
      const folder = this.novelFolder(n);
      await this.ensureFolder(folder);
      const path = normalizePath(`${folder}/${sanitizeFileName(n.title)} - Outline.md`);
      const md = this.buildOutlineMarkdown(n);
      let file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) await this.app.vault.modify(file, md);
      else file = await this.app.vault.create(path, md);
      this.leaveFullscreen(); await this.app.workspace.getLeaf('tab').openFile(file);
      new Notice(`Outline exported to ${path}`);
    } catch (err) {
      console.error('Plot Weaver', err);
      new Notice(`Plot Weaver couldn’t export: ${err.message}`);
    }
  }
}

PlotWeaverPlugin.internals = { NV, makeBeat, makeNovel, makeExampleNovel, normalizeNovel, PlotWeaverView, VIEW_TYPE };
module.exports = PlotWeaverPlugin;
