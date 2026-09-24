/** A dependency-free memory workbench. The server remains the authority; this is only a client. */
export const memoryUiHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Riko Memory · 记忆工作台</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0a0d14;
      --panel: rgba(19, 24, 36, .88);
      --line: rgba(155, 176, 220, .14);
      --line-strong: rgba(155, 176, 220, .28);
      --text: #f2f5fb;
      --muted: #8d9ab2;
      --muted-strong: #b9c5d9;
      --blue: #83a9ff;
      --mint: #7ad9b4;
      --amber: #f3bd78;
      --rose: #f08b9e;
      --shadow: 0 24px 70px rgba(0, 0, 0, .28);
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      background: var(--bg);
      color: var(--text);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 78% -8%, #233861 0, transparent 34rem), radial-gradient(circle at 18% 35%, #142a30 0, transparent 28rem), var(--bg); }
    body::before { content: ''; position: fixed; inset: 0; pointer-events: none; background-image: linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px); background-size: 46px 46px; mask-image: linear-gradient(to bottom, rgba(0,0,0,.6), transparent 82%); }
    button, input, textarea { color: inherit; font: inherit; }
    button { border: 0; cursor: pointer; }
    button:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
    button:disabled { opacity: .5; cursor: wait; }
    .app-shell { display: grid; grid-template-columns: 246px minmax(0, 1fr); max-width: 1540px; min-height: 100vh; margin: 0 auto; }
    .sidebar { position: sticky; top: 0; display: flex; flex-direction: column; height: 100vh; padding: 28px 16px 20px; border-right: 1px solid var(--line); background: rgba(11, 15, 24, .68); backdrop-filter: blur(24px); z-index: 5; }
    .brand { display: flex; gap: 11px; align-items: center; padding: 0 10px 28px; }
    .brand-mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 11px; color: #08101b; font-size: 18px; font-weight: 800; background: linear-gradient(145deg, #b2d8ff, #74d7c1); box-shadow: 0 8px 22px rgba(106, 189, 215, .2); }
    .brand strong { display: block; font-size: 14px; letter-spacing: .02em; }
    .brand small { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
    .side-label { padding: 0 10px 9px; color: #66738b; font-size: 10px; font-weight: 750; letter-spacing: .14em; text-transform: uppercase; }
    .layer-nav { display: grid; gap: 6px; }
    .layer-link { display: grid; grid-template-columns: 31px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 10px; border-radius: 11px; color: var(--muted-strong); background: transparent; text-align: left; transition: background .18s ease, transform .18s ease; }
    .layer-link:hover { background: rgba(131, 169, 255, .09); transform: translateX(2px); }
    .layer-index { color: #66758f; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .layer-link strong { display: block; color: var(--text); font-size: 13px; font-weight: 650; }
    .layer-link small { display: block; margin-top: 3px; color: var(--muted); font-size: 10px; }
    .layer-count { min-width: 24px; padding: 3px 6px; border-radius: 999px; color: #c8d8ff; background: #263655; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; text-align: center; }
    .sidebar-spacer { flex: 1; }
    .side-note { margin: 18px 5px 0; padding: 13px; border: 1px solid var(--line); border-radius: 13px; background: rgba(22, 29, 43, .65); }
    .side-note span { display: block; color: var(--mint); font-size: 11px; font-weight: 700; }
    .side-note p { margin: 7px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
    .main { min-width: 0; padding: 0 36px 60px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 72px; border-bottom: 1px solid var(--line); }
    .crumb { color: var(--muted); font-size: 12px; }
    .crumb b { color: var(--muted-strong); font-weight: 600; }
    .top-actions { display: flex; align-items: center; gap: 8px; }
    .token-wrap { display: flex; gap: 6px; }
    input, textarea { width: 100%; border: 1px solid var(--line-strong); border-radius: 9px; padding: 10px 11px; background: rgba(10, 14, 23, .72); color: var(--text); font-size: 13px; }
    input::placeholder, textarea::placeholder { color: #66738a; }
    textarea { min-height: 126px; resize: vertical; line-height: 1.6; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 0 13px; border: 1px solid transparent; border-radius: 9px; color: #09101a; background: var(--blue); font-size: 12px; font-weight: 700; transition: transform .15s ease, filter .15s ease, background .15s ease; }
    .btn:hover { filter: brightness(1.08); transform: translateY(-1px); }
    .btn.secondary { color: var(--muted-strong); border-color: var(--line-strong); background: rgba(32, 43, 64, .72); }
    .btn.ghost { color: var(--muted-strong); border-color: transparent; background: transparent; }
    .btn.danger { color: #ffdfe4; border-color: rgba(240, 139, 158, .3); background: rgba(121, 49, 69, .65); }
    .btn.mint { color: #071711; background: var(--mint); }
    #error { display: none; margin: 16px 0 -2px; padding: 11px 13px; border: 1px solid rgba(240, 139, 158, .35); border-radius: 10px; color: #ffdbe1; background: rgba(112, 40, 58, .72); font-size: 12px; }
    #notice { display: none; position: fixed; right: 28px; bottom: 26px; z-index: 10; padding: 11px 14px; border: 1px solid rgba(122, 217, 180, .3); border-radius: 10px; color: #d9fff0; background: rgba(17, 62, 50, .92); box-shadow: var(--shadow); font-size: 12px; }
    .hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 30px; padding: 54px 0 36px; }
    .eyebrow { display: flex; align-items: center; gap: 8px; color: var(--mint); font-size: 11px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; }
    .eyebrow::before { content: ''; width: 22px; height: 1px; background: var(--mint); }
    h1, h2, h3, p { margin: 0; }
    h1 { max-width: 760px; margin-top: 14px; color: #f8fbff; font-size: clamp(30px, 4vw, 54px); font-weight: 720; letter-spacing: -.045em; line-height: 1.04; }
    .hero-copy { max-width: 650px; margin-top: 17px; color: var(--muted-strong); font-size: 14px; line-height: 1.7; }
    .hero-actions { display: flex; gap: 8px; flex: 0 0 auto; margin-top: 22px; }
    .hero-status { min-width: 190px; padding: 15px; border: 1px solid var(--line); border-radius: 14px; background: linear-gradient(145deg, rgba(30, 43, 64, .82), rgba(18, 24, 37, .72)); }
    .hero-status .status-line { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 11px; }
    .status-dot { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 0 4px rgba(122, 217, 180, .1); }
    .hero-status strong { display: block; margin-top: 9px; color: var(--text); font-size: 18px; }
    .hero-status small { display: block; margin-top: 4px; color: var(--muted); font-size: 10px; }
    .section { scroll-margin-top: 22px; margin-top: 18px; }
    .section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 15px; margin-bottom: 12px; }
    .section-kicker { color: #66748d; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: .06em; }
    h2 { margin-top: 4px; color: #f2f6ff; font-size: 20px; letter-spacing: -.025em; }
    h3 { color: var(--text); font-size: 14px; font-weight: 680; }
    .section-desc { margin-top: 6px; color: var(--muted); font-size: 12px; line-height: 1.5; }
    .panel { border: 1px solid var(--line); border-radius: 17px; background: var(--panel); box-shadow: 0 12px 35px rgba(0, 0, 0, .12); backdrop-filter: blur(18px); }
    .panel-pad { padding: 20px; }
    .pipeline { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; overflow: hidden; border: 1px solid var(--line); border-radius: 17px; background: var(--line); box-shadow: var(--shadow); }
    .stage { position: relative; min-height: 146px; padding: 18px; background: rgba(20, 27, 41, .92); }
    .stage:first-child { background: linear-gradient(145deg, rgba(34, 61, 71, .9), rgba(20, 28, 42, .94)); }
    .stage::after { content: '›'; position: absolute; top: 48px; right: -6px; z-index: 1; color: #566988; font-size: 26px; font-weight: 300; }
    .stage:last-child::after { display: none; }
    .stage-top { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 11px; }
    .stage-code { color: var(--blue); font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .stage strong { display: block; margin-top: 23px; color: #f7faff; font-size: 31px; font-weight: 700; letter-spacing: -.04em; }
    .stage p { margin-top: 4px; color: var(--muted-strong); font-size: 12px; }
    .stage small { display: block; margin-top: 13px; color: var(--muted); font-size: 10px; line-height: 1.45; }
    .two-col { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(310px, .65fr); gap: 18px; }
    .resident { min-height: 255px; }
    .resident pre { min-height: 173px; margin-top: 15px; overflow: auto; white-space: pre-wrap; word-break: break-word; border: 1px solid rgba(122, 217, 180, .14); border-radius: 11px; padding: 14px; color: #d9f9eb; background: rgba(7, 22, 22, .66); font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .resident-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 10px; color: var(--muted); font-size: 11px; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 15px; }
    .meta-box { padding: 11px; border: 1px solid var(--line); border-radius: 11px; background: rgba(31, 40, 57, .5); }
    .meta-box strong { display: block; margin-bottom: 6px; color: var(--muted); font-size: 10px; font-weight: 600; }
    .meta-box span { color: var(--muted-strong); font-size: 12px; word-break: break-word; }
    .panel-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .panel-toolbar input { min-width: 230px; flex: 1; }
    .wiki-layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); min-height: 520px; overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: rgba(11, 16, 26, .38); }
    .page-nav { padding: 10px; border-right: 1px solid var(--line); overflow: auto; }
    .tree-group { margin-bottom: 15px; }
    .tree-label { padding: 7px 9px 5px; color: #687791; font-size: 10px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
    .page-button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px; border-radius: 9px; color: var(--muted-strong); background: transparent; text-align: left; font-size: 12px; }
    .page-button:hover { background: rgba(131, 169, 255, .08); }
    .page-button.active { color: #fff; background: rgba(72, 105, 166, .55); box-shadow: inset 2px 0 var(--blue); }
    .page-bullet { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--blue); }
    .page-button[data-type="emotion"] .page-bullet { background: var(--rose); }
    .page-button[data-type="episode"] .page-bullet { background: var(--amber); }
    .page-button[data-type="source"] .page-bullet { background: #76849d; }
    .page-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .page-detail { min-width: 0; padding: 24px; }
    .empty { display: grid; place-items: center; min-height: 120px; padding: 20px; color: var(--muted); font-size: 13px; text-align: center; }
    .detail-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; }
    .detail-title { min-width: 0; }
    .detail-title h3 { overflow-wrap: anywhere; font-size: 22px; letter-spacing: -.03em; }
     .detail-title p { margin-top: 7px; color: var(--muted); font-size: 12px; line-height: 1.5; }
     .badge-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 13px; }
     .badge { display: inline-flex; align-items: center; min-height: 23px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 999px; color: #cbd8ee; background: rgba(42, 55, 82, .7); font-size: 10px; }
    .badge.green { color: #bdf4de; border-color: rgba(122, 217, 180, .3); background: rgba(31, 88, 71, .42); }
    .badge.amber { color: #ffe2b5; border-color: rgba(243, 189, 120, .3); background: rgba(111, 74, 39, .42); }
     .detail-block { margin-top: 23px; }
     .detail-block > h3 { margin-bottom: 9px; color: var(--muted-strong); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
     .frontmatter { overflow: auto; max-height: 220px; white-space: pre-wrap; border: 1px solid var(--line); border-radius: 10px; padding: 13px; color: #b8d1ff; background: rgba(8, 13, 22, .72); font: 11px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; }
     .redacted { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 13px; border: 1px solid rgba(240, 139, 158, .35); border-radius: 10px; color: #ffdbe1; background: rgba(112, 40, 58, .38); font-size: 12px; line-height: 1.5; }
     .edit-form { display: grid; gap: 10px; }
    .edit-form label, .settings-form label { display: grid; gap: 6px; color: var(--muted); font-size: 11px; }
    .edit-form .btn { justify-self: start; }
    .source-list, .relation-list { display: flex; gap: 7px; flex-wrap: wrap; }
    .source-chip { display: inline-flex; align-items: center; min-height: 26px; padding: 0 9px; border: 1px solid var(--line-strong); border-radius: 7px; color: #b9d0ff; background: rgba(39, 54, 84, .6); font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .source-chip.clickable { cursor: pointer; }
    .source-chip.clickable:hover { background: rgba(74, 104, 163, .65); }
    .relation-chip { padding: 6px 9px; border-radius: 7px; color: #c7d4e9; background: rgba(39, 48, 68, .7); font-size: 11px; }
    .detail-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 21px; }
    .graph-wrap { margin-top: 18px; border: 1px solid var(--line); border-radius: 13px; padding: 13px; background: rgba(8, 13, 22, .58); }
    .graph { min-height: 194px; overflow-x: auto; }
    .graph svg { width: 100%; min-width: 560px; height: 190px; }
    .graph text { fill: #d7e4ff; font-size: 11px; }
    .graph line { stroke: #536f9e; stroke-width: 1.5; }
    .graph circle { fill: #5084eb; stroke: #c2d7ff; stroke-width: 1; }
    .candidate-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .candidate { padding: 14px; border: 1px solid rgba(243, 189, 120, .2); border-radius: 12px; background: linear-gradient(145deg, rgba(62, 49, 35, .53), rgba(31, 33, 43, .66)); }
    .candidate h3 { line-height: 1.35; }
    .candidate p { margin-top: 8px; color: var(--muted-strong); font-size: 12px; line-height: 1.55; }
    .candidate small { display: block; margin-top: 10px; color: var(--muted); font-size: 10px; line-height: 1.5; }
    .candidate-actions { display: flex; gap: 7px; margin-top: 13px; }
    .sessions { display: grid; gap: 7px; }
    .session-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: rgba(27, 36, 53, .55); }
    .session-row code { overflow: hidden; color: #c8d6ed; font: 11px ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .settings-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .settings-form label:last-of-type { grid-column: 1 / -1; }
    .settings-form .btn { justify-self: start; }
    .settings-note { margin-top: 13px; color: var(--muted); font-size: 11px; line-height: 1.55; }
    .footer-note { margin-top: 36px; color: #66738a; font-size: 11px; text-align: center; }
    @media (max-width: 1120px) { .app-shell { grid-template-columns: 205px minmax(0, 1fr); } .main { padding: 0 24px 50px; } .hero { align-items: flex-start; flex-direction: column; } .hero-status { min-width: 230px; } }
    @media (max-width: 860px) { .app-shell { display: block; } .sidebar { position: static; height: auto; padding: 16px; border-right: 0; border-bottom: 1px solid var(--line); } .brand { padding-bottom: 16px; } .layer-nav { grid-template-columns: repeat(4, minmax(0, 1fr)); } .layer-link { display: block; padding: 9px; } .layer-link small { display: none; } .layer-count { float: right; } .sidebar-spacer, .side-note, .side-label { display: none; } .main { padding: 0 16px 40px; } .topbar { min-height: 62px; align-items: flex-start; flex-wrap: wrap; padding: 13px 0; } .top-actions { flex-wrap: wrap; justify-content: flex-end; } .token-wrap { display: flex; flex: 1 1 100%; order: 3; } .token-wrap input { min-width: 0; } .two-col { grid-template-columns: 1fr; } .candidate-grid { grid-template-columns: 1fr; } }
    @media (max-width: 620px) { .top-actions > #refresh { display: none; } .hero { padding: 35px 0 25px; } h1 { font-size: 34px; } .pipeline { grid-template-columns: 1fr 1fr; } .stage { min-height: 126px; padding: 13px; } .stage::after { display: none; } .stage strong { margin-top: 17px; font-size: 26px; } .wiki-layout { grid-template-columns: 1fr; } .page-nav { max-height: 230px; border-right: 0; border-bottom: 1px solid var(--line); } .page-detail { padding: 17px; } .settings-form { grid-template-columns: 1fr; } .settings-form label:last-of-type { grid-column: auto; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar" aria-label="记忆层级导航">
      <div class="brand"><div class="brand-mark">R</div><div><strong>Riko Memory</strong><small>server-side workbench</small></div></div>
      <div class="side-label">Memory layers</div>
      <nav class="layer-nav">
        <button class="layer-link" data-scroll="evidence-section"><span class="layer-index">01</span><span><strong>会话证据</strong><small>L0 · 原始材料</small></span><span id="nav-l0" class="layer-count">0</span></button>
        <button class="layer-link" data-scroll="candidate-section"><span class="layer-index">02</span><span><strong>候选事实</strong><small>L1 · 待确认</small></span><span id="nav-l1" class="layer-count">0</span></button>
        <button class="layer-link" data-scroll="wiki-section"><span class="layer-index">03</span><span><strong>Wiki 图谱</strong><small>L2 · 长期权威</small></span><span id="nav-l2" class="layer-count">0</span></button>
        <button class="layer-link" data-scroll="resident-section"><span class="layer-index">04</span><span><strong>注入提示词</strong><small>L3 · 当前上下文</small></span><span id="nav-l3" class="layer-count">0</span></button>
      </nav>
      <div class="sidebar-spacer"></div>
      <div class="side-note"><span><i class="status-dot"></i>服务器拥有记忆</span><p>聊天、整理、版本和注入都在服务端完成。这里是查看与修订入口，不是数据源。</p></div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="crumb">Memory / <b>个人记忆工作台</b></div>
        <div class="top-actions"><div class="token-wrap"><input id="token-input" type="password" placeholder="Bearer Token（可选）" aria-label="Bearer Token"><button id="save-token" class="btn secondary">应用</button></div><button id="refresh" class="btn secondary">刷新数据</button><button id="open-chat" class="btn ghost">返回聊天 ↗</button></div>
      </header>
      <div id="error" role="alert"></div><div id="notice" role="status"></div>
      <section class="hero">
        <div><div class="eyebrow">Personal memory system</div><h1>把每一次对话，整理成<br>真正可追溯的记忆。</h1><p class="hero-copy">从原始会话到候选事实，再到 Wiki 知识图谱和下一次对话的常驻提示词。你只需要查看结果、确认边界，或者直接修改已经存在的原文。</p><div class="hero-actions"><button id="dream-now" class="btn mint">立即整理 Dream <span>↗</span></button><button class="btn secondary" data-scroll="wiki-section">浏览 Wiki</button></div></div>
        <div class="hero-status"><div class="status-line"><span><i class="status-dot"></i>服务状态</span><span id="profile-label">—</span></div><strong id="health-label">正在读取…</strong><small id="updated-label">等待服务器返回最新状态</small></div>
      </section>
      <section class="section" aria-labelledby="pipeline-title"><div class="section-head"><div><div class="section-kicker">MEMORY PIPELINE</div><h2 id="pipeline-title">四层链路，一眼看清</h2><p class="section-desc">每一层都是真实数据，不是演示占位。</p></div></div>
        <div class="pipeline"><article class="stage"><div class="stage-top"><span class="stage-code">L0</span><span>原始证据</span></div><strong id="l0-count">0</strong><p>会话记录</p><small>JSONL 原文保留每次事件，作为后续整理依据。</small></article><article class="stage"><div class="stage-top"><span class="stage-code">L1</span><span>需要判断</span></div><strong id="l1-count">0</strong><p>候选事实</p><small>Dream 提取的页面变更，等待确认或自动合并。</small></article><article class="stage"><div class="stage-top"><span class="stage-code">L2</span><span>长期权威</span></div><strong id="l2-count">0</strong><p>Wiki 页面</p><small><span id="l2-edges">0</span> 条关系边，正文和来源可追溯。</small></article><article class="stage"><div class="stage-top"><span class="stage-code">L3</span><span>下一次对话</span></div><strong id="l3-count">0</strong><p>注入页面</p><small>只注入已确认、同意保存且仍有效的摘要。</small></article></div>
      </section>
      <section id="resident-section" class="section" aria-labelledby="resident-title"><div class="section-head"><div><div class="section-kicker">L3 · RESIDENT SNAPSHOT</div><h2 id="resident-title">下一次对话会看到什么</h2><p class="section-desc">当前自动注入的提示词会在这里显示：这是实际注入 DeepSeek Harness 的投影，不是完整 Wiki。</p></div><span id="resident-version" class="section-kicker">version —</span></div><div class="two-col"><div class="panel panel-pad resident"><pre id="resident">正在读取当前提示词…</pre><div class="resident-foot"><span>来源页面 <b id="resident-source-count">0</b></span><span>过期情绪会自动退出注入</span></div></div><div class="panel panel-pad"><div class="section-kicker">DREAM STATUS</div><h3 style="margin-top:8px">整理任务状态</h3><div id="status" class="meta-grid"></div><div class="detail-actions"><button id="status-dream" class="btn secondary">重新整理</button></div></div></div></section>
      <section id="wiki-section" class="section" aria-labelledby="wiki-title"><div class="section-head"><div><div class="section-kicker">L2 · CANONICAL WIKI</div><h2 id="wiki-title">Wiki 页面与关系图</h2><p class="section-desc">页面正文是长期记忆的权威来源；编辑现有页面会立即重建 Resident。</p></div><span id="wiki-count" class="section-kicker">0 个页面</span></div><div class="panel panel-pad"><div class="panel-toolbar"><input id="wiki-search" placeholder="搜索标题、偏好、经历或关系" aria-label="搜索 Wiki"><button id="search-button" class="btn">搜索</button><button id="all-pages" class="btn secondary">全部页面</button></div><div class="wiki-layout" style="margin-top:15px"><nav id="page-nav" class="page-nav" aria-label="Wiki 页面列表"></nav><article id="page-detail" class="page-detail"><div class="empty">从左侧选择一个页面，查看原文、frontmatter、来源和关系。</div></article></div><div class="graph-wrap"><div class="section-kicker">RELATION GRAPH</div><div id="graph" class="graph"><div class="empty">暂无关系图节点</div></div></div></div></section>
      <section id="candidate-section" class="section" aria-labelledby="candidate-title"><div class="section-head"><div><div class="section-kicker">L1 · CANDIDATES</div><h2 id="candidate-title">待确认候选事实</h2><p class="section-desc">模型推断不会直接进入常驻提示词；确认后才会成为锁定的 Wiki 页面。</p></div><span id="candidate-count" class="section-kicker">0 条</span></div><div id="candidates" class="candidate-grid"></div></section>
      <section id="evidence-section" class="section" aria-labelledby="evidence-title"><div class="section-head"><div><div class="section-kicker">L0 · SOURCE EVIDENCE</div><h2 id="evidence-title">会话证据</h2><p class="section-desc">原始记录只读保存，可从每个 Wiki 页面追溯回来。</p></div><span id="session-count" class="section-kicker">0 个会话</span></div><div class="panel panel-pad"><div id="sessions" class="sessions"></div></div><div id="evidence-card" class="panel panel-pad" style="display:none;margin-top:12px"><div class="section-head"><h3 id="evidence-heading">原始 JSONL</h3><button id="close-evidence" class="btn ghost">收起</button></div><pre id="evidence" class="frontmatter" style="max-height:420px;margin-top:10px"></pre></div></section>
      <section class="section" aria-labelledby="settings-title"><div class="section-head"><div><div class="section-kicker">SERVICE SETTINGS</div><h2 id="settings-title">记忆模型设置</h2><p class="section-desc">这个模型只负责 Dream 整理，与 DeepSeek Harness 的聊天模型完全独立。</p></div></div><div class="panel panel-pad"><div id="config" class="meta-grid"></div><form id="dream-form" class="settings-form" style="margin-top:15px"><label>API URL（Google 原生 generateContent 或兼容 Chat Completions）<input id="dream-api-url" type="url" placeholder="https://generativelanguage.googleapis.com/v1beta"></label><label>模型名称<input id="dream-model" placeholder="gemini-3.5-flash-lite"></label><label>Credential Ref（只填写引用名，不填写密钥）<input id="dream-credential-ref" autocomplete="off" placeholder="GEMINI_API_KEY"></label><button class="btn" type="submit">保存整理模型设置</button></form><p class="settings-note">密钥只能来自 DSH credentials 或进程环境；本页面不会接收、保存或回显 API key。</p></div></section>
      <p class="footer-note">Riko Memory · L0 evidence → L1 candidates → L2 Wiki → L3 resident prompt</p>
    </main>
  </div>
  <script>
    (() => {
      const apiRoot = location.pathname.replace(/\/ui\/?$/, '').replace(/\/$/, '') || '/memory/v1';
      const tokenKey = 'dsh-riko-memory-token'; const profileKey = 'dsh-riko-memory-profile';
      const token = () => sessionStorage.getItem(tokenKey) || '';
      const headers = () => { const value = {}; const bearer = token(); const profile = sessionStorage.getItem(profileKey); if (bearer) value.Authorization = 'Bearer ' + bearer; if (profile) value['x-dsh-memory-profile'] = profile; return value; };
      const request = async (path, options = {}) => { const response = await fetch(apiRoot + path, { ...options, headers: { ...headers(), ...(options.headers || {}) } }); const text = await response.text(); let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; } if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status)); return body; };
      const $ = id => document.getElementById(id); const node = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }; const time = value => value ? new Date(value).toLocaleString() : '—';
      const typeLabel = value => ({ source: '来源', entity: '实体', concept: '概念', episode: '经历', emotion: '情绪', relationship: '关系', synthesis: '综合', other: '其他' }[value] || value);
      const typeOrder = ['entity', 'concept', 'relationship', 'episode', 'emotion', 'synthesis', 'source', 'other'];
      let snapshot; let selectedPageId; let noticeTimer;
      const showError = error => { $('error').textContent = String(error); $('error').style.display = 'block'; }; const clearError = () => { $('error').style.display = 'none'; };
      const showNotice = message => { const target = $('notice'); target.textContent = message; target.style.display = 'block'; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { target.style.display = 'none'; }, 2800); };
      const actionButton = (label, className, handler) => { const button = node('button', 'btn ' + (className || 'secondary'), label); button.addEventListener('click', async () => { button.disabled = true; try { await handler(); await load(); showNotice('已更新记忆系统'); } catch (error) { showError(error); } finally { button.disabled = false; } }); return button; };
      const isSensitive = value => value?.sensitivity !== 'normal' || value?.usagePolicy === 'suppressed';
      const redactionPlaceholder = (message, reveal) => { const wrap = node('div', 'redacted'); wrap.append(node('span', null, message)); if (reveal) { const button = node('button', 'btn secondary', '显示敏感内容'); button.type = 'button'; button.addEventListener('click', async () => { button.disabled = true; try { await reveal(); } catch (error) { showError(error); } finally { button.disabled = false; } }); wrap.append(button); } return wrap; };
      const evidenceText = body => { const raw = typeof body?.evidence === 'string' ? body.evidence : Array.isArray(body?.lines) ? body.lines.map(line => typeof line === 'string' ? line : '').join('\n') : Array.isArray(body?.records) ? body.records.map(record => typeof record === 'string' ? record : typeof record?.line === 'string' ? record.line : typeof record?.text === 'string' ? record.text : '').join('\n') : ''; const trailingNewline = raw.endsWith('\n'); const lines = raw.split(/\r?\n/); if (trailingNewline) lines.pop(); const records = Array.isArray(body?.records); const markers = Array.isArray(body?.evidenceMarkers) ? body.evidenceMarkers : Array.isArray(body?.markers) ? body.markers : records ? body.records : []; const markerFor = index => markers.find((marker, markerIndex) => { const markerLine = Number.isInteger(marker?.index) ? marker.index : Number.isInteger(marker?.lineIndex) ? marker.lineIndex : Number.isInteger(marker?.line) ? marker.line : records ? markerIndex : undefined; return markerLine === index; }); const inlineSensitivity = line => { try { const value = JSON.parse(line); const sensitivity = value?.sensitivity || value?.data?.sensitivity; return sensitivity === 'normal' || sensitivity === 'sensitive' ? sensitivity : undefined; } catch { return undefined; } }; const output = lines.map((line, index) => { const marker = markerFor(index); const sensitivity = marker?.sensitivity === 'normal' || marker?.sensitivity === 'sensitive' ? marker.sensitivity : inlineSensitivity(line); return sensitivity === 'normal' ? line : '[敏感或未分类内容已隐藏]'; }); return output.join('\n') + (trailingNewline ? '\n' : ''); };
      const showEvidence = async sessionId => { try { const body = await request('/sessions/' + encodeURIComponent(sessionId)); $('evidence-heading').textContent = '原始 JSONL · ' + sessionId; $('evidence').textContent = evidenceText(body); $('evidence-card').style.display = 'block'; $('evidence-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (error) { showError(error); } };
      const sourceMeta = sourceId => (snapshot?.sources || []).find(source => source.ref === sourceId);
      const renderPageDetail = (page, revealed = false) => { const target = $('page-detail'); target.replaceChildren(); if (!page) { target.append(node('div', 'empty', '从左侧选择一个页面，查看原文、frontmatter、来源和关系。')); return; } const redacted = isSensitive(page) && !revealed; const heading = node('div', 'detail-top'); const titleBlock = node('div', 'detail-title'); titleBlock.append(node('h3', null, page.title), node('p', null, page.path)); heading.append(titleBlock, node('span', 'badge ' + (page.locked ? 'green' : ''), page.locked ? '已锁定' : '可整理')); const badges = node('div', 'badge-row'); badges.append(node('span', 'badge', typeLabel(page.type)), node('span', 'badge', 'v' + page.version), node('span', 'badge', '置信度 ' + Math.round(page.confidence * 100) + '%'), node('span', 'badge ' + (page.sensitivity === 'sensitive' ? 'amber' : ''), page.sensitivity === 'sensitive' ? '敏感' : page.usagePolicy === 'suppressed' ? '已抑制' : '普通'), node('span', 'badge', page.status)); const frontmatter = node('pre', 'frontmatter'); frontmatter.textContent = (redacted ? ['id: ' + page.id, 'type: ' + page.type, 'status: ' + page.status, 'timestamp: ' + (page.timestamp || '—'), 'updated_at: ' + (page.updatedAt || '—'), 'sensitivity: ' + (page.sensitivity || 'unknown'), 'usage_policy: ' + (page.usagePolicy || 'unknown'), 'source_count: ' + (page.sources || []).length, 'tag_count: ' + (page.tags || []).length, 'version: ' + page.version].join('\n') : ['type: ' + page.type, 'title: ' + page.title, 'description: ' + page.description, 'sources: ' + (page.sources || []).join(', '), 'tags: ' + (page.tags || []).join(', '), 'timestamp: ' + page.timestamp, 'confidence: ' + page.confidence, 'sensitivity: ' + (page.sensitivity || 'normal'), 'usage_policy: ' + (page.usagePolicy || 'normal'), 'status: ' + page.status, 'consent: ' + page.consent, 'valid_until: ' + (page.validUntil || '—'), 'locked: ' + page.locked, 'version: ' + page.version, 'updated_at: ' + page.updatedAt].join('\n')); const sources = node('div', 'source-list'); if (redacted) sources.append(node('span', 'muted', (page.sources || []).length + ' 个来源已登记（敏感内容已隐藏）')); else { for (const ref of page.sources || []) { const meta = sourceMeta(ref); if (meta?.kind === 'session' || (snapshot?.sessions || []).includes(ref)) { const link = node('button', 'source-chip clickable', '会话 · ' + ref); link.addEventListener('click', () => showEvidence(ref)); sources.append(link); } else { sources.append(node('span', 'source-chip', (meta?.kind === 'manual' ? '编辑 · ' : '来源 · ') + ref)); } } if (!sources.children.length) sources.append(node('span', 'muted', '暂无来源')); } const relation = node('div', 'relation-list'); const graphEdges = (snapshot?.graph?.edges || []).filter(edge => edge.targetPageId !== undefined && (edge.sourcePageId === page.id || edge.targetPageId === page.id)); if (redacted) relation.append(node('span', 'muted', graphEdges.length + ' 条关系已登记（敏感内容已隐藏）')); else { for (const edge of graphEdges) relation.append(node('span', 'relation-chip', edge.sourcePageId === page.id ? '→ ' + edge.targetTitle : '← ' + edge.targetTitle)); if (!relation.children.length) relation.append(node('span', 'muted', '暂无已解析关系')); } const actions = node('div', 'detail-actions'); actions.append(actionButton('删除此页面', 'danger', () => request('/wiki/pages/' + encodeURIComponent(page.id), { method: 'DELETE' }))); target.append(heading, badges); const rawBlock = node('div', 'detail-block'); rawBlock.append(node('h3', null, redacted ? '页面原文（已隐藏）' : '页面原文'), frontmatter); if (redacted) rawBlock.append(redactionPlaceholder('敏感摘要与正文默认隐藏。', async () => { const detail = await request('/wiki/pages/' + encodeURIComponent(page.id)); renderPageDetail({ ...detail, ...(detail.sensitivity === undefined ? { sensitivity: page.sensitivity } : {}) }, true); })); else { const editor = node('form', 'edit-form'); const title = node('input'); title.value = page.title; const description = node('input'); description.value = page.description; const body = node('textarea'); body.value = page.body; const tags = node('input'); tags.value = (page.tags || []).join(', '); const titleLabel = node('label'); titleLabel.append(node('span', null, '标题'), title); const descriptionLabel = node('label'); descriptionLabel.append(node('span', null, '摘要'), description); const bodyLabel = node('label'); bodyLabel.append(node('span', null, '正文（保存后立即重建 L3）'), body); const tagsLabel = node('label'); tagsLabel.append(node('span', null, '标签 · 逗号分隔'), tags); const save = node('button', 'btn', '保存页面修改'); editor.append(titleLabel, descriptionLabel, tagsLabel, bodyLabel, save); editor.addEventListener('submit', async event => { event.preventDefault(); save.disabled = true; try { await request('/wiki/pages/' + encodeURIComponent(page.id), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.value, description: description.value, body: body.value, tags: tags.value.split(',').map(value => value.trim()).filter(Boolean) }) }); await load(); await selectPage(page.id); showNotice('页面已保存，Resident 已重新编译'); } catch (error) { showError(error); } finally { save.disabled = false; } }); target.append(node('div', 'detail-block')); target.lastChild.append(node('h3', null, '直接编辑'), editor); } const sourceBlock = node('div', 'detail-block'); sourceBlock.append(node('h3', null, '来源会话'), sources); const relationBlock = node('div', 'detail-block'); relationBlock.append(node('h3', null, '相关页面'), relation); target.append(rawBlock, sourceBlock, relationBlock, actions); };
      const selectPage = async id => { selectedPageId = id; const summary = (snapshot?.pages || []).find(page => page.id === id); const page = isSensitive(summary) ? summary : await request('/wiki/pages/' + encodeURIComponent(id)); renderPageDetail(page); renderPageNav(); const graph = await request('/wiki/graph?root=' + encodeURIComponent(id) + '&hop=1'); renderGraph(graph); };
      const renderPageNav = (pages = snapshot?.pages || []) => { const target = $('page-nav'); target.replaceChildren(); if (selectedPageId && !pages.some(page => page.id === selectedPageId)) { selectedPageId = undefined; renderPageDetail(undefined); } if (!pages.length) { target.append(node('div', 'empty', '暂无 Wiki 页面')); return; } const groups = new Map(); for (const page of [...pages].sort((a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type) || a.title.localeCompare(b.title))) { const key = page.type; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(page); } for (const type of typeOrder) { const items = groups.get(type); if (!items) continue; const group = node('div', 'tree-group'); group.append(node('div', 'tree-label', typeLabel(type))); for (const page of items) { const button = node('button', 'page-button' + (selectedPageId === page.id ? ' active' : '')); button.dataset.type = page.type; button.append(node('span', 'page-bullet'), node('span', 'page-title', page.title)); button.title = page.path; button.addEventListener('click', () => selectPage(page.id).catch(showError)); group.append(button); } target.append(group); } };
      const renderGraph = graph => { const target = $('graph'); target.replaceChildren(); const nodes = graph?.nodes || []; const edges = graph?.edges || []; if (!nodes.length) { target.append(node('div', 'empty', '暂无关系图节点')); return; } const width = Math.max(560, nodes.length * 155); const height = 190; const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height); const columns = Math.max(1, Math.floor(width / 155)); const positions = new Map(); nodes.forEach((item, index) => positions.set(item.id, { x: 70 + (index % columns) * 155, y: 52 + Math.floor(index / columns) * 75 })); edges.forEach(edge => { const from = positions.get(edge.sourcePageId); const to = edge.targetPageId ? positions.get(edge.targetPageId) : undefined; if (!from || !to) return; const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.setAttribute('x1', from.x); line.setAttribute('y1', from.y); line.setAttribute('x2', to.x); line.setAttribute('y2', to.y); svg.append(line); }); nodes.forEach(item => { const point = positions.get(item.id); if (!point) return; const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); circle.setAttribute('cx', point.x); circle.setAttribute('cy', point.y); circle.setAttribute('r', '22'); svg.append(circle); const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.setAttribute('x', point.x); label.setAttribute('y', point.y + 42); label.setAttribute('text-anchor', 'middle'); label.textContent = item.title.slice(0, 16); svg.append(label); }); target.append(svg); if (!edges.some(edge => edge.targetPageId)) target.append(node('div', 'muted', '页面当前没有解析到已存在的关联页面。')); };
      const candidateTitle = page => { const title = String(page.title || '').replace(/\s+/g, ' ').trim(); const latinRatio = (title.match(/[A-Za-z]/g) || []).length / Math.max(1, title.length); if (title.length >= 2 && title.length <= 24 && !/[。！？!?；;]/.test(title) && latinRatio < .45) return title; const signal = (title + (isSensitive(page) ? '' : ' ' + (page.description || page.body || ''))).toLowerCase(); if (page.type === 'source') return '会话摘要候选'; if (page.type === 'entity') return /项目|工具|project|tool/.test(signal) ? '长期项目候选' : '用户事实候选'; if (page.type === 'concept') return /边界|不要|安静|quiet|boundary|22:00|十点/.test(signal) ? '沟通边界候选' : '长期偏好候选'; if (page.type === 'episode') return '重要经历候选'; if (page.type === 'emotion') return '近期状态候选'; if (page.type === 'relationship') return '陪伴关系候选'; return '长期记忆候选'; };
      const renderCandidates = records => { const target = $('candidates'); target.replaceChildren(); $('candidate-count').textContent = records.length + ' 条'; if (!records.length) { target.append(node('div', 'panel panel-pad empty', '暂无待确认候选。新的候选会在会话结束后的 Dream 整理中出现。')); return; } for (const record of records) { const page = record.page || record; const sensitive = isSensitive(page); const sourceCount = (record.sourceConversations || page.sources || []).length; const row = node('article', 'candidate'); const content = sensitive ? redactionPlaceholder('敏感候选摘要与正文默认隐藏。', async () => { const detail = await request('/wiki/pages/' + encodeURIComponent(page.id)); const revealed = { ...detail, ...(detail.sensitivity === undefined ? { sensitivity: page.sensitivity } : {}) }; content.replaceWith(node('p', null, revealed.description || revealed.body || '暂无摘要')); }) : node('p', null, page.description || page.body || '暂无摘要'); const metadata = sensitive ? ['id: ' + (record.id || page.id || '—'), 'type: ' + typeLabel(page.type), 'status: ' + (page.status || 'candidate'), 'timestamp: ' + (page.timestamp || page.observedAt || '—'), 'updated_at: ' + (page.updatedAt || record.createdAt || '—'), 'sensitivity: ' + (page.sensitivity || 'unknown'), 'source_count: ' + sourceCount, 'confidence: ' + Math.round((page.confidence || 0) * 100) + '%'].join(' · ') : typeLabel(page.type) + ' · ' + Math.round((page.confidence || 0) * 100) + '% · ' + (record.sourceConversations || page.sources || []).join(', ') + (record.conflictPageId ? ' · 与现有页面冲突' : ''); row.append(node('h3', null, candidateTitle(page)), content, node('small', null, metadata)); const actions = node('div', 'candidate-actions'); actions.append(actionButton('确认并锁定', 'mint', () => request('/wiki/candidates/' + encodeURIComponent(record.id) + '/confirm', { method: 'POST' })), actionButton('拒绝', 'danger', () => request('/wiki/candidates/' + encodeURIComponent(record.id) + '/reject', { method: 'POST' }))); row.append(actions); target.append(row); } };
      const renderSessions = sessions => { const target = $('sessions'); target.replaceChildren(); $('session-count').textContent = sessions.length + ' 个会话'; if (!sessions.length) { target.append(node('div', 'empty', '暂无会话证据')); return; } for (const id of sessions) { const row = node('div', 'session-row'); row.append(node('code', null, id), actionButton('查看原文', 'secondary', () => showEvidence(id))); target.append(row); } };
      const render = (value, config) => { snapshot = value; const pages = value.pages || []; const graph = value.graph || { nodes: [], edges: [] }; const candidates = value.candidates || []; const sessions = value.sessions || []; const residentSnapshot = value.residentSnapshot || {}; $('resident').textContent = value.resident || '当前没有已确认且未过期的常驻记忆。'; $('resident-version').textContent = 'version ' + (residentSnapshot.version || '—'); $('resident-source-count').textContent = String((residentSnapshot.sourcePageIds || []).length); $('l0-count').textContent = String(sessions.length); $('l1-count').textContent = String(candidates.length); $('l2-count').textContent = String(pages.length); $('l2-edges').textContent = String(graph.edges.length); $('l3-count').textContent = String((residentSnapshot.sourcePageIds || []).length); $('nav-l0').textContent = String(sessions.length); $('nav-l1').textContent = String(candidates.length); $('nav-l2').textContent = String(pages.length); $('nav-l3').textContent = String((residentSnapshot.sourcePageIds || []).length); $('wiki-count').textContent = pages.length + ' 个页面'; $('profile-label').textContent = value.profileId || '—'; $('health-label').textContent = value.lastError ? '需要注意' : '同步正常'; $('updated-label').textContent = value.lastError ? '上次整理失败：' + value.lastError : '最近更新 · ' + time(value.updatedAt); renderPageNav(); renderGraph(graph); renderCandidates(candidates); renderSessions(sessions); const status = $('status'); status.replaceChildren(...[['最近整理', time(value.lastDreamAt)], ['会话数量', String(sessions.length)], ['页面版本', residentSnapshot.version || '—'], ['Profile', value.profileId || '—']].map(item => { const div = node('div', 'meta-box'); div.append(node('strong', null, item[0]), node('span', null, item[1])); return div; })); const configTarget = $('config'); configTarget.replaceChildren(...[['API URL', config.dreamApiUrl], ['整理模型', config.dreamModel], ['Credential Ref', config.dreamConfigured ? config.dreamCredentialRef + '（已配置）' : config.dreamCredentialRef + '（未配置）'], ['最大输出 Token', String(config.dreamMaxTokens)]].map(item => { const div = node('div', 'meta-box'); div.append(node('strong', null, item[0]), node('span', null, item[1])); return div; })); $('dream-api-url').value = config.dreamApiUrl || ''; $('dream-model').value = config.dreamModel || ''; $('dream-credential-ref').value = config.dreamCredentialRef || ''; if (value.lastError) showError('上次 Dream 失败：' + value.lastError); };
      const load = async () => { clearError(); const [config, value] = await Promise.all([request('/config'), request('/wiki')]); sessionStorage.setItem(profileKey, config.profileId); $('token-input').value = token(); render(value, config); };
      document.querySelectorAll('[data-scroll]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.scroll).scrollIntoView({ behavior: 'smooth', block: 'start' })));
      $('refresh').addEventListener('click', () => load().then(() => showNotice('数据已刷新')).catch(showError)); $('save-token').addEventListener('click', () => { sessionStorage.setItem(tokenKey, $('token-input').value.trim()); load().then(() => showNotice('Token 已应用')).catch(showError); }); $('open-chat').addEventListener('click', () => { location.href = '/'; }); $('dream-now').addEventListener('click', event => runDream(event.currentTarget)); $('status-dream').addEventListener('click', event => runDream(event.currentTarget));
      const runDream = async button => { button.disabled = true; try { await request('/dream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); await load(); showNotice('Dream 整理已完成'); } catch (error) { showError(error); } finally { button.disabled = false; } };
      $('search-button').addEventListener('click', async () => { try { const q = $('wiki-search').value.trim(); if (!q) { renderPageNav(); renderGraph(snapshot?.graph || { nodes: [], edges: [] }); return; } const result = await request('/wiki/search?q=' + encodeURIComponent(q) + '&hop=1'); renderPageNav(result.results.map(item => item.page)); renderGraph(await request('/wiki/graph?hop=1')); } catch (error) { showError(error); } }); $('all-pages').addEventListener('click', () => { renderPageNav(); renderGraph(snapshot?.graph || { nodes: [], edges: [] }); }); $('close-evidence').addEventListener('click', () => { $('evidence-card').style.display = 'none'; }); $('dream-form').addEventListener('submit', async event => { event.preventDefault(); const button = event.submitter; button.disabled = true; try { await request('/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiUrl: $('dream-api-url').value.trim(), model: $('dream-model').value.trim(), credentialRef: $('dream-credential-ref').value.trim() }) }); await load(); showNotice('记忆模型设置已保存'); } catch (error) { showError(error); } finally { button.disabled = false; } });
      load().catch(showError);
    })();
  </script>
  <script>
    (() => {
      const relationLabels = { related_to: '关联', supports: '支持', contradicts: '反驳', refines: '细化', derived_from: '派生', evidenced_by: '有证据' };
      const syncGraphLegend = async () => {
        const target = document.getElementById('graph');
        if (!target) return;
        let legend = target.querySelector('.graph-legend');
        if (!legend) { legend = document.createElement('div'); legend.className = 'muted graph-legend'; target.append(legend); }
        try {
          const apiRoot = location.pathname.replace(/\/ui\/?$/, '').replace(/\/$/, '') || '/memory/v1';
          const requestHeaders = {};
          const bearer = sessionStorage.getItem('dsh-riko-memory-token');
          const profile = sessionStorage.getItem('dsh-riko-memory-profile');
          if (bearer) requestHeaders.Authorization = 'Bearer ' + bearer;
          if (profile) requestHeaders['x-dsh-memory-profile'] = profile;
          const response = await fetch(apiRoot + '/wiki/graph?hop=1&evidence=1', { headers: requestHeaders });
          if (!response.ok) throw new Error('graph request failed: HTTP ' + response.status);
          const graph = await response.json();
          const titles = new Map((graph.nodes || []).map(node => [node.id, node.title]));
          const lines = (graph.edges || []).map(edge => (titles.get(edge.sourcePageId) || edge.sourcePageId) + ' · ' + (relationLabels[edge.relationType || 'related_to'] || '关联') + ' → ' + (titles.get(edge.targetPageId) || edge.targetTitle));
          legend.textContent = lines.length ? '关系与证据：' + lines.join('　|　') : '页面关系来自正文中的 [[页面标题]]；来源会话在页面详情中单独追溯。';
        } catch { legend.textContent = '页面关系来自正文中的 [[页面标题]]；来源会话在页面详情中单独追溯。'; }
      };
      const renderEvidenceGraph = graphData => {
        const target = document.getElementById('graph');
        if (!target || target.querySelector('.evidence-graph')) return;
        const evidenceEdges = (graphData.edges || []).filter(edge => edge.targetKind === 'session');
        if (!evidenceEdges.length) return;
        const pageIds = new Set(evidenceEdges.map(edge => edge.sourcePageId));
        const pages = (graphData.nodes || []).filter(node => node.layer === 'L2' && pageIds.has(node.id));
        const sessions = (graphData.nodes || []).filter(node => node.layer === 'L0');
        const width = Math.max(620, Math.max(pages.length, sessions.length) * 170);
        const height = Math.max(150, Math.max(pages.length, sessions.length) * 42 + 70);
        const positions = new Map();
        pages.forEach((item, index) => positions.set(item.id, { x: 90 + index * 170, y: 38 }));
        sessions.forEach((item, index) => positions.set(item.id, { x: 90 + index * 170, y: height - 48 }));
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
        svg.setAttribute('aria-label', 'L0 会话证据关系图');
        evidenceEdges.forEach(edge => {
          const from = positions.get(edge.sourcePageId); const to = positions.get(edge.targetPageId);
          if (!from || !to) return;
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.setAttribute('x1', from.x); line.setAttribute('y1', from.y); line.setAttribute('x2', to.x); line.setAttribute('y2', to.y); line.setAttribute('stroke', '#d18b64'); line.setAttribute('stroke-width', '1.5'); svg.append(line);
        });
        [...pages, ...sessions].forEach(item => {
          const point = positions.get(item.id); if (!point) return;
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); circle.setAttribute('cx', point.x); circle.setAttribute('cy', point.y); circle.setAttribute('r', '22'); circle.setAttribute('fill', item.layer === 'L0' ? '#d18b64' : '#5084eb'); circle.setAttribute('stroke', '#d7e4ff'); circle.setAttribute('tabindex', '0'); circle.setAttribute('role', 'button'); circle.setAttribute('aria-label', String(item.title)); circle.style.cursor = 'pointer'; const activate = () => { if (item.layer === 'L2') { const button = [...document.querySelectorAll('.page-button')].find(candidate => candidate.textContent?.includes(String(item.title))); if (button instanceof HTMLElement) button.click(); } else { const row = [...document.querySelectorAll('.session-row')].find(candidate => candidate.textContent?.includes(String(item.title))); const button = row?.querySelector('button'); if (button instanceof HTMLElement) button.click(); } }; circle.addEventListener('click', activate); circle.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } }); svg.append(circle);
          const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.setAttribute('x', point.x); label.setAttribute('y', item.layer === 'L0' ? point.y - 31 : point.y + 42); label.setAttribute('text-anchor', 'middle'); label.textContent = String(item.title).slice(0, 14); svg.append(label);
        });
        const panel = document.createElement('div'); panel.className = 'evidence-graph'; panel.style.marginTop = '14px'; const key = document.createElement('div'); key.className = 'muted'; key.textContent = '蓝色 = L2 Wiki 页面　橙色 = L0 会话证据　连线 = 有证据'; panel.append(key, svg); target.append(panel);
      };
      const graph = document.getElementById('graph');
      if (graph) {
        const syncGraph = async () => {
          await syncGraphLegend();
          try {
            const apiRoot = location.pathname.replace(/\/ui\/?$/, '').replace(/\/$/, '') || '/memory/v1';
            const requestHeaders = {};
            const bearer = sessionStorage.getItem('dsh-riko-memory-token');
            const profile = sessionStorage.getItem('dsh-riko-memory-profile');
            if (bearer) requestHeaders.Authorization = 'Bearer ' + bearer;
            if (profile) requestHeaders['x-dsh-memory-profile'] = profile;
            const response = await fetch(apiRoot + '/wiki/graph?hop=1&evidence=1', { headers: requestHeaders });
            if (!response.ok) return;
            renderEvidenceGraph(await response.json());
          } catch { /* The primary UI already reports API errors. */ }
        };
        new MutationObserver(() => { if (!graph.querySelector('.graph-legend') || !graph.querySelector('.evidence-graph')) void syncGraph(); }).observe(graph, { childList: true });
        void syncGraph();
      }
    })();
  </script>
</body>
</html>`
