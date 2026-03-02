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
    phase: 'lobby', // lobby, night, voting, ended
    actions: [],
    messages: {},
    gameState: {}
  };
  room.nightTimerId = null;
  room.voteTimerId = null;
  room.nightEndsAt = null;
  room.voteEndsAt = null;
  room.votes = {};

  rooms[code] = room;
  joinRoom(code, hostSocketId, hostName, true);
  return room;
}

function startNightForRoom(room){
  if(!room) return;
  // clear any pending reveal starter
  if(room._revealTimer){ clearTimeout(room._revealTimer); room._revealTimer = null; }
  room.phase = 'night';
  // reset per-night flags for players
  room.players.forEach(pp=>{
    pp.blocked = false;
    pp.protected = false;
    pp.wasBlockedByPolice = false;
    pp.wasProtectedByKnight = false;
    pp.actionUsed = false;
    pp.lastActionTarget = null;
  });
  room.actions = [];
  room.nightEndsAt = Date.now() + 30*1000;
  io.to(room.id).emit('startNight', { seconds: 30, players: room.players.filter(p=>p.alive).map(p=>p.name) });

  // schedule resolve after 30s
  if(room._nightTimer) clearTimeout(room._nightTimer);
  room._nightTimer = setTimeout(()=>{
    resolveNightForRoom(room);
    room._nightTimer = null;
  }, 30*1000);
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
    players: room.players.map(p=>({ name: p.name, isHost: p.isHost, ready: p.ready, alive: p.alive, connected: p.connected, actionUsed: !!p.actionUsed })),
    phase: room.phase,
    nightCount: room.nightCount,
    nightEndsAt: room.nightEndsAt || null,
    voteEndsAt: room.voteEndsAt || null
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
  // clear night timer if present (we're resolving now)
  if(room.nightTimerId){ clearTimeout(room.nightTimerId); room.nightTimerId = null; }
  room.nightEndsAt = null;
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
      messages[actor.name].push(`�️ لقد ذهبت لحماية ${target.name}`);
    }
  });

  // 2 Block
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'شرطي' && !actor.blocked && target){
      target.blocked = true;
      target.wasBlockedByPolice = true;
      messages[actor.name].push(`� لقد حاولت منع ${target.name}`);
    }
  });

  // 3 Copy
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'سارق' && !actor.blocked && target){
      if(actor.copiedTargets.includes(target.name)){
        messages[actor.name].push(`🕵️ حاولت نسخ ${target.name} لكن لا يمكنك نسخ نفس الشخص مرتين`);
        return;
      }
      actor.copiedTargets.push(target.name);
      actor.copiedRole = target.role;
      actor.copiedRoleActiveNight = room.nightCount + 1;
      messages[actor.name].push(`�️ لقد نسخت دور ${target.role} من ${target.name} ويمكنك استخدامه الليلة القادمة`);
      // privately inform thief
      io.to(actor.id).emit('privateMessage', { msg: `🕵️ نسخت دور ${target.role} من ${target.name} ${rolesData[target.role].emoji}` });
    }
  });

  // 4 Kill
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'قاتل' && !actor.blocked && target){
      // always inform actor about attempted kill
      if(room.nightCount - (actor.lastKillNight||0) < 2){
        messages[actor.name].push(`⏳ حاولت قتل ${target.name} لكن لا يمكنك القتل الآن لسبب تباطؤ`);
      } else if(!target.protected){
        target.alive = false;
        actor.lastKillNight = room.nightCount;
        messages[actor.name].push(`🔪 لقد ذهبت لقتل ${target.name} وتم التنفيذ`);
      } else {
        messages[actor.name].push(`🔪 حاولت قتل ${target.name} لكن الهدف محمي`);
      }
    }
  });

  // 5 Writer
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'كاتب' && !actor.blocked && target){
      if(a.ability === 'revive'){
        messages[actor.name].push(`✒️ لقد حاولت إحياء ${target.name}`);
        target.alive = true;
        room.players.forEach(p=>{ messages[p.name].push(`✒️ تم إحياء ${target.name}`); });
      }
      if(a.ability === 'kill'){
        messages[actor.name].push(`✒️ لقد حاولت قتل ${target.name}`);
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
        messages[actor.name].push(`🔍 حاولت التحقيق من ${target.name} لكن لا يمكنك التحقيق من نفس اللاعب مرتين`);
      } else {
        actor.investigated.push(target.name);
        const realEmoji = rolesData[target.role].emoji;
        const fakeRoles = Object.keys(rolesData).filter(r=>r!==target.role);
        const fakeRole = fakeRoles[Math.floor(Math.random()*fakeRoles.length)];
        const fakeEmoji = rolesData[fakeRole].emoji;
        const pair = Math.random() < 0.5 ? [realEmoji, fakeEmoji] : [fakeEmoji, realEmoji];
        messages[actor.name].push(`🔍 لقد تحققت من ${target.name}: قد يكون ${pair[0]} أو ${pair[1]}`);
      }
    }
  });

  // 7 King
  room.actions.forEach(a=>{
    const actor = findByName(a.actor);
    const target = findByName(a.target);
    if(actor && actor.role === 'ملك' && !actor.blocked && target){
      if(target.lastActionTarget){
        messages[actor.name].push(`👁️ لقد راقبت ${target.name}: استخدم قدرته على ${target.lastActionTarget}`);
      } else {
        messages[actor.name].push(`👁️ لقد راقبت ${target.name}: لم يستخدم قدرته`);
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

  // Start a 30s reveal timer (server-controlled). After it ends, send private reveals and start voting phase.
  room.phase = 'reveal_wait';
  io.to(room.id).emit('startRevealTimer', { seconds: 30 });

  // clear any existing voting state
  room.votes = {};

  // After reveal delay, send private reveals and move to RESULT phase.
  if(room._revealToResultTimer) clearTimeout(room._revealToResultTimer);
  room._revealToResultTimer = setTimeout(()=>{
    // Send private reveals to each player
    room.players.forEach(p=>{
      const pm = room.messages[p.name] || [];
      io.to(p.id).emit('revealNow', { msgs: pm });
    });

    // Enter result phase and wait for client acknowledgements before starting voting
    room.phase = 'result';
    room._resultAcks = {};
    io.to(room.id).emit('roomState', sanitizeRoom(room));

    // Fallback: if not all acknowledge within 15s, start voting anyway
    if(room._resultAckTimer) clearTimeout(room._resultAckTimer);
    room._resultAckTimer = setTimeout(()=>{ startVotingForRoom(room); room._resultAckTimer = null; }, 15*1000);

  }, 30*1000);

  // Clear actions for next night and increase counter
  room.actions = [];
  room.nightCount += 1;
  // Evaluate win
  const alive = room.players.filter(p=>p.alive);
  const evil = alive.filter(p=>p.team === 'شر');
  const good = alive.filter(p=>p.team === 'خير');
  if(evil.length === 0){ io.to(room.id).emit('gameOver', { winner: 'خير' }); room.phase = 'ended'; }
  else if(evil.length >= good.length){ io.to(room.id).emit('gameOver', { winner: 'شر' }); room.phase = 'ended'; }
  else {
    // Game continues: stay in result phase until clients ack and server starts voting
    // (voting will be started by startVotingForRoom when clients acknowledge)
    room.votes = {};
  }

  // broadcast updated room state
  io.to(room.id).emit('roomState', sanitizeRoom(room));
}

function resolveVotingForRoom(room){
  // tally votes
  const votes = room.votes || {};
  const tally = {};
  for(const voter in votes){
    const choice = votes[voter] || 'skip';
    tally[choice] = (tally[choice]||0) + 1;
  }

  // find top choice except 'skip'
  const entries = Object.entries(tally).filter(([k])=>k!=='skip');
  let eliminated = null;
  if(entries.length === 0){
    // all skipped or no votes
    io.to(room.id).emit('voteResult', { eliminated: null, tally });
  } else {
    entries.sort((a,b)=>b[1]-a[1]);
    const top = entries[0];
    // check majority skip: if skip count > top, skip elimination
    const skipCount = tally['skip'] || 0;
    if(skipCount >= top[1]){
      io.to(room.id).emit('voteResult', { eliminated: null, tally });
    } else {
      eliminated = top[0];
      const target = room.players.find(p=>p.name===eliminated);
      if(target){ target.alive = false; }
      // reveal role publicly
      const revealMsg = `${eliminated} تم إخراجه — دوره: ${target ? target.role : 'Unknown'}`;
      io.to(room.id).emit('systemMessage', { msg: revealMsg });
      io.to(room.id).emit('voteResult', { eliminated, tally, revealedRole: target ? target.role : null });
    }
  }

  // after voting, check win
  const alive = room.players.filter(p=>p.alive);
  const evil = alive.filter(p=>p.team === 'شر');
  const good = alive.filter(p=>p.team === 'خير');
  if(evil.length === 0){ io.to(room.id).emit('gameOver', { winner: 'خير' }); room.phase = 'ended'; }
  else if(evil.length >= good.length){ io.to(room.id).emit('gameOver', { winner: 'شر' }); room.phase = 'ended'; }
  else {
    // continue to next night
    // prepare next night: reset per-night flags
    room.phase = 'night';
    room.voteEndsAt = null;
    if(room.voteTimerId){ clearTimeout(room.voteTimerId); room.voteTimerId = null; }
    room.players.forEach(pp=>{
      pp.blocked = false;
      pp.protected = false;
      pp.wasBlockedByPolice = false;
      pp.wasProtectedByKnight = false;
      pp.actionUsed = false;
      pp.lastActionTarget = null;
      pp.ready = false; // require acknowledgment again if desired
    });
    room.nightEndsAt = Date.now() + 30000;
    if(room.nightTimerId) clearTimeout(room.nightTimerId);
    room.nightTimerId = setTimeout(()=>{ resolveNightForRoom(room); }, 30000);
  }

  // broadcast updated state
  io.to(room.id).emit('roomState', sanitizeRoom(room));
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

function startVotingForRoom(room){
  if(!room) return;
  if(room._resultAckTimer){ clearTimeout(room._resultAckTimer); room._resultAckTimer = null; }
  room.phase = 'voting';
  const alivePlayers = room.players.filter(p=>p.alive).map(p=>p.name);
  room.voteEndsAt = Date.now() + 30*1000;
  io.to(room.id).emit('startVoting', { players: alivePlayers, seconds: 30 });
  if(room._votingTimer) clearTimeout(room._votingTimer);
  room._votingTimer = setTimeout(()=>{ tallyVotesForRoom(room); }, 30*1000);
  io.to(room.id).emit('roomState', sanitizeRoom(room));
}

function tallyVotesForRoom(room){
  const votes = room.votes || {};
  const tally = {};
  room.players.filter(p=>p.alive).forEach(p=>{
    const v = votes[p.name] || '___skip';
    tally[v] = (tally[v]||0) + 1;
  });

  // Determine highest
  let highest = 0; let winners = [];
  for(const k in tally){
    if(tally[k] > highest){ highest = tally[k]; winners = [k]; }
    else if(tally[k] === highest){ winners.push(k); }
  }

  let eliminatedName = null;
  if(winners.length === 1 && winners[0] !== '___skip'){
    eliminatedName = winners[0];
    const eliminated = room.players.find(p=>p.name === eliminatedName);
    if(eliminated){
      eliminated.alive = false;
      // reveal role to all
      io.to(room.id).emit('votingResult', { eliminatedName: eliminated.name, role: eliminated.role, tally });
    }
  } else {
    io.to(room.id).emit('votingResult', { eliminatedName: null, tally });
  }

  // After voting, clear votes and move to next phase (day)
  room.votes = {};
  room.phase = 'day';
  io.to(room.id).emit('roomState', sanitizeRoom(room));

  // Evaluate win
  const alive = room.players.filter(p=>p.alive);
  const evil = alive.filter(p=>p.team === 'شر');
  const good = alive.filter(p=>p.team === 'خير');
  if(evil.length === 0){ io.to(room.id).emit('gameOver', { winner: 'خير' }); room.phase = 'ended'; }
  else if(evil.length >= good.length){ io.to(room.id).emit('gameOver', { winner: 'شر' }); room.phase = 'ended'; }
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
    room.phase = 'reveal';
    room.actions = [];
    room.votes = {};
    // mark all players not-yet-ready (they must acknowledge role card)
    room.players.forEach(p=>{ p.ready = false; });
    // send private role reveal
    room.players.forEach(p=>{
      io.to(p.id).emit('roleReveal', { role: p.role, emoji: rolesData[p.role].emoji, team: p.team });
    });

    io.to(code).emit('roomState', sanitizeRoom(room));
    cb({ ok: true });
  });

  socket.on('roleReady', ({ code, name })=>{
    const room = rooms[code];
    if(!room) return;
    const p = room.players.find(x=>x.name===name);
    if(!p) return;
    p.ready = true;
    io.to(code).emit('roomState', sanitizeRoom(room));
    // if all players are ready, start night immediately via helper
    if(room.players.every(x=>x.ready)){
      if(room._revealTimer){ clearTimeout(room._revealTimer); room._revealTimer = null; }
      startNightForRoom(room);
    } else {
      // start a fallback timer to auto-start night after 15s since first ready
      if(!room._revealTimer){
        room._revealTimer = setTimeout(()=>{ startNightForRoom(room); room._revealTimer = null; }, 15*1000);
      }
    }
  });

  socket.on('playerAction', ({ code, actorName, targetName, ability }, cb)=>{
    const room = rooms[code];
    if(!room) return cb({ error: 'Room not found' });
    const actor = room.players.find(p=>p.name === actorName);
    if(!actor) return cb({ error: 'Actor not found' });
    if(!actor.alive) return cb({ error: 'Dead players cannot act' });
    if(room.phase !== 'night') return cb({ error: 'Not night phase' });
    if(actor.blocked) return cb({ error: 'You are blocked' });
    if(actor.actionUsed) return cb({ error: 'You have already used your action this night' });
    // basic validation target exists
    const target = room.players.find(p=>p.name === targetName);
    if(targetName && !target) return cb({ error: 'Target not found' });

    // record action for this night
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

  socket.on('resultAck', ({ code, name }, cb)=>{
    const room = rooms[code];
    if(!room) return cb && cb({ error: 'Room not found' });
    room._resultAcks = room._resultAcks || {};
    room._resultAcks[name] = true;
    io.to(code).emit('systemMessage', { msg: `${name} أقر بالنتائج` });

    // if all alive players acknowledged, start voting
    const alive = room.players.filter(p=>p.alive).map(p=>p.name);
    const allAck = alive.every(n => room._resultAcks && room._resultAcks[n]);
    if(allAck){
      if(room._resultAckTimer){ clearTimeout(room._resultAckTimer); room._resultAckTimer = null; }
      startVotingForRoom(room);
    }
    cb && cb({ ok: true });
  });

  socket.on('submitVote', ({ code, voterName, choice }, cb)=>{
    const room = rooms[code];
    if(!room) return cb && cb({ error: 'Room not found' });
    const voter = room.players.find(p=>p.name === voterName);
    if(!voter) return cb && cb({ error: 'Voter not found' });
    if(!voter.alive) return cb && cb({ error: 'Dead cannot vote' });
    if(room.phase !== 'voting') return cb && cb({ error: 'Not voting phase' });

    room.votes = room.votes || {};
    room.votes[voterName] = choice;

    // If all alive voted, tally early
    const alive = room.players.filter(p=>p.alive).map(p=>p.name);
    const votedCount = Object.keys(room.votes).length;
    if(votedCount >= alive.length){
      if(room._votingTimer) { clearTimeout(room._votingTimer); room._votingTimer = null; }
      tallyVotesForRoom(room);
    }

    cb && cb({ ok: true });
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
