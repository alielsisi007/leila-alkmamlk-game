const socket = io();
const root = document.getElementById('root');

// player/session state (login kept as-is)
let myName = null;
let currentRoom = null;
let myRole = null, myEmoji = '', myTeam = '';
let revealedRoles = {};
let privateMsgs = [];
let publicMsgs = [];

// Game state machine
let gameState = 'login'; // login, lobby, roleReveal, night, result, voting, gameOver
let roleRevealData = null;
let nightInfo = { players: [], endsAt: null, nightCount: 0, startedAt: null };
let currentTurnIndex = 0;
let phaseProgressInterval = null;

function render(){
  const container = document.createElement('div'); container.className = 'app-shell';
  // Top area: if in room show header
  if(currentRoom){
    const top = document.createElement('div'); top.className = 'topbar';
    top.innerHTML = `<div class="room-meta">غرفة: <span class="room-code">${currentRoom.id}</span> &nbsp; | &nbsp; الطور: <strong>${gameState}</strong></div>\n      <div class="flex"><button class="btn small" id="leaveBtn">مغادرة</button></div>`;
    container.appendChild(top);
  }

  // Main phase area
  const phase = document.createElement('div'); phase.className = 'phase panel';
  const inner = document.createElement('div'); inner.className = 'phase-inner';

  if(gameState === 'login'){
    inner.appendChild(renderLogin());
  } else if(gameState === 'lobby'){
    inner.appendChild(renderLobby());
  } else if(gameState === 'roleReveal'){
    inner.appendChild(renderRoleReveal());
  } else if(gameState === 'night'){
    inner.appendChild(renderNight());
  } else if(gameState === 'result'){
    inner.appendChild(renderResult());
  } else if(gameState === 'voting'){
    inner.appendChild(renderVoting());
  } else if(gameState === 'gameOver'){
    inner.appendChild(renderGameOver());
  }

  phase.appendChild(inner);
  container.appendChild(phase);

  // Footer public messages
  const msgs = document.createElement('div'); msgs.className = 'panel';
  msgs.innerHTML = `<div class="muted">رسائل عامة</div><div id="publicList">${publicMsgs.map(m=>`<div>${m}</div>`).join('')}</div>`;
  container.appendChild(msgs);

  root.innerHTML = ''; root.appendChild(container);

  // wire leave button
  const leaveBtn = document.getElementById('leaveBtn'); if(leaveBtn) leaveBtn.onclick = ()=>{ socket.emit('leaveRoom', { code: currentRoom.id }); currentRoom = null; myName = null; myRole=null; gameState='login'; render(); };
}

// --- Login UI (keeps behavior) ---
function renderLogin(){
  const wrap = document.createElement('div'); wrap.className = 'panel';
  wrap.innerHTML = `\n    <div style="text-align:center;margin-bottom:8px"><h2>ليلة الممالك — انضمام</h2></div>\n    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">\n      <input id="nick" placeholder="الاسم" style="padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.04)" />\n      <button class="btn" id="createBtn">إنشاء غرفة</button>\n    </div>\n    <hr style="opacity:.06;margin:12px 0">\n    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">\n      <input id="roomCode" placeholder="رمز الغرفة" style="padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.04)" />\n      <input id="nick2" placeholder="الاسم" style="padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.04)" />\n      <button class="btn" id="joinBtn">انضم</button>\n    </div>\n  `;

  setTimeout(()=>{
    const create = wrap.querySelector('#createBtn');
    const join = wrap.querySelector('#joinBtn');
    create.onclick = ()=>{
      const name = wrap.querySelector('#nick').value.trim(); if(!name) return alert('أدخل اسم');
      myName = name;
      socket.emit('createRoom', { name }, (res)=>{ if(res?.room){ currentRoom = res.room; gameState='lobby'; render(); } });
    };
    join.onclick = ()=>{
      const code = wrap.querySelector('#roomCode').value.trim().toUpperCase(); const name = wrap.querySelector('#nick2').value.trim(); if(!code||!name) return alert('أدخل الكود والاسم'); myName = name; socket.emit('joinRoom', { code, name }, (res)=>{ if(res?.error) return alert(res.error); currentRoom = res.room; gameState='lobby'; render(); });
    };
  },20);

  return wrap;
}

// --- Lobby ---
function renderLobby(){
  const wrap = document.createElement('div'); wrap.className = 'panel';
  const playersHtml = (currentRoom.players||[]).map(p=>`<div class="player"><div class="left"><img src="/cards/${revealedRoles[p.name] || ''}.png" onerror="this.style.display='none'"/><div class="meta">${p.name} ${p.isHost? '👑':''}<div class="status">${p.alive? 'على قيد الحياة':'مقتول'}</div></div></div></div>`).join('');
  wrap.innerHTML = `\n    <h3>اللوبي</h3>\n    <div class="player-list">${playersHtml}</div>\n    <div style="margin-top:12px">${isHost()? `<button class="btn" id="startGame">بدء اللعبة</button>` : ''}</div>\n    <div style="margin-top:12px" class="muted">انتظار اللاعبين. ابدأ اللعبة عند جاهزية الجميع.</div>\n  `;
  setTimeout(()=>{
    const btn = wrap.querySelector('#startGame'); if(btn){ btn.onclick = ()=>{ socket.emit('startGame', { code: currentRoom.id }, (res)=>{ if(res?.error) alert(res.error); else { /* hide button locally */ btn.style.display='none'; } }); } }
  },10);
  return wrap;
}

function isHost(){ return currentRoom && currentRoom.players && currentRoom.players.find(p=>p.name===myName && p.isHost); }

// --- Role Reveal Screen (full page) ---
function renderRoleReveal(){
  const wrap = document.createElement('div'); wrap.className = 'role-card-wrap';
  const role = roleRevealData?.role || myRole;
  const emoji = roleRevealData?.emoji || myEmoji;
  const desc = roleDescription(role);
  const card = document.createElement('div'); card.className = 'role-card';
  card.innerHTML = `<div class="role-emoji">${emoji}</div><h2>${role}</h2><div class="role-desc">${desc}</div><div style="margin-top:12px"><button class="btn" id="revealNext">التالي</button></div>`;
  wrap.appendChild(card);
  setTimeout(()=>{ const btn = card.querySelector('#revealNext'); btn.onclick = ()=>{ socket.emit('roleReady', { code: currentRoom.id, name: myName }, (res)=>{ gameState='lobby'; render(); }); }; },10);
  return wrap;
}

function roleDescription(role){
  if(!role) return '';
  const map = {
    'محقق': 'يمكنه التحقيق في لاعب لمعرفة رموز أونصبة محتملة.',
    'شرطي': 'يستطيع منع لاعب من أداء فعله هذه الليلة.',
    'فارس': 'يحمي لاعباً من محاولة القتل.',
    'ملك': 'يراقب لاعباً ليعرف ما إذا استخدم قدرته.',
    'قاتل': 'يحاول قتل هدف كل ليلة.',
    'سارق': 'ينسخ دور لاعب ويستخدمه في الليلة التالية.',
    'كاتب': 'يمكنه إحياء أو قتل هدف واحد.'
  };
  return map[role] || '';
}

// --- Night Screen ---
function renderNight(){
  const wrap = document.createElement('div'); wrap.className = 'night-board';
  const left = document.createElement('div'); left.className = 'night-left';
  const right = document.createElement('div'); right.className = 'night-right';

  // Title and progress
  const title = document.createElement('div'); title.className = 'turn-card';
  title.innerHTML = `<div class="turn-title">الليلة ${nightInfo.nightCount || ''}</div>\n    <div class="progress" style="margin-top:8px"><i id="progressBar"></i></div>\n    <div style="margin-top:8px" class="muted">الوقت المتبقي: <span id="timeLeft">--</span></div>`;
  left.appendChild(title);

  // Current turn area
  const current = document.createElement('div'); current.className = 'turn-card';
  const actor = nightInfo.players[currentTurnIndex] || '';
  current.innerHTML = `<div class="muted">الآن دور:</div><div style="font-weight:700;margin-top:6px">${actor}</div><div id="turnControls" style="margin-top:10px"></div>`;
  left.appendChild(current);

  // Right side: player list
  const listWrap = document.createElement('div'); listWrap.className = 'panel';
  listWrap.innerHTML = `<div class="muted">اللاعبون</div><div style="margin-top:8px">${(nightInfo.players||[]).map(n=>`<div class="player"><div class="left"><div class="meta">${n}</div></div></div>`).join('')}</div>`;
  right.appendChild(listWrap);

  wrap.appendChild(left); wrap.appendChild(right);

  // populate controls for current user
  setTimeout(()=>{ renderTurnControls(); startPhaseProgress(); },10);
  return wrap;
}

function renderTurnControls(){
  const controls = document.getElementById('turnControls'); if(!controls) return;
  const actor = nightInfo.players[currentTurnIndex];
  controls.innerHTML = '';
  // show only for the actor
  if(actor === myName){
    // show compact role
    const roleCompact = document.createElement('div'); roleCompact.className = 'role-compact'; roleCompact.textContent = `دورك: ${myRole} ${myEmoji}`;
    controls.appendChild(roleCompact);

    // target select
    const select = document.createElement('select'); select.id = 'targetSelect'; select.style.marginTop = '8px';
    const alive = (currentRoom.players||[]).filter(p=>p.alive && p.name !== myName).map(p=>p.name);
    const opt0 = document.createElement('option'); opt0.value=''; opt0.textContent='-- اختر هدف --'; select.appendChild(opt0);
    alive.forEach(a=>{ const o = document.createElement('option'); o.value=a; o.textContent=a; select.appendChild(o); });
    controls.appendChild(select);

    // ability select for writer
    if(myRole === 'كاتب'){
      const ab = document.createElement('select'); ab.id = 'abilitySelect'; ab.style.marginTop='8px'; ab.innerHTML = `<option value=\"revive\">إحياء</option><option value=\"kill\">قتل</option>`; controls.appendChild(ab);
    }

    const btn = document.createElement('button'); btn.className='btn'; btn.textContent='تنفيذ'; btn.style.marginTop='8px';
    btn.onclick = ()=>{
      const target = select.value; const ability = document.getElementById('abilitySelect')? document.getElementById('abilitySelect').value : undefined;
      if(!target){ alert('اختر هدفاً'); return; }
      socket.emit('playerAction', { code: currentRoom.id, actorName: myName, targetName: target, ability }, (res)=>{
        if(res?.error) return alert(res.error);
        // lock UI for actor
        btn.disabled = true; select.disabled = true; if(document.getElementById('abilitySelect')) document.getElementById('abilitySelect').disabled = true;
        // advance turn immediately
        advanceTurn();
      });
    };
    controls.appendChild(btn);
  } else {
    controls.innerHTML = `<div class="muted">انتظر دور ${actor}...</div>`;
  }
}

function advanceTurn(){
  // advance to next alive player
  const players = nightInfo.players || [];
  const len = players.length; if(len===0) return;
  let i = currentTurnIndex;
  for(let k=1;k<=len;k++){
    const nxt = (i + k) % len; const name = players[nxt]; const p = (currentRoom.players||[]).find(x=>x.name===name);
    if(p && p.alive){ currentTurnIndex = nxt; render(); return; }
  }
  // no alive found: end
}

function startPhaseProgress(){
  const bar = document.getElementById('progressBar'); const timeEl = document.getElementById('timeLeft'); if(!bar||!timeEl) return;
  if(phaseProgressInterval) clearInterval(phaseProgressInterval);
  phaseProgressInterval = setInterval(()=>{
    const now = Date.now(); const ends = nightInfo.endsAt || currentRoom.nightEndsAt || currentRoom.voteEndsAt || null;
    if(!ends) { timeEl.textContent='--'; return; }
    const total = Math.max(1, (ends - (nightInfo.startedAt||Date.now()))/1000);
    const rem = Math.max(0, Math.floor((ends - now)/1000));
    const pct = Math.max(0, Math.min(100, Math.floor(((total - rem)/total)*100)));
    bar.style.width = pct + '%'; timeEl.textContent = rem + 's';
    if(rem <= 0){ clearInterval(phaseProgressInterval); }
  }, 300);
}

// --- Result screen ---
function renderResult(){
  const wrap = document.createElement('div'); wrap.className = 'result-grid';
  wrap.innerHTML = `<div class="result-private"><div class="muted">رسائلك الخاصة هذه الليلة</div><div id="privateList" style="margin-top:8px"></div></div>`;
  const publicBox = document.createElement('div'); publicBox.className='result-private'; publicBox.innerHTML = `<div class="muted">إعلانات عامة</div><div id="publicListSmall" style="margin-top:8px"></div>`;
  wrap.appendChild(publicBox);
  const ack = document.createElement('div'); ack.style.marginTop='8px'; ack.innerHTML = `<button class="btn" id="ackBtn">أوافق على النتائج</button>`; wrap.appendChild(ack);
  setTimeout(()=>{ document.getElementById('privateList').innerHTML = (privateMsgs||[]).map(m=>`<div>${m}</div>`).join(''); document.getElementById('publicListSmall').innerHTML = (publicMsgs||[]).map(m=>`<div>${m}</div>`).join(''); document.getElementById('ackBtn').onclick = ()=>{ socket.emit('resultAck', { code: currentRoom.id, name: myName }, (res)=>{ /* wait for server to start voting */ document.getElementById('ackBtn').disabled = true; }); }; },10);
  return wrap;
}

// --- Voting ---
function renderVoting(){
  const wrap = document.createElement('div'); wrap.className = 'panel';
  wrap.innerHTML = `<h3>التصويت</h3><div class="voting-list" id="votingList"></div><div style="margin-top:12px" class="muted">انتهى التصويت بعد: <span id="voteTimer">--</span></div>`;
  setTimeout(()=>{
    const list = document.getElementById('votingList'); list.innerHTML = '';
    const alive = (currentRoom.players||[]).filter(p=>p.alive);
    alive.forEach(p=>{
      const div = document.createElement('div'); div.className='vote-item'; div.innerHTML = `<div>${p.name}</div><div><button class="btn small voteBtn" data-name="${p.name}">صوت</button></div>`; list.appendChild(div);
    });
    // add skip
    const skipDiv = document.createElement('div'); skipDiv.className='vote-item'; skipDiv.innerHTML = `<div>تخطي</div><div><button class="btn small" id="skipBtn">صوت</button></div>`; list.appendChild(skipDiv);
    // wire buttons
    document.querySelectorAll('.voteBtn').forEach(b=>{ b.onclick = ()=>{ const name = b.getAttribute('data-name'); socket.emit('submitVote', { code: currentRoom.id, voterName: myName, choice: name }, (res)=>{ if(res?.error) alert(res.error); else { b.disabled = true; } }); }; });
    const skipBtn = document.getElementById('skipBtn'); skipBtn.onclick = ()=>{ socket.emit('submitVote', { code: currentRoom.id, voterName: myName, choice: 'skip' }, (res)=>{ if(res?.error) alert(res.error); else skipBtn.disabled = true; }); };
    startPhaseProgress();
  },10);
  return wrap;
}

function renderGameOver(){ const wrap = document.createElement('div'); wrap.className='panel'; wrap.innerHTML = `<h2>انتهت اللعبة</h2><div class="muted">${publicMsgs[0]||''}</div><div style="margin-top:12px"><button class="btn" onclick="location.reload()">عودة</button></div>`; return wrap; }

// socket handlers
socket.on('roomState', (room)=>{ currentRoom = room; if(!currentRoom) return; if(gameState==='login') gameState='lobby'; render(); });
socket.on('roleReveal', ({ role, emoji, team })=>{ myRole = role; myEmoji = emoji; myTeam = team; roleRevealData = { role, emoji, team }; gameState = 'roleReveal'; render(); });
socket.on('startNight', ({ seconds, players })=>{ nightInfo.players = players; nightInfo.endsAt = Date.now() + (seconds||30)*1000; nightInfo.startedAt = Date.now(); nightInfo.nightCount = (currentRoom && currentRoom.nightCount) || nightInfo.nightCount; currentTurnIndex = 0; gameState = 'night'; render(); });
socket.on('nightResultPrivate', ({ msgs })=>{ privateMsgs = msgs || []; });
socket.on('nightResolved', ({ deaths, publicMsgs: pub })=>{ if(pub) publicMsgs = pub; if(deaths && deaths.length) publicMsgs = publicMsgs.concat(deaths.map(d=>`${d} توفي`)); });
socket.on('startRevealTimer', ({ seconds })=>{ /* server will trigger revealNow after countdown */ });
socket.on('revealNow', ({ msgs })=>{ privateMsgs = msgs || []; gameState='result'; render(); });
socket.on('startVoting', ({ players, seconds })=>{ gameState='voting'; if(currentRoom) currentRoom.voteEndsAt = Date.now() + (seconds||30)*1000; render(); });
socket.on('votingResult', ({ eliminatedName, role, tally })=>{ if(eliminatedName){ publicMsgs.unshift(`${eliminatedName} تم إخراجه — دوره: ${role}`); revealedRoles[eliminatedName]=role; } else publicMsgs.unshift('لم يتم إخراج أحد'); gameState='lobby'; render(); });
socket.on('votingResult', (d)=>{ /* legacy handler */ });
socket.on('systemMessage', ({ msg })=>{ publicMsgs.unshift(msg); render(); });
socket.on('voteResult', ({ eliminated, tally, revealedRole })=>{ if(eliminated){ publicMsgs.unshift(`${eliminated} تم إخراجه — دوره: ${revealedRole}`); revealedRoles[eliminated]=revealedRole; } render(); });
socket.on('gameOver', ({ winner })=>{ publicMsgs.unshift(`انتهت اللعبة. الفائز: ${winner}`); gameState='gameOver'; render(); });

// start
render();
