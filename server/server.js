const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const path = require('path');
const io = new Server(server, { cors: { origin: '*' } });

// Serve online client under /client and keep root serving the main project
app.use('/client', express.static(path.join(__dirname, '..', 'client')));
app.use(express.static(path.join(__dirname, '..')));

const PORT = process.env.PORT || 3000;

// Role data same as client
const rolesData = {
  "محقق": { team: "خير", emoji: "🔍" },
  "شرطي": { team: "خير", emoji: "🚔" },
  "فارس": { team: "خير", emoji: "🛡️" },
  "ملك": { team: "خير", emoji: "👁️" },
  "قاتل": { team: "شر", emoji: "🔪" },
  "سارق": { team: "شر", emoji: "🕵️‍♂️" },
  "كاتب": { team: "محايد", emoji: "✒️" }
};
const rolesList = Object.keys(rolesData);

// In-memory rooms
const rooms = {}; // roomId -> room object

function makeRoomCode(len = 5){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for(let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function createRoom(hostSocketId, hostName){
  let code;
  do { code = makeRoomCode(5); } while(rooms[code]);

  const room = {
    id: code,
    players: [],
    nightCount: 1,
    phase: 'lobby', // lobby, night, day, ended
    actions: [],
    messages: {},
    gameState: {}
  };

  rooms[code] = room;
  joinRoom(code, hostSocketId, hostName, true);
  return room;
}

function joinRoom(code, socketId, name, isHost=false){
  const room = rooms[code];
  if(!room) return { error: 'Room not found' };
  if(room.players.length >= 6) return { error: 'Room full' };
  if(room.players.find(p=>p.name === name)) return { error: 'Name taken' };

  const player = {
    id: socketId,
    name,
    isHost: !!isHost,
    alive: true,
    role: null,
    team: null,
    blocked: false,
    protected: false,
    lastKillNight: 0,
    investigated: [],
    revivedUsed: false,
    actionUsed: false,
    copiedRole: null,
    copiedRoleActiveNight: null,
    copiedTargets: [],
    lastActionTarget: null,
    wasBlockedByPolice: false,
    wasProtectedByKnight: false,
    ready: false,
    connected: true
  };

  room.players.push(player);
  room.messages[player.name] = [];
  return player;
}

function leaveRoom(code, socketId){
  const room = rooms[code];
  if(!room) return;
  const idx = room.players.findIndex(p=>p.id === socketId);
  if(idx !== -1){
    const [removed] = room.players.splice(idx,1);
    delete room.messages[removed.name];
    // if host left, close room
    if(removed.isHost){
      // notify room closed
      io.to(code).emit('roomClosed', { reason: 'host_left' });
      delete rooms[code];
      return;
    }

    io.to(code).emit('roomState', sanitizeRoom(room));
  }
}

function sanitizeRoom(room){
  return {
    id: room.id,
    players: room.players.map(p=>({ name: p.name, isHost: p.isHost, ready: p.ready, alive: p.alive, connected: p.connected })),
    phase: room.phase,
    nightCount: room.nightCount
  };
}

function assignRolesToRoom(room){
  let availableRoles = [...rolesList];
  const selectedRoles = [];

  if (availableRoles.includes("قاتل")){
    selectedRoles.push("قاتل");
    availableRoles = availableRoles.filter(r=>r!="قاتل");
  }

  while(selectedRoles.length < room.players.length){
    const idx = Math.floor(Math.random()*availableRoles.length);
    selectedRoles.push(availableRoles[idx]);
    availableRoles.splice(idx,1);
  }

  selectedRoles.sort(()=>Math.random()-0.5);

  room.players.forEach((p,i)=>{
    p.role = selectedRoles[i];
    p.team = rolesData[p.role].team;
    p.alive = true;
    p.blocked = false;
    p.protected = false;
    p.actionUsed = false;
    p.copiedTargets = p.copiedTargets || [];
    p.copiedRole = p.copiedRole || null;
    p.copiedRoleActiveNight = p.copiedRoleActiveNight || null;
    p.lastActionTarget = null;
    p.wasBlockedByPolice = false;
    p.wasProtectedByKnight = false;
  });
}

// Game resolution helpers (similar to local) - server authoritative
function resolveNightForRoom(room){
  const messages = {};
  room.players.forEach(p=>messages[p.name]=[]);
  const findByName = name => room.players.find(p=>p.name===name);

  // 1 Protection
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'فارس' && !actor.blocked && target){
      target.protected = true;
      target.wasProtectedByKnight = true;
      messages[actor.name].push('🛡️ قمت بحماية الهدف');
    }
  });

  // 2 Block
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'شرطي' && !actor.blocked && target){
      target.blocked = true;
      target.wasBlockedByPolice = true;
      messages[actor.name].push('🚔 تم منع الهدف بنجاح');
    }
  });

  // 3 Copy
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'سارق' && !actor.blocked && target){
      if(actor.copiedTargets.includes(target.name)){
        messages[actor.name].push('🕵️ لا يمكنك نسخ نفس الشخص مرتين');
        return;
      }
      actor.copiedTargets.push(target.name);
      actor.copiedRole = target.role;
      actor.copiedRoleActiveNight = room.nightCount + 1;
      messages[actor.name].push(`🕵️ نسخت دور ${target.role} ${rolesData[target.role].emoji} ويمكنك استخدامه الليلة القادمة`);
      // privately inform thief
      io.to(actor.id).emit('privateMessage', { msg: `🕵️ نسخت دور ${target.role} ${rolesData[target.role].emoji}` });
    }
  });

  // 4 Kill
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'قاتل' && !actor.blocked && target){
      if(room.nightCount - (actor.lastKillNight||0) < 2){
        messages[actor.name].push('⏳ لا يمكنك القتل هذه الليلة');
      } else if(!target.protected){
        target.alive = false;
        actor.lastKillNight = room.nightCount;
        messages[actor.name].push('🔪 تم تنفيذ القتل');
      } else {
        messages[actor.name].push('🔪 حاولت القتل لكن الهدف محمي');
      }
    }
  });

  // 5 Writer
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'كاتب' && !actor.blocked && target){
      if(a.ability === 'revive'){
        target.alive = true;
        room.players.forEach(p=>{ messages[p.name].push(`✒️ تم إحياء ${target.name}`); });
      }
      if(a.ability === 'kill'){
        target.alive = false;
        messages[actor.name].push('✒️ تم قتل الهدف');
      }
    }
  });

  // 6 Investigator
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'محقق' && !actor.blocked && target){
      actor.investigated = actor.investigated || [];
      if(actor.investigated.includes(target.name)){
        messages[actor.name].push('🔍 لا يمكنك التحقيق من نفس اللاعب مرتين');
      } else {
        actor.investigated.push(target.name);
        const realEmoji = rolesData[target.role].emoji;
        const fakeRoles = Object.keys(rolesData).filter(r=>r!==target.role);
        const fakeRole = fakeRoles[Math.floor(Math.random()*fakeRoles.length)];
        const fakeEmoji = rolesData[fakeRole].emoji;
        const pair = Math.random() < 0.5 ? [realEmoji, fakeEmoji] : [fakeEmoji, realEmoji];
        messages[actor.name].push(`🔍 ${target.name} قد يكون: ${pair[0]} أو ${pair[1]}`);
      }
    }
  });

  // 7 King
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'ملك' && !actor.blocked && target){
      if(target.lastActionTarget){
        messages[actor.name].push(`👁️ ${target.name} استخدم قدرته على ${target.lastActionTarget}`);
      } else {
        messages[actor.name].push(`👁️ ${target.name} لم يستخدم قدرته`);
      }
    }
  });

  room.messages = messages;

  // Prepare per-player private reveals
  room.players.forEach(p=>{
    // private reveal messages array
    const pm = messages[p.name] || [];
    if(p.wasBlockedByPolice){ pm.push('🚔 لقد تم منعك بواسطة شرطي'); }
    if(p.wasProtectedByKnight){ pm.push('🛡️ تم حمايتك هذه الليلة'); }
    io.to(p.id).emit('nightResultPrivate', { msgs: pm });
  });

  // Broadcast public events: deaths and revive messages
  const deaths = room.players.filter(p=>!p.alive).map(p=>p.name);
  io.to(room.id).emit('nightResolved', { deaths, publicMsgs: collectPublicMessages(room.messages) });

  // Clear actions for next night and increase counter
  room.actions = [];
  room.nightCount += 1;

  // Evaluate win
  const alive = room.players.filter(p=>p.alive);
  const evil = alive.filter(p=>p.team === 'شر');
  const good = alive.filter(p=>p.team === 'خير');
  if(evil.length === 0){ io.to(room.id).emit('gameOver', { winner: 'خير' }); room.phase = 'ended'; }
  else if(evil.length >= good.length){ io.to(room.id).emit('gameOver', { winner: 'شر' }); room.phase = 'ended'; }
}

function collectPublicMessages(messages){
  const out = [];
  for(const k in messages){
    messages[k].forEach(m=>{
      // Only public messages: revive announcements are already pushed to all
      if(m.includes('✒️ تم إحياء')) out.push(m);
    });
  }
  return out;
}

io.on('connection', (socket)=>{
  console.log('sock connected', socket.id);

  socket.on('createRoom', ({ name }, cb)=>{
    const room = createRoom(socket.id, name);
    socket.join(room.id);
    cb({ ok: true, room: sanitizeRoom(room) });
    io.to(room.id).emit('roomState', sanitizeRoom(room));
  });

  socket.on('joinRoom', ({ code, name }, cb)=>{
    const room = rooms[code];
    if(!room) return cb({ error: 'Room not found' });
    if(room.players.length >= 6) return cb({ error: 'Room full' });
    if(room.players.find(p=>p.name === name)) return cb({ error: 'Name taken' });

    const player = joinRoom(code, socket.id, name, false);
    socket.join(code);
    io.to(code).emit('roomState', sanitizeRoom(room));
    cb({ ok: true, room: sanitizeRoom(room), player: { name: player.name } });
  });

  socket.on('leaveRoom', ({ code })=>{
    leaveRoom(code, socket.id);
    socket.leave(code);
  });

  socket.on('kickPlayer', ({ code, targetName })=>{
    const room = rooms[code];
    if(!room) return;
    const kicker = room.players.find(p=>p.id === socket.id);
    if(!kicker || !kicker.isHost) return;
    const t = room.players.find(p=>p.name === targetName);
    if(t){
      io.to(t.id).emit('kicked', { reason: 'removed_by_host' });
      // remove
      room.players = room.players.filter(p=>p.id !== t.id);
      delete room.messages[t.name];
      io.to(code).emit('roomState', sanitizeRoom(room));
      io.to(code).emit('systemMessage', { msg: `${targetName} was removed by host` });
    }
  });

  socket.on('startGame', ({ code }, cb)=>{
    const room = rooms[code];
    if(!room) return cb({ error: 'Room not found' });
    const host = room.players.find(p=>p.id === socket.id);
    if(!host || !host.isHost) return cb({ error: 'Not authorized' });
    if(room.players.length < 3) return cb({ error: 'Need at least 3 players' });

    assignRolesToRoom(room);
    room.phase = 'night';
    room.actions = [];
    // send private role reveal
    room.players.forEach(p=>{
      io.to(p.id).emit('roleReveal', { role: p.role, emoji: rolesData[p.role].emoji, team: p.team });
    });

    io.to(code).emit('roomState', sanitizeRoom(room));
    cb({ ok: true });
  });

  socket.on('playerAction', ({ code, actorName, targetName, ability }, cb)=>{
    const room = rooms[code];
    if(!room) return cb({ error: 'Room not found' });
    const actor = room.players.find(p=>p.name === actorName);
    if(!actor) return cb({ error: 'Actor not found' });
    if(!actor.alive) return cb({ error: 'Dead players cannot act' });
    if(actor.blocked) return cb({ error: 'You are blocked' });
    // basic validation target exists
    const target = room.players.find(p=>p.name === targetName);
    if(targetName && !target) return cb({ error: 'Target not found' });

    // prevent duplicate same-night multiple actions from same actor
    room.actions.push({ actor: actorName, target: targetName, ability });
    actor.actionUsed = true;
    actor.lastActionTarget = targetName || null;

    cb({ ok: true });
  });

  socket.on('startNightResolve', ({ code })=>{
    const room = rooms[code];
    if(!room) return;
    // only host can trigger resolution
    const caller = room.players.find(p=>p.id === socket.id);
    if(!caller || !caller.isHost) return;
    resolveNightForRoom(room);
  });

  socket.on('disconnecting', ()=>{
    // mark disconnected in rooms
    const socketRooms = Array.from(socket.rooms);
    socketRooms.forEach(r=>{
      if(rooms[r]){
        const p = rooms[r].players.find(pp=>pp.id === socket.id);
        if(p){ p.connected = false; io.to(r).emit('roomState', sanitizeRoom(rooms[r])); }
      }
    });
  });

  socket.on('disconnect', ()=>{ console.log('sock disconnected', socket.id); });
});

server.listen(PORT, ()=>{
  console.log('Server running on port ' + PORT);
});
