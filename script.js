const app = document.getElementById("app");

let players = [];
let currentRevealIndex = 0;
let currentNightActorIndex = 0;
let nightActions = [];
let nightCount = 1;
let resultsMessages = {};
let currentResultIndex = 0;
let currentVoteIndex = 0;
let voteTally = {};

// ---------- الأدوار ----------
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

// ---------- إعداد ----------
function showSetup() {
  app.innerHTML = `
    <h2>ليلة الممالك</h2>
    <p>أدخل أسماء اللاعبين (3 إلى 7)</p>
    <div id="inputs"></div>
    <button onclick="addPlayerInput()">إضافة لاعب</button>
    <button onclick="startGame()">بدء اللعبة</button>
  `;
  for (let i = 0; i < 3; i++) addPlayerInput();
}

function addPlayerInput() {
  const div = document.getElementById("inputs");
  const input = document.createElement("input");
  input.placeholder = "اسم اللاعب";
  div.appendChild(input);
}

// ---------- بدء اللعبة ----------
function startGame() {
  const inputs = document.querySelectorAll("#inputs input");
  players = [];
  currentRevealIndex = 0;
  nightCount = 1;

  inputs.forEach(input => {
    if (input.value.trim()) {
      players.push({
        name: input.value.trim(),
        role: null,
        team: null,
        alive: true,
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
        wasProtectedByKnight: false
      });
    }
  });

  if (players.length < 3 || players.length > 7) {
    alert("عدد اللاعبين من 3 إلى 7");
    return;
  }

  assignRoles();
  showRoleReveal();
}

// ---------- توزيع الأدوار ----------
function assignRoles() {
  // Ensure at least one قاتل (killer)
  let availableRoles = [...rolesList];
  const selectedRoles = [];

  if (availableRoles.includes("قاتل")) {
    selectedRoles.push("قاتل");
    availableRoles = availableRoles.filter(r => r !== "قاتل");
  }

  while (selectedRoles.length < players.length) {
    const idx = Math.floor(Math.random() * availableRoles.length);
    selectedRoles.push(availableRoles[idx]);
    availableRoles.splice(idx, 1);
  }

  // Shuffle selected roles
  selectedRoles.sort(() => Math.random() - 0.5);

  players.forEach((p, i) => {
    p.role = selectedRoles[i];
    p.team = rolesData[p.role].team;
    p.copiedTargets = p.copiedTargets || [];
    p.copiedRole = p.copiedRole || null;
  });
}

// ---------- كشف الأدوار ----------
function showRoleReveal() {
  if (currentRevealIndex >= players.length) {
    startNight();
    return;
  }

  const player = players[currentRevealIndex];

  app.innerHTML = `
    <h2>${player.name}</h2>
    <p>مرر الهاتف له ثم اضغط كشف الدور</p>
    <button onclick="revealRole()">كشف الدور</button>
  `;
}

function revealRole() {
  const player = players[currentRevealIndex];

  app.innerHTML = `
    <h2>دورك هو:</h2>
    <div class="role-card-mini mini-fade">
      <img src="cards/${player.role}.png" alt="role">
      <div style="text-align:left">
        <div class="role-name">${player.role}</div>
        <div class="role-emoji">${rolesData[player.role].emoji}  فريق: ${player.team}</div>
      </div>
    </div>
    <button onclick="nextPlayer()">إخفاء وتسليم الهاتف</button>
  `;
}
function nextPlayer() {
  currentRevealIndex++;
  showRoleReveal();
}

// ---------- الليل ----------
function startNight() {
  nightActions = [];
  currentNightActorIndex = 0;

  players.forEach(p => {
    p.blocked = false;
    p.protected = false;
    p.actionUsed = false;

    // Reset temporary copied ability if expired
    if(p.copiedRole && p.copiedRoleActiveNight !== nightCount){
      p.copiedRole = null;
      p.copiedRoleActiveNight = null;
    }

    p.wasBlockedByPolice = false;
    p.wasProtectedByKnight = false;
  });

  showNightTurn();
}

function showNightTurn(){
  const alive=players.filter(p=>p.alive);

  if(currentNightActorIndex>=alive.length){
    resolveNight();
    return;
  }

  const player=alive[currentNightActorIndex];

  app.innerHTML=`
    <div class="fade-in">
      <h3>الآن دور: ${player.name}</h3>
      <p>مرر الهاتف له</p>
      <button onclick="revealNightRole('${player.name}')">كشف دوري</button>
    </div>
  `;
}

function skipNight() {
  const alive = players.filter(p=>p.alive);
  const player = alive[currentNightActorIndex];
  showEndTurn(player ? player.name : '');
}

function revealNightRole(playerName){
  const player = players.find(p => p.name === playerName);
  if(!player) return;

  let extraAbility = "";
  if(player.role === "سارق" && player.copiedRole && player.copiedRoleActiveNight === nightCount){
    extraAbility = `<p>✨ لديك قدرة منسوخة: ${player.copiedRole} ${rolesData[player.copiedRole].emoji}</p>`;
  }

  app.innerHTML = `
    <h3>دورك</h3>
    <div class="role-card-mini mini-fade">
      <img src="cards/${player.role}.png" alt="role">
      <div style="text-align:left">
        <div class="role-name">${player.role}</div>
        <div class="role-emoji">${rolesData[player.role].emoji}  فريق: ${player.team}</div>
      </div>
    </div>
    ${extraAbility}
  `;

  if(!player.alive){
    app.innerHTML += `<p>أنت خارج اللعبة</p><button onclick="showEndTurn('${player.name}')">إخفاء وتسليم الهاتف</button>`;
    return;
  }

  if(player.blocked){
    app.innerHTML += `<p>لقد تم منعي هذه الليلة</p><button onclick="showEndTurn('${player.name}')">إخفاء وتسليم الهاتف</button>`;
    return;
  }

  const actionableRoles = ["قاتل","شرطي","فارس","محقق","سارق","كاتب","ملك"];
  if(actionableRoles.includes(player.role) && !player.actionUsed){
    app.innerHTML += `<button onclick="chooseTarget('${player.name}')">تنفيذ القدرة</button>`;
  } else {
    app.innerHTML += `<button onclick="showEndTurn('${player.name}')">إنهاء الدور</button>`;
  }
}

// ---------- اختيار الهدف ----------
function chooseTarget(actorName) {
  const actor = players.find(p => p.name === actorName);

  // Killer cooldown immediate feedback
  if (actor.role === "قاتل" && nightCount - (actor.lastKillNight||0) < 2) {
    app.innerHTML = `<p>⏳ لا يمكنك القتل هذه الليلة</p><button onclick="showEndTurn('${actor.name}')">إخفاء وتسليم الهاتف</button>`;
    return;
  }

  if (actor.role === "كاتب") {
    app.innerHTML = `
      <h3>اختر القدرة</h3>
      <button onclick="writerSelect('${actor.name}','revive')">إحياء</button>
      <button onclick="writerSelect('${actor.name}','kill')">قتل</button>
    `;
    return;
  }

  let candidates = players.filter(p => p.alive && p.name !== actorName);

  if(actor.role === "محقق"){
    candidates = candidates.filter(p => !(actor.investigated||[]).includes(p.name));
  }

  if(actor.role === "سارق"){
    actor.copiedTargets = actor.copiedTargets || [];
    candidates = candidates.filter(p => !actor.copiedTargets.includes(p.name));
  }

  const targets = candidates.map(p => `<button onclick="registerAction('${actorName}','${p.name}')">${p.name}</button>`).join("");

  app.innerHTML = `<h2>اختر الهدف</h2>${targets}`;
}

function writerSelect(actorName, ability) {
  const targets = players
    .filter(p => p.name !== actorName)
    .map(p => `<button onclick="applyWriter('${actorName}','${ability}','${p.name}')">${p.name}</button>`)
    .join("");

  app.innerHTML = `<h3>اختر الهدف</h3>${targets}`;
}

function applyWriter(actorName, ability, targetName) {
  nightActions.push({actor:actorName,target:targetName,ability:ability});
  const actor = players.find(p=>p.name===actorName);
  if(actor) actor.actionUsed = true;
  showEndTurn(actorName);
}

function registerAction(actorName, targetName) {
  nightActions.push({actor:actorName,target:targetName});
  const actor = players.find(p=>p.name===actorName);
  if(actor) actor.actionUsed = true;
  if(actor){
    actor.lastActionTarget = targetName;
  }
  showEndTurn(actorName);
}

// ---------- تنفيذ الليل (Priority System) ----------
function resolveNight() {
  let messages = {};
  players.forEach(p => messages[p.name] = []);

  const find = name => players.find(p => p.name === name);

  // 1. Protection (فارس)
  nightActions.forEach(a=>{
    const actor = find(a.actor);
    const target = find(a.target);

    if(actor && actor.role === "فارس" && !actor.blocked && target){
      target.protected = true;
      target.wasProtectedByKnight = true;
      messages[actor.name].push("🛡️ قمت بحماية الهدف");
    }
  });

  // 2. Block (شرطي)
  nightActions.forEach(a=>{
    const actor = find(a.actor);
    const target = find(a.target);

    if(actor && actor.role === "شرطي" && !actor.blocked && target){
      target.blocked = true;
      target.wasBlockedByPolice = true;
      messages[actor.name].push("🚔 تم منع الهدف بنجاح");
    }
  });

  // 3. Copy (سارق)
  nightActions.forEach(a=>{
    const actor = find(a.actor);
    const target = find(a.target);

    if(actor && actor.role === "سارق" && !actor.blocked && target){

      if(actor.copiedTargets.includes(target.name)){
        messages[actor.name].push("🕵️ لا يمكنك نسخ نفس الشخص مرتين");
        return;
      }

      actor.copiedTargets.push(target.name);
      actor.copiedRole = target.role;
      actor.copiedRoleActiveNight = nightCount + 1; // usable next night

      messages[actor.name].push(`🕵️ نسخت دور ${target.role} ${rolesData[target.role].emoji} ويمكنك استخدامه الليلة القادمة`);
    }
  });

  // 4. Kill (قاتل)
  nightActions.forEach(a=>{
    const actor = find(a.actor);
    const target = find(a.target);
    if(actor && actor.role === "قاتل" && !actor.blocked && target){
      if(nightCount - (actor.lastKillNight||0) < 2){
        messages[actor.name].push("⏳ لا يمكنك القتل هذه الليلة");
      } else if(!target.protected){
        target.alive = false;
        actor.lastKillNight = nightCount;
        messages[actor.name].push("🔪 تم تنفيذ القتل");
      } else {
        messages[actor.name].push("🔪 حاولت القتل لكن الهدف محمي");
      }
    }
  });

  // 5. Writer (كاتب)
  nightActions.forEach(a=>{
    const actor = find(a.actor);
    const target = find(a.target);

    if(actor && actor.role === "كاتب" && !actor.blocked && target){

      if(a.ability === "revive"){
        target.alive = true;

        players.forEach(p=>{
          messages[p.name].push(`✒️ تم إحياء ${target.name}`);
        });
      }

      if(a.ability === "kill"){
        target.alive = false;
        messages[actor.name].push("✒️ تم قتل الهدف");
      }
    }
  });

  // 6. Investigator (محقق)
  nightActions.forEach(a=>{
    const actor = find(a.actor);
    const target = find(a.target);
    if(actor && actor.role === "محقق" && !actor.blocked && target){
      actor.investigated = actor.investigated || [];
      if(actor.investigated.includes(target.name)){
        messages[actor.name].push("🔍 لا يمكنك التحقيق من نفس اللاعب مرتين");
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

  // 7. King (ملك)
  nightActions.forEach(a=>{
    const actor = find(a.actor);
    const target = find(a.target);

    if(actor && actor.role === "ملك" && !actor.blocked && target){
      if(target.lastActionTarget){
        messages[actor.name].push(`👁️ ${target.name} استخدم قدرته على ${target.lastActionTarget}`);
      } else {
        messages[actor.name].push(`👁️ ${target.name} لم يستخدم قدرته`);
      }
    }
  });

  // Save messages for private reveals
  resultsMessages = messages;

  showNightResults(messages);
  nightCount++;
}
// ---------- عرض النتائج ----------
function showNightResults(messages){
  // Private pass-and-reveal sequence
  currentResultIndex = 0;
  resultsMessages = messages;
  showResultPass();
}

function showResultPass(){
  if(currentResultIndex >= players.length){
    showDay();
    return;
  }
  const player = players[currentResultIndex];
  app.innerHTML = `
    <div class="fade-in">
      <h3>نتيجة: ${player.name}</h3>
      <p>مرر الهاتف له</p>
      <button onclick="revealResult()">كشف النتيجة</button>
    </div>
  `;
}

function revealResult(){
  const player = players[currentResultIndex];
  let msg = (resultsMessages[player.name]||[]).join("<br>") || "لا شيء حدث لك";

  if(player.wasBlockedByPolice){
    msg += "<br>🚔 تم منعك بواسطة شرطي";
  }

  if(player.wasProtectedByKnight){
    msg += "<br>🛡️ تم حمايتك هذه الليلة";
  }
  app.innerHTML = `
    <div class="private-box mini-fade">
      <h3>نتيجتك يا ${player.name}</h3>
      <p>${msg}</p>
    </div>
    <button onclick="hideResult()">إخفاء وتسليم الهاتف</button>
  `;
}

function hideResult(){
  currentResultIndex++;
  showResultPass();
}

// ---------- النهار ----------
function showDay(){
  const dead=players.filter(p=>!p.alive).map(p=>p.name);

  app.innerHTML=`
    <h2>نهار</h2>
    <p>الذين خرجوا: ${dead.join(", ")||"لا أحد"}</p>
    <button onclick="startVotingRound()">التصويت الآن</button>
  `;
}

// ---------- تصويت النهار (خاص، مرر الجهاز لكل لاعب) ----------
function startVotingRound(){
  // First check win conditions
  const alive = players.filter(p=>p.alive);
  const evil = alive.filter(p=>p.team==="شر");
  const good = alive.filter(p=>p.team==="خير");
  if(evil.length===0){ endGame("فريق الخير فاز 👑"); return; }
  if(evil.length>=good.length){ endGame("فريق الشر فاز 🔪"); return; }

  // Initialize votes
  players.forEach(p=>p.vote = null);
  voteTally = {};
  currentVoteIndex = 0;
  showVotePass();
}

function showVotePass(){
  const alivePlayers = players.filter(p=>p.alive);
  if(currentVoteIndex >= alivePlayers.length){
    // All votes cast -> tally
    tallyVotes();
    return;
  }
  const voter = alivePlayers[currentVoteIndex];
  app.innerHTML = `
    <div class="fade-in">
      <h3>دور التصويت: ${voter.name}</h3>
      <p>مرر الهاتف له</p>
      <button onclick="revealVote('${voter.name}')">كشف نافذة التصويت</button>
    </div>
  `;
}

function revealVote(voterName){
  const voter = players.find(p=>p.name===voterName);
  if(!voter) return;
  const aliveCandidates = players.filter(p=>p.alive && p.name !== voterName).map(p=>p.name);
  // build buttons: each other alive player + تخطي
  const buttons = aliveCandidates.map(n=>`<button onclick="submitVote('${voterName}','${n}')">${n}</button>`).join('') + `<button onclick="submitVote('${voterName}','___skip')">تخطي التصويت</button>`;
  app.innerHTML = `
    <h3>التصويت: ${voter.name}</h3>
    <p>اختر من تريد التصويت ضده أو تخطى</p>
    <div>${buttons}</div>
  `;
}

function submitVote(voterName, choice){
  const voter = players.find(p=>p.name===voterName);
  if(!voter) return;
  voter.vote = choice;
  currentVoteIndex++;
  // show hide/pass screen
  app.innerHTML = `
    <div class="fade-in">
      <h3>تم التصويت</h3>
      <p>مرر الهاتف للاعب التالي</p>
      <button onclick="showVotePass()">متابعة</button>
    </div>
  `;
}

function tallyVotes(){
  voteTally = {};
  players.filter(p=>p.alive).forEach(p=>{
    const v = p.vote || '___skip';
    voteTally[v] = (voteTally[v]||0) + 1;
  });

  // Determine highest (exclude skip for elimination unless skip highest?)
  // If skip has highest or tie -> no one eliminated
  let highest = 0;
  let winners = [];
  for(const k in voteTally){
    if(voteTally[k] > highest){ highest = voteTally[k]; winners = [k]; }
    else if(voteTally[k] === highest){ winners.push(k); }
  }

  // If single winner and not skip, eliminate
  if(winners.length === 1 && winners[0] !== '___skip'){
    const eliminated = players.find(p=>p.name === winners[0]);
    if(eliminated){ eliminated.alive = false; }
    showVoteResult(eliminated ? eliminated.name : null, voteTally);
  } else {
    // tie or skip highest -> no elimination
    showVoteResult(null, voteTally);
  }
}

function showVoteResult(eliminatedName, tally){
  const lines = [];
  for(const k in tally){
    const label = k === '___skip' ? 'تخطي' : k;
    lines.push(`${label}: ${tally[k]} صوت`);
  }
  const detail = lines.join('<br>');
  let msg = '';
  if(eliminatedName){ msg = `تم التصويت وأُخرج: ${eliminatedName}`; }
  else { msg = 'التصويت انتهى بدون إخراج (تعادل أو تم التخطي)'; }

  app.innerHTML = `
    <h2>نتيجة التصويت</h2>
    <p>${msg}</p>
    <div class="private-box">${detail}</div>
    <button onclick="checkWinAfterVote()">استمرار</button>
  `;
}

function checkWinAfterVote(){
  const alive = players.filter(p=>p.alive);
  const evil = alive.filter(p=>p.team==="شر");
  const good = alive.filter(p=>p.team==="خير");
  if(evil.length===0){ endGame("فريق الخير فاز 👑"); return; }
  if(evil.length>=good.length){ endGame("فريق الشر فاز 🔪"); return; }
  // otherwise next night
  startNight();
}

// ---------- الفوز ----------
function checkWin(){
  const alive=players.filter(p=>p.alive);
  const evil=alive.filter(p=>p.team==="شر");
  const good=alive.filter(p=>p.team==="خير");

  if(evil.length===0){
    endGame("فريق الخير فاز 👑");
    return;
  }

  if(evil.length>=good.length){
    endGame("فريق الشر فاز 🔪");
    return;
  }

  startNight();
}

function endGame(text){
  app.innerHTML=`
    <h2>${text}</h2>
    <button onclick="location.reload()">إعادة اللعب</button>
  `;
}
function showEndTurn(playerName){
  currentNightActorIndex++;

  app.innerHTML=`
    <div class="fade-in">
      <h3>انتهى دورك يا ${playerName}</h3>
      <p>مرر الهاتف للاعب التالي</p>
      <button onclick="showNightTurn()">متابعة</button>
    </div>
  `;
}
showSetup();