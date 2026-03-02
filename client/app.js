const socket = io();
const root = document.getElementById('root');
let myName = null;
let currentRoom = null;
let myRole = null;

function tpl(s){ root.innerHTML = s; }

function showJoinCreate(){
  tpl(`
    <div class="card">
      <h2>Online — غرفة</h2>
      <div class="controls">
        <input id="nick" placeholder="Nickname" />
        <button id="create">Create Room</button>
      </div>
      <hr />
      <div>
        <input id="roomCode" placeholder="Room Code" />
        <input id="nick2" placeholder="Nickname" />
        <button id="join">Join Room</button>
      </div>
      <div class="small">ملاحظة: الأسماء مكررة ممنوعة، واللاعبين 3-6</div>
    </div>
  `);
  document.getElementById('create').onclick = ()=>{
    const name = document.getElementById('nick').value.trim();
    if(!name) return alert('أدخل اسم');
    myName = name;
    socket.emit('createRoom', { name }, (res)=>{
      if(res?.room){ currentRoom = res.room; showRoomLobby(); }
    });
  };
  document.getElementById('join').onclick = ()=>{
    const code = document.getElementById('roomCode').value.trim().toUpperCase();
    const name = document.getElementById('nick2').value.trim();
    if(!code||!name) return alert('أدخل الكود والاسم');
    myName = name;
    socket.emit('joinRoom', { code, name }, (res)=>{
      if(res?.error) return alert(res.error);
      currentRoom = res.room; showRoomLobby();
    });
  };
}

function showRoomLobby(){
  tpl(`
    <div class="header">
      <div>
        <div>Room: <span class="room-code">${currentRoom.id}</span></div>
        <div class="small">Phase: ${currentRoom.phase}</div>
      </div>
      <div>
        <button id="copy">Copy Code</button>
        <button id="leave">Leave</button>
      </div>
    </div>
    <div class="card">
      <h3>Lobby</h3>
      <div class="player-list" id="players"></div>
      <div style="margin-top:8px" id="hostControls"></div>
    </div>
  `);

  document.getElementById('copy').onclick = ()=>{ navigator.clipboard.writeText(currentRoom.id); alert('Copied'); };
  document.getElementById('leave').onclick = ()=>{ socket.emit('leaveRoom', { code: currentRoom.id }); currentRoom = null; showJoinCreate(); };
  renderPlayers();
}

function renderPlayers(){
  const el = document.getElementById('players');
  el.innerHTML = '';
  currentRoom.players.forEach(p=>{
    const div = document.createElement('div');
    div.className = 'player';
    div.innerHTML = `<div>${p.name} ${p.isHost? '👑':''} ${p.connected? '':'(disconnected)'}</div><div>${p.alive? '_alive':'dead'}</div>`;
    el.appendChild(div);
  });

  const host = currentRoom.players.find(p=>p.isHost && p.name === myName);
  const hostControls = document.getElementById('hostControls');
  hostControls.innerHTML = '';
  if(host){
    const startBtn = document.createElement('button'); startBtn.textContent = 'Start Game';
    startBtn.onclick = ()=>{ socket.emit('startGame',{ code: currentRoom.id }, (res)=>{ if(res?.error) alert(res.error); }); };
    hostControls.appendChild(startBtn);
  }
}

// socket events
socket.on('roomState', (room)=>{ currentRoom = room; if(!currentRoom) return; if(location.pathname.endsWith('/client/index.html')) showRoomLobby(); });
socket.on('roleReveal', ({ role, emoji, team })=>{
  myRole = role;
  alert(`دورك: ${role} ${emoji} فريق:${team}`);
});
socket.on('privateMessage', ({ msg })=>{ alert(msg); });
socket.on('nightResultPrivate', ({ msgs })=>{ alert('نتيجة ليل: \n' + msgs.join('\n')); });
socket.on('nightResolved', ({ deaths, publicMsgs })=>{
  if(publicMsgs && publicMsgs.length) alert('Public: ' + publicMsgs.join('\n'));
  if(deaths && deaths.length) alert('Died: ' + deaths.join(', '));
});
socket.on('gameOver', ({ winner })=>{ alert('Game over. Winner: ' + winner); });
socket.on('roomClosed', ()=>{ alert('Room closed by host'); showJoinCreate(); });

// start
showJoinCreate();
