import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import JSZip from 'https://esm.sh/jszip@3.10.1';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';
import { PALETTE } from './palette.js';
// v10.1: Pair validation is bundled here so a missing separate module cannot disable room creation.
// HELD: two distinct participants must both provide fresh, active hand states.
// Pure logic: independently testable and intentionally no single-user fallback.
const GESTURE_TTL_MS = 850;
const MODES = new Set(['pinch','point']);

function pairedMode(a,b,now,ttl=GESTURE_TTL_MS){
  if(!a || !b || a.actor!=='A' || b.actor!=='B')return null;
  for(const hand of [a,b]){
    if(!MODES.has(hand.mode) || !hand.contact || !hand.p ||
       !Number.isFinite(hand.p.x) || !Number.isFinite(hand.p.y) ||
       !Number.isFinite(hand.seen) || now-hand.seen<0 || now-hand.seen>ttl ||
       !hand.session || !Number.isInteger(hand.seq))return null;
  }
  if(a.mode==='pinch'&&b.mode==='pinch')return 'both-pinch';
  if(a.mode==='pinch'&&b.mode==='point')return 'b-poke';
  if(a.mode==='point'&&b.mode==='pinch')return 'a-poke';
  return null;
}

function actionFromPair(a,b,prior,now){
  const mode=pairedMode(a,b,now);
  if(!mode)return {status:'locked',op:null};
  const signature=[a.session,a.mode,b.session,b.mode].join('|');
  const current={signature,mode,dist:Math.hypot(b.p.x-a.p.x,b.p.y-a.p.y),
    a:{...a.p},b:{...b.p},aSeq:a.seq,bSeq:b.seq};
  if(!prior || prior.signature!==signature)return {status:'armed',op:null,current};
  if(mode==='both-pinch'){
    const change=current.dist-prior.dist;
    if(Math.abs(change)<3.3)return {status:'armed',op:null,current};
    return {status:change>0?'stretch':'squeeze',current,
      op:{tool:change>0?'stretch':'squeeze',pair:[{...a.p},{...b.p}],amount:Math.max(-26,Math.min(26,change))}};
  }
  const key=mode==='a-poke'?'a':'b',p=current[key],old=prior[key];
  const dx=p.x-old.x,dy=p.y-old.y;
  if(Math.hypot(dx,dy)<3.2)return {status:'armed',op:null,current};
  return {status:'poke',current,op:{tool:'poke',at:{...p},delta:{x:dx,y:dy}}};
}

const $ = id => document.getElementById(id);
const show = (id, yes=true) => $(id).classList.toggle('hidden',!yes);
const notify = message => { $('toast').textContent=message; show('toast'); setTimeout(()=>show('toast',false),5500); };
const configured = SUPABASE_URL.startsWith('https://') && !SUPABASE_PUBLISHABLE_KEY.startsWith('PASTE');
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY) : null;
const params = new URLSearchParams(location.search), roomId=params.get('room');
let userId=null,role=null,room=null,channel=null,ready=false;
let localStream=null,remoteStream=null,pc=null,startedCall=false,offerMade=false;
let remoteIceQueue=[],handledSignals=new Set(),catchingSignals=false;
let mediaRecorder=null,recordingStream=null,recordChunks=[];
const STROKES=['vertical','horizontal','curve'];
const NAMES={vertical:'VERTICAL',horizontal:'HORIZONTAL',curve:'CURVE'};
const SIZE={w:1000,h:700};
let activeReview='vertical',sculptTool='stretch',savingOps=false,switchingStroke=false;
let pointerStates=new Map(),lastSculptAt=0,holderWriteAt=0;
let handMode=false,handTracker=null,handLoopRunning=false,handLast=0,handHistory=new Map();
let paletteChoices={A:{},B:{}},paletteVersions={A:{},B:{}};
// Soft-state events use the existing public.signals table (already working for WebRTC).
// No dependency on the v7 append_clay_ops RPC or holder_role database migration.
let softEvents=[],softSeen=new Set(),softHolder='A',softPin=null,softRequest=null,softSeq=0;
function syncSoftRoom(){
  if(!room)return;
  room.path=softEvents;
  room.holder_role=softHolder;
  room.swap_requested_by=softRequest;
  room.steer={anchor:softPin};
}
function processSoftEvent(message,sender){
  const e=message?.event,id=message?.eid;
  if(!e||!id||softSeen.has(id)||!room)return;
  const actor=sender===room.player_a?'A':sender===room.player_b?'B':null;
  if(!actor)return;
  softSeen.add(id);
  const active=()=>{for(let i=softEvents.length-1;i>=0;i--)if(softEvents[i]?.kind==='stage')return softEvents[i].stroke;return 'vertical';};
  if(e.k==='anchor'&&actor===softHolder&&Array.isArray(e.anchor)&&e.anchor.length===2){
    softPin=e.anchor.map(v=>clamp(Number(v)||0,0,1));
  }else if(e.k==='joint-op'&&actor==='A'&&e.op?.kind==='clay'&&
      e.op.stroke===active()&&e.proof?.A?.session&&e.proof?.B?.session&&
      Number.isInteger(e.proof.A.seq)&&Number.isInteger(e.proof.B.seq)){
    // Legacy one-player ops are intentionally rejected. Every v10 edit must
    // originate from an active, fresh A+B gesture pair on the authoritative A client.
    if(softEvents.filter(v=>v.kind==='clay'&&v.stroke===active()).length<170)
      softEvents.push(e.op);
  }else if(e.k==='stage'&&actor==='A'&&STROKES.includes(e.stroke)){
    const index=STROKES.indexOf(active()),next=STROKES.indexOf(e.stroke);
    if(Math.abs(next-index)===1 && (next<index || softEvents.some(v=>v.kind==='clay'&&v.stroke===active())))
      {softEvents.push({kind:'stage',stroke:e.stroke});softPin=null;
       pairHands.A=null;pairHands.B=null;priorPair=null;resetOwnGesture();}
  }else if(e.k==='swap-request'&&softRequest===null){softRequest=actor;
  }else if(e.k==='swap-cancel'&&softRequest===actor){softRequest=null;
  }else if(e.k==='swap-accept'&&softRequest!==null&&softRequest!==actor){softRequest=null;softHolder=softHolder==='A'?'B':'A';}
  syncSoftRoom();paint();updateStrokeUI();updateRoleUI();if(ready)updateStudioState();
}
async function sendSoft(event){
  const message={type:'soft',eid:`${userId}:${Date.now()}:${++softSeq}`,event};
  await sendSignal(message);processSoftEvent(message,userId);
}

window.HELD_VIDEO_BUILD='v3-addTrack-2026-11-18';
window.HELD_TURN_BUILD="v10.6-metered-turn";
window.HELD_INTERACTION_BUILD='v10.2-ipad-hand-loader-2026-11-19';
window.HELD_HAND_BUILD='v10.2-ipad-hand-loader-2026-11-19';
window.HELD_EXPORT_BUILD='v9-minimal-preserves-v8.1-export';
function setConnection(message){$('connectionTag').textContent=message;}
function safeError(e){console.error('[Held v10.1]',e);const message=e?.message||String(e);notify(message);if(!roomId){$('setupError').textContent='Could not create room: '+message;show('setupError');}}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function holderRole(){return room?.holder_role==='B'?'B':'A';}
function isHolder(){return !!role && role===holderRole();}
function isSculptor(){return !!role && role!==holderRole();}
function currentStroke(path=room?.path){
  for(const item of [...(Array.isArray(path)?path:[])].reverse())if(item?.kind==='stage'&&STROKES.includes(item.stroke))return item.stroke;
  return 'vertical';
}
function opsFor(stroke,path=room?.path){return (Array.isArray(path)?path:[]).filter(x=>x?.kind==='clay'&&x.stroke===stroke&&Array.isArray(x.at)&&Array.isArray(x.delta));}
function allSculpted(){return STROKES.every(s=>opsFor(s).length>0);}
async function login(){
  const {data:{session},error}=await supabase.auth.getSession();if(error)throw error;
  if(session){userId=session.user.id;return;}
  const r=await supabase.auth.signInAnonymously();if(r.error)throw Error(r.error.message+' — Enable Anonymous sign-ins in Supabase Auth settings.');
  userId=r.data.user.id;
}
async function createRoom(){
  try{$('createBtn').disabled=true;await login();const {data,error}=await supabase.rpc('create_room');if(error)throw error;location.href=`${location.pathname}?room=${encodeURIComponent(data)}`;}
  catch(e){safeError(e);$('createBtn').disabled=false;}
}
async function patchRoom(values){const {error}=await supabase.from('rooms').update(values).eq('id',roomId);if(error)throw error;}
async function getRoom(){const {data,error}=await supabase.from('rooms').select('*').eq('id',roomId).single();if(error)throw error;applyRoom(data);}
function applyRoom(next){
  if(!next||next.id!==roomId)return;
  const oldRoom=room,wasHolder=oldRoom?.holder_role||'A';room=next;syncSoftRoom();
  // Roles A and B now have identical physical tools; no role-change side effects.
  $('peerStatus').textContent=room.player_b?'TWO PARTICIPANTS JOINED':'Waiting for your partner';
  $('roomLiveState').textContent=room.player_b?'PAIR CONNECTED':'WAITING FOR PARTNER';
  if(!oldRoom || JSON.stringify(oldRoom.path)!==JSON.stringify(room.path) || JSON.stringify(oldRoom.steer)!==JSON.stringify(room.steer))paint();
  updateRoleUI();updateStrokeUI();
  if(ready){if(room.phase==='review')showReview();else updateStudioState();tryStartCall().catch(safeError);}
  const both=room.filming_ok_a&&room.filming_ok_b;
  $('recordConsent').textContent=both?'RECORDING: BOTH CONSENTED':'RECORDING: NOT APPROVED BY BOTH';
  $('recordBtn').disabled=!both||!ready;
  $('consentBtn').textContent=(role==='A'?room.filming_ok_a:room.filming_ok_b)?'WITHDRAW RECORDING CONSENT':'ALLOW RECORDING FOR THIS SESSION';
  if(!both&&mediaRecorder?.state==='recording')mediaRecorder.stop();
  $('submitBtn').disabled=!(room.word_a?.trim()&&room.word_b?.trim()&&allSculpted());
}
async function setupRoom(){
  show('welcome',false);show('roomScreen');$('roomShort').textContent=roomId.slice(0,8).toUpperCase();
  const {data,error}=await supabase.rpc('join_room',{p_room:roomId});if(error)throw error;
  role=data;$('roleTag').textContent=`PLAYER ${role}`;$('localRoleLabel').textContent=`PLAYER ${role}`;
  $('remoteRoleLabel').textContent=`PLAYER ${role==='A'?'B':'A'}`;
  channel=supabase.channel(`room-events-${roomId}`)
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'rooms',filter:`id=eq.${roomId}`},p=>applyRoom(p.new))
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'signals',filter:`room_id=eq.${roomId}`},p=>receiveSignal(p.new).catch(safeError))
    .on('broadcast',{event:'held-gesture'},({payload})=>receiveGesture(payload,payload?.sender))
    .subscribe(s=>setConnection(s==='SUBSCRIBED'?'LIVE':s));
  await getRoom();$('joinBtn').addEventListener('click',enterStudio);setupStageEvents();paint();
}
async function enterStudio(){
  $('joinBtn').disabled=true;
  try{await acquireInitialMedia();ready=true;show('lobby',false);show('studio');
    await patchRoom(role==='A'?{ready_a:true,filming_ok_a:$('filmingChoice').checked}:{ready_b:true,filming_ok_b:$('filmingChoice').checked});
    await getRoom();updateStudioState();await catchUpSignals();await tryStartCall();}
  catch(e){safeError(e);$('joinBtn').disabled=false;}
}
async function acquireInitialMedia() {
  const wantsVideo=$('cameraChoice').checked, wantsAudio=$('micChoice').checked;
  if(!wantsVideo && !wantsAudio){updateMediaUI();return;}
  try {
    localStream=await navigator.mediaDevices.getUserMedia({video:wantsVideo,audio:wantsAudio});
  } catch(e) {
    if(wantsVideo && wantsAudio){
      try {localStream=await navigator.mediaDevices.getUserMedia({video:false,audio:true});notify('Camera unavailable — joined audio-only.');}
      catch{notify('Camera/microphone unavailable. You can still make a shape.');}
    } else {notify('Permission declined — you can still create without audio/video.');}
  }
  if(localStream){$('localVideo').srcObject=localStream;$('localVideo').play().catch(()=>{});}
  updateMediaUI();
}
function updateMediaUI(){
  const cam=localStream?.getVideoTracks().some(t=>t.enabled && t.readyState==='live');
  const mic=localStream?.getAudioTracks().some(t=>t.enabled && t.readyState==='live');
  $('localFallback').style.display=cam?'none':'flex';
  $('toggleCam').textContent=cam?'CAMERA ON':'CAMERA OFF';
  $('toggleMic').textContent=mic?'MIC ON':'MIC OFF';
}
async function toggleTrack(kind) {
  try {
    const t=localStream?.getTracks().find(t=>t.kind===kind && t.readyState==='live');
    if(t){t.enabled=!t.enabled;updateMediaUI();return;}
    const s=await navigator.mediaDevices.getUserMedia({video:kind==='video',audio:kind==='audio'});
    const newTrack=s.getTracks()[0];
    if(!localStream)localStream=new MediaStream();
    localStream.addTrack(newTrack);$('localVideo').srcObject=localStream;
    const sender=pc?.getSenders().find(s=>s.track?.kind===kind)
      || pc?.getTransceivers().find(t=>t.receiver.track.kind===kind)?.sender;
    if(sender){
      await sender.replaceTrack(newTrack);
      const transceiver=pc?.getTransceivers().find(t=>t.sender===sender);
      if(transceiver?.direction==='recvonly'){
        transceiver.direction='sendrecv';
        notify('Camera/mic enabled locally. For your partner to see/hear it, please start a NEW room with this enabled before entering.');
      }
    }
    updateMediaUI();
  }catch(e){safeError(e);}
}

let pcInitPromise = null;
async function initPC() {
  if(pc) return pc;
  if(pcInitPromise) return pcInitPromise;
  pcInitPromise=(async()=>{
    const baseIceServers=[
      {urls:'stun:stun.l.google.com:19302'},
      {urls:'stun:stun1.l.google.com:19302'}
    ];
    const config=window.HELD_TURN_CONFIG || {};
    let iceServers=baseIceServers;
    if(config.credentialUrl){
      const abortController=new AbortController();
      const timeout=setTimeout(()=>abortController.abort(),9000);
      try{
        const response=await fetch(config.credentialUrl,{signal:abortController.signal,cache:'no-store'});
        if(!response.ok) throw new Error('TURN credential service HTTP '+response.status);
        const result=await response.json();
        const external=Array.isArray(result)?result:result?.iceServers;
        if(!Array.isArray(external) || !external.length) throw new Error('TURN credential service returned no ICE servers');
        const valid=external.filter(entry=>entry && entry.urls &&
          (Array.isArray(entry.urls) || typeof entry.urls==='string'));
        const relayCount=valid.filter(entry=>
          (Array.isArray(entry.urls)?entry.urls:[entry.urls]).some(url=>/^turns?:/i.test(url))).length;
        if(!relayCount) throw new Error('TURN credential service returned no relay addresses');
        iceServers=[...baseIceServers,...valid];
        window.HELD_TURN_STATUS='READY';
        console.info('[Held TURN] ready with',relayCount,'relay ICE entries');
      }catch(error){
        window.HELD_TURN_STATUS='ERROR: '+(error?.message||String(error));
        console.error('[Held TURN] unable to obtain credentials:',error);
        throw new Error('TURN setup failed: '+(error?.message||String(error)));
      }finally{clearTimeout(timeout);}
    }else{
      window.HELD_TURN_STATUS='NOT CONFIGURED — STUN ONLY';
      console.warn('[Held TURN] not configured; cross-network calls may fail');
    }
    pc=new RTCPeerConnection({
      iceServers,
      iceTransportPolicy:config.forceRelay===true && !!config.credentialUrl?'relay':'all'
    });
  // ONLY the offerer (A) creates the initial audio/video m-lines.
  // If the answerer (B) creates local transceivers before receiving the offer,
  // Safari/Chrome may leave B's sending transceivers unassociated with A's
  // offered m-lines. B then sees A, but A sees no remote video track.
  // B waits until setRemoteDescription(offer), then attaches local tracks to
  // the exact offered transceivers in attachAnswererTracks().
  if(role==='A'){
    for(const kind of ['audio','video']){
      const track=localStream?.getTracks().find(t=>t.kind===kind && t.readyState==='live');
      if(track)pc.addTransceiver(track,{direction:'sendrecv',streams:[localStream]});
      else pc.addTransceiver(kind,{direction:'recvonly'});
    }
  }
  remoteStream=new MediaStream();
  const partnerVideo=$('remoteVideo');
  partnerVideo.srcObject=remoteStream;
  const tryPlayRemote=()=>partnerVideo.play().catch(error=>{
    console.warn('Remote video playback blocked:',error);
    notify('Partner video is ready. Tap/click the partner tile to enable playback.');
  });
  partnerVideo.addEventListener('click',tryPlayRemote);
  pc.ontrack=event=>{
    console.info('[Held video] remote track',event.track.kind,event.track.readyState);
    if(!remoteStream.getTracks().some(t=>t.id===event.track.id))remoteStream.addTrack(event.track);
    if(event.track.kind==='video'){
      $('remoteFallback').style.display='none';
      if(pc?.connectionState==='connected') $('peerStatus').textContent='VIDEO CONNECTED';
      event.track.addEventListener('unmute',tryPlayRemote,{once:true});
      event.track.addEventListener('ended',()=>{$('remoteFallback').style.display='flex';});
    }
    tryPlayRemote();
  };
  pc.onicecandidate=event=>{if(event.candidate)sendSignal({type:'candidate',candidate:event.candidate.toJSON()}).catch(console.warn);};
  pc.onconnectionstatechange=()=>{
    const state=pc.connectionState;
    $('peerStatus').textContent=state==='connected'?(remoteStream?.getVideoTracks().length?'VIDEO CONNECTED':'PEER CONNECTED · WAITING FOR VIDEO'):`VIDEO: ${state.toUpperCase()}`;
    if(state==='failed')notify('Video network connection failed; try a different network or use a separate call. Shared drawing can still work.');
  };
  return pc;
  })();
  try {return await pcInitPromise;} finally {pcInitPromise=null;}
}
// After B accepts A's offer, bind B's actual media to the offered
// audio/video m-lines BEFORE creating the answer. This prevents the
// offerer-only missing-video failure seen in Mac+iPad role reversal tests.
async function attachAnswererTracks(){
  if(role!=='B' || !pc?.remoteDescription) return;
  // Important: when answering a remote offer, addTrack() associates the
  // camera/microphone with a compatible offered m-line. replaceTrack() alone
  // can leave the answer as a=recvonly, even though the local preview works.
  // See WebRTC/JSEP rules for addTrack reuse in have-remote-offer state.
  const localKinds=[];
  for(const kind of ['audio','video']){
    const track=localStream?.getTracks().find(t=>t.kind===kind && t.readyState==='live');
    const offered=pc.getTransceivers().find(t=>t.receiver?.track?.kind===kind && !t.stopped);
    if(track){
      const sender=pc.addTrack(track,localStream);
      const matched=pc.getTransceivers().find(t=>t.sender===sender);
      if(matched) matched.direction='sendrecv';
      localKinds.push(kind);
      console.info('[Held v3] B added track:',kind,'matched-offer:',matched===offered,'direction:',matched?.direction);
    }else if(offered){
      offered.direction='recvonly';
    }
  }
  console.info('[Held v3] B prepared media:',localKinds.join(', ')||'none',
    pc.getTransceivers().map(t=>({kind:t.receiver?.track?.kind,
      direction:t.direction,sending:t.sender?.track?.kind||null})));
}

// Check each media section separately; "connected" is not proof of two-way video.
function directionInSdp(sdp,kind){
  const section=sdp.split('m='+kind+' ')[1]?.split(/\r?\nm=/)[0];
  return section?.match(/(?:^|\r?\n)a=(sendrecv|sendonly|recvonly|inactive)(?:\r?\n|$)/)?.[1] || null;
}

async function sendSignal(message){
  const {error}=await supabase.from('signals').insert({room_id:roomId,sender:userId,message});
  if(error)throw error;
}
async function tryStartCall() {
  if(!ready || !room?.player_b || !room?.ready_a || !room?.ready_b || room.phase==='review')return;
  if(role!=='A' || offerMade)return;
  offerMade=true;
  try {
    await initPC();
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal({type:'offer',sdp:pc.localDescription.toJSON()});
  }catch(e){offerMade=false;throw e;}
}
async function receiveSignal(signal){
  if(!signal || signal.room_id!==roomId || handledSignals.has(signal.id))return;
  if(!ready)return; // Catch-up fetches all missed signals once the user enters.
  handledSignals.add(signal.id);
  const message=signal.message||{};
  if(message.type==='soft'){processSoftEvent(message,signal.sender);return;}
  if(message.type==='held-gesture'){receiveGesture(message.gesture,signal.sender);return;}
  if(message.type==='color'){applyColorSignal(message,signal.sender,signal.id);return;}
  if(signal.sender===userId)return;
  if(message.type==='offer' && role==='B'){
    await initPC();
    if(pc.signalingState!=='stable')return;
    await pc.setRemoteDescription(message.sdp);
    await attachAnswererTracks();
    await drainIce();
    const answer=await pc.createAnswer();
    const videoDir=directionInSdp(answer.sdp,'video');
    const localVideo=localStream?.getVideoTracks().find(t=>t.readyState==='live');
    console.info('[Held v3] B answer video direction:',videoDir,'local video:',!!localVideo);
    if(localVideo && !['sendrecv','sendonly'].includes(videoDir)){
      throw new Error(`The iPad/Mac camera is active, but video answer is ${videoDir||'missing'} instead of sending. Please screenshot the [Held v3] Console logs.`);
    }
    await pc.setLocalDescription(answer);
    await sendSignal({type:'answer',sdp:pc.localDescription.toJSON()});
  }else if(message.type==='answer' && role==='A'){
    await initPC();
    if(pc.signalingState!=='have-local-offer')return;
    await pc.setRemoteDescription(message.sdp);
    await drainIce();
  }else if(message.type==='candidate'){
    if(pc?.remoteDescription){try{await pc.addIceCandidate(message.candidate);}catch(e){console.warn('ICE:',e);}}
    else remoteIceQueue.push(message.candidate);
  }
}
async function drainIce(){
  if(!pc?.remoteDescription)return;
  for(const candidate of remoteIceQueue.splice(0)){
    try{await pc.addIceCandidate(candidate);}catch(e){console.warn(e);}
  }
}
async function catchUpSignals(){
  if(catchingSignals)return;
  catchingSignals=true;
  try {
    for(let offset=0;offset<4000;offset+=500){
      const {data,error}=await supabase.from('signals').select('*').eq('room_id',roomId)
        .order('id',{ascending:true}).range(offset,offset+499);
      if(error)throw error;
      for(const signal of (data||[]))await receiveSignal(signal);
      if(!data||data.length<500)break;
    }
  }finally{catchingSignals=false;}
}


// --- HELD v8 / 2D SOFT STROKES ------------------------------------------------
// All final geometry is a smooth, closed vector silhouette. No 3D conversion.
function centerline(stroke,t){
  if(stroke==='horizontal')return {x:250+500*t,y:350-5*Math.sin(Math.PI*t),r:76+9*Math.sin(Math.PI*t)};
  if(stroke==='vertical')return {x:500+6*Math.sin(Math.PI*t),y:175+350*t,r:72+8*Math.sin(Math.PI*t)};
  const a=(-56-248*t)*Math.PI/180;
  return {x:520+205*Math.cos(a),y:350+183*Math.sin(a),r:60+6*Math.sin(Math.PI*t)};
}
function rawOutline(stroke){
  const steps=48,c=[];
  for(let i=0;i<=steps;i++){
    const t=i/steps,p=centerline(stroke,t),pa=centerline(stroke,clamp(t-.002,0,1)),pb=centerline(stroke,clamp(t+.002,0,1));
    const dx=pb.x-pa.x,dy=pb.y-pa.y,m=Math.hypot(dx,dy)||1;
    c.push({...p,nx:-dy/m,ny:dx/m,tx:dx/m,ty:dy/m});
  }
  const points=[];
  c.forEach(p=>points.push({x:p.x+p.nx*p.r,y:p.y+p.ny*p.r}));
  const end=c.at(-1);
  for(let i=1;i<=12;i++){
    const a=Math.PI*i/13;
    points.push({x:end.x+end.nx*Math.cos(a)*end.r+end.tx*Math.sin(a)*end.r,
      y:end.y+end.ny*Math.cos(a)*end.r+end.ty*Math.sin(a)*end.r});
  }
  [...c].reverse().forEach(p=>points.push({x:p.x-p.nx*p.r,y:p.y-p.ny*p.r}));
  const start=c[0];
  for(let i=1;i<=12;i++){
    const a=Math.PI+Math.PI*i/13;
    points.push({x:start.x+start.nx*Math.cos(a)*start.r+start.tx*Math.sin(a)*start.r,
      y:start.y+start.ny*Math.cos(a)*start.r+start.ty*Math.sin(a)*start.r});
  }
  return points;
}
function outlinePoints(stroke,path=room?.path){
  const pts=rawOutline(stroke);
  for(const op of opsFor(stroke,path)){
    if((op.tool==='stretch'||op.tool==='squeeze')&&Array.isArray(op.pair)&&op.pair.length===2){
      const a={x:op.pair[0][0]*SIZE.w,y:op.pair[0][1]*SIZE.h};
      const b={x:op.pair[1][0]*SIZE.w,y:op.pair[1][1]*SIZE.h};
      const len=Math.max(1,Math.hypot(b.x-a.x,b.y-a.y));
      const ux=(b.x-a.x)/len,uy=(b.y-a.y)/len,vx=-uy,vy=ux;
      const cx=(a.x+b.x)/2,cy=(a.y+b.y)/2;
      const amount=clamp(+op.amount||0,-30,30);
      const factor=clamp(amount/Math.max(165,len)*1.65,-.25,.25);
      const reach=Math.max(200,len*.65);
      for(const p of pts){
        const rx=p.x-cx,ry=p.y-cy;
        const along=rx*ux+ry*uy,side=rx*vx+ry*vy;
        const influence=Math.exp(-.5*((along/reach)**2+(side/(reach*.72))**2));
        const parallel=along*factor*influence;
        const perpendicular=-side*factor*.88*influence;
        p.x=clamp(p.x+ux*parallel+vx*perpendicular,35,965);
        p.y=clamp(p.y+uy*parallel+vy*perpendicular,32,668);
      }
      continue;
    }
    const at={x:clamp(+op.at[0],0,1)*SIZE.w,y:clamp(+op.at[1],0,1)*SIZE.h};
    const dx=clamp(+op.delta[0],-.06,.06)*SIZE.w;
    const dy=clamp(+op.delta[1],-.06,.06)*SIZE.h;
    const radius=clamp(Number(op.radius)||.27,.13,.65)*420;
    // The hold point is frozen with EACH move. Moving the pin later must not
    // retroactively change strokes already sculpted.
    const anchor=op.hold;
    const ax=Array.isArray(anchor)?anchor[0]*SIZE.w:NaN;
    const ay=Array.isArray(anchor)?anchor[1]*SIZE.h:NaN;
    for(const p of pts){
      const d=Math.hypot(p.x-at.x,p.y-at.y);
      const influence=Math.exp(-.5*(d/radius)**2);
      const hold=Number.isFinite(ax)?(1-Math.exp(-.5*(Math.hypot(p.x-ax,p.y-ay)/75)**2)):1;
      p.x=clamp(p.x+dx*influence*hold,35,965);
      p.y=clamp(p.y+dy*influence*hold,32,668);
    }
  }
  return pts;
}
function smoothPath(pts){
  if(!pts.length)return '';
  const n=pts.length,f=v=>Number(v.toFixed(2));let d=`M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for(let i=0;i<n;i++){
    const p0=pts[(i+n-1)%n],p1=pts[i],p2=pts[(i+1)%n],p3=pts[(i+2)%n];
    d+=` C ${f(p1.x+(p2.x-p0.x)/6)} ${f(p1.y+(p2.y-p0.y)/6)} ${f(p2.x-(p3.x-p1.x)/6)} ${f(p2.y-(p3.y-p1.y)/6)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d+' Z';
}
function xmlEscape(v){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&apos;','"':'&quot;'}[c]));}
function anchorXY(){const a=room?.steer?.anchor;return Array.isArray(a)?{x:clamp(+a[0],0,1)*SIZE.w,y:clamp(+a[1],0,1)*SIZE.h}:null;}
function paint(){
  const stroke=currentStroke(),p=smoothPath(outlinePoints(stroke));
  const cursors=['A','B'].map(actor=>{
    const hand=pairHands[actor];if(!hand?.p||Date.now()-hand.seen>850||hand.mode==='none')return '';
    const color=actor==='A'?'#8f78c1':'#cb6999',r=hand.mode==='point'?10:16;
    return `<g pointer-events="none"><circle cx="${hand.p.x}" cy="${hand.p.y}" r="${r}" fill="none" stroke="${color}" stroke-width="4"/><text x="${hand.p.x+21}" y="${hand.p.y-12}" fill="${color}" font-size="21" font-weight="bold">${actor}</text></g>`;
  }).join('');
  $('strokeCanvas').innerHTML=`<path d="${p}" class="soft-stroke"/>${cursors}`;
  const review=smoothPath(outlinePoints(activeReview));
  $('reviewCanvas').innerHTML=`<path d="${review}" class="soft-stroke"/>`;
}
function coordOnSVG(e){
  const svg=$('strokeCanvas'),p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;
  const matrix=svg.getScreenCTM();if(!matrix)return null;
  const loc=p.matrixTransform(matrix.inverse());return{x:loc.x,y:loc.y};
}
function insidePoly(p,poly){let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){
  const a=poly[i],b=poly[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;
}return hit;}
function nearestOutline(p,stroke=currentStroke()){
  const points=outlinePoints(stroke);let min=Infinity,best=null;
  for(const pt of points){const d=Math.hypot(pt.x-p.x,pt.y-p.y);if(d<min){min=d;best=pt;}}
  return min<105 || insidePoly(p,points)?{...best,distance:min}:null;
}
// TWO REAL PEOPLE / ONE STROKE. No Holder, no Sculptor, no tool switch.
// Each device only emits ITS OWN hand. A is a commit coordinator, not a more
// powerful artist: A may persist an edit only after a fresh B gesture exists.
const pairHands={A:null,B:null};
let ownGesture={mode:'none',p:null,contact:false,session:null};
let ownSession=0,ownSeq=0,lastGestureSent=0,lastGestureStored=0;
let priorPair=null,lastJointAt=0,jointBusy=false;
const gesturePageId=`${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
function canEditTogether(){return !!(ready&&room?.player_a&&room?.player_b&&room.ready_a&&room.ready_b&&room.phase==='making');}
function gestureFresh(actor){const h=pairHands[actor];return h&&Date.now()-h.seen<850&&h.mode!=='none'&&h.contact;}
function receiveGesture(payload,sender){
  if(!payload||!room||!sender||sender===undefined)return;
  const actor=sender===room.player_a?'A':sender===room.player_b?'B':null;
  if(!actor||payload.actor!==actor||!Number.isInteger(payload.seq)||!payload.session)return;
  // Do not resurrect old hands from room history after they have left.
  if(Math.abs(Date.now()-Number(payload.sentAt))>3500)return;
  const previous=pairHands[actor];
  if(previous?.session===payload.session&&payload.seq<=previous.seq)return;
  if(previous?.sentAt>Number(payload.sentAt)+1000)return;
  pairHands[actor]={actor,mode:['pinch','point'].includes(payload.mode)?payload.mode:'none',
    contact:payload.contact===true,p:payload.p&&Number.isFinite(+payload.p[0])&&Number.isFinite(+payload.p[1])?
    {x:clamp(+payload.p[0],0,1000),y:clamp(+payload.p[1],0,700)}:null,
    session:payload.session,seq:payload.seq,seen:Date.now(),sentAt:Number(payload.sentAt)};
  paint();updatePairStatus();
  if(role==='A')maybeJointEdit();
}
function setOwnGesture(mode,p=null,contact=false){
  if(!role||!ready||!['pinch','point','none'].includes(mode))return;
  const old=ownGesture;
  const changed=old.mode!==mode||old.contact!==contact;
  if(changed)ownSession++;
  ownGesture={mode,p,contact:mode!=='none'&&!!contact,
    session:`${gesturePageId}:${ownSession}`};
  if(changed||(mode!=='none'&&(!old.p||Math.hypot(p.x-old.p.x,p.y-old.p.y)>=1.3)))sendOwnGesture(changed);
}
function sendOwnGesture(force=false){
  if(!ready||!role)return;
  const now=Date.now();
  if(!force&&now-lastGestureSent<125)return;
  lastGestureSent=now;
  const payload={actor:role,sender:userId,mode:ownGesture.mode,contact:ownGesture.contact,
    session:ownGesture.session||`${gesturePageId}:none`,seq:++ownSeq,sentAt:now,
    p:ownGesture.p?[+ownGesture.p.x.toFixed(2),+ownGesture.p.y.toFixed(2)]:null};
  receiveGesture(payload,userId);
  if(channel?.state==='joined')channel.send({type:'broadcast',event:'held-gesture',payload}).catch(()=>{});
  // Persist sparse state heartbeats through the ALREADY WORKING signals table,
  // so the interaction still works if Realtime Broadcast is unavailable.
  if(force||now-lastGestureStored>390){
    lastGestureStored=now;
    sendSignal({type:'held-gesture',gesture:payload}).catch(e=>{
      $('sculptFeedback').textContent='HAND SYNC ERROR: '+e.message;
      console.warn('[Held] hand sync',e);
    });
  }
}
function resetOwnGesture(){setOwnGesture('none',null,false);priorPair=null;}
function pairSignature(){const a=pairHands.A,b=pairHands.B;return a&&b?[a.session,a.mode,b.session,b.mode].join('|'):'';}
function updatePairStatus(){
  if(!ready||!room)return;
  const both=pairedMode(pairHands.A,pairHands.B,Date.now());
  const a=gestureFresh('A'),b=gestureFresh('B');
  let msg=!canEditTogether()?'WAITING FOR PARTNER':
    both?'TWO HANDS ACTIVE · '+(both==='both-pinch'?'PULL OR PUSH':'POKE'):
    a&&!b?'WAITING FOR B HAND':b&&!a?'WAITING FOR A HAND':'WAITING FOR BOTH HANDS';
  const el=$('collabStatus');if(el)el.textContent=msg;
  $('sculptFeedback').textContent=msg;
  $('tipText').textContent=both?'SCULPT TOGETHER':'BOTH HANDS REQUIRED';
}
function createJointOpFromMotion(plan){
  const op=plan.op;
  if(op.tool==='poke'){
    const point=nearestOutline(op.at);
    if(!point)return null;
    const center={x:500,y:350};
    const inward={x:center.x-point.x,y:center.y-point.y};
    const norm=Math.max(1,Math.hypot(inward.x,inward.y));
    const projected=(op.delta.x*inward.x+op.delta.y*inward.y)/norm;
    if(projected<2.8)return null; // only a real push INTO the boundary dents it
    const force=clamp(projected*.85,5,22);
    return {kind:'clay',stroke:currentStroke(),tool:'poke',
      at:[+(point.x/1000).toFixed(5),+(point.y/700).toFixed(5)],
      delta:[+(inward.x/norm*force/1000).toFixed(5),+(inward.y/norm*force/700).toFixed(5)],
      hold:null,radius:.145};
  }
  const a=op.pair[0],b=op.pair[1];
  return {kind:'clay',stroke:currentStroke(),tool:op.tool,
    pair:[[+(a.x/1000).toFixed(5),+(a.y/700).toFixed(5)],
          [+(b.x/1000).toFixed(5),+(b.y/700).toFixed(5)]],
    amount:+op.amount.toFixed(3),at:[.5,.5],delta:[0,0],radius:.3};
}
async function maybeJointEdit(){
  if(role!=='A'||jointBusy||!canEditTogether())return;
  const a=pairHands.A,b=pairHands.B,now=Date.now();
  if(!pairedMode(a,b,now)){priorPair=null;updatePairStatus();return;}
  const plan=actionFromPair(a,b,priorPair,now);
  if(plan.current&&!plan.op){priorPair=plan.current;return;}
  if(!plan.op||now-lastJointAt<135||opsFor(currentStroke()).length>=170)return;
  const jointOp=createJointOpFromMotion(plan);
  if(!jointOp){priorPair=plan.current;return;}
  // Recheck at the data-modification boundary. A alone NEVER reaches this call.
  if(!pairedMode(pairHands.A,pairHands.B,Date.now())){priorPair=null;return;}
  jointBusy=true;lastJointAt=now;
  const proof={A:{session:a.session,seq:a.seq},B:{session:b.session,seq:b.seq}};
  try{
    await sendSoft({k:'joint-op',op:jointOp,proof});
    priorPair=plan.current;
    $('sculptFeedback').textContent=plan.status.toUpperCase()+' ✓';
  }catch(e){console.warn('[Held] joint edit failed',e);$('sculptFeedback').textContent='SYNC FAILED · '+e.message;}
  finally{jointBusy=false;}
}
function updateRoleUI(){
  if(!room||!role)return;
  $('roleTag').textContent=`PLAYER ${role} · SAME TOOLS`;
  $('toolTitle').textContent='TWO HANDS';
  $('toolDesc').textContent='Both people must touch the same stroke.';
  show('holderControls',false);show('sculptControls',false);
  $('myRoleStatus').textContent=`YOU: PLAYER ${role}`;
  $('swapRolesBtn').disabled=true;
  $('swapState').textContent='No roles. Both can grab or poke.';
  updatePairStatus();
}
function updateStrokeUI(){
  if(!room)return;
  const stroke=currentStroke(),idx=STROKES.indexOf(stroke);
  $('strokeIndex').textContent=`STROKE ${idx+1} / 3`;$('strokeTitle').textContent=NAMES[stroke];
  $('pointCount').textContent=`${opsFor(stroke).length} MOVES`;
  STROKES.forEach(s=>{
    const chip=$('strokeChip_'+s),n=opsFor(s).length;
    chip.classList.toggle('selected',s===stroke);chip.classList.toggle('sculpted',n>0);
    chip.querySelector('small').textContent=n?`${n} edits ✓`:'ready';
    $('reviewTab_'+s).classList.toggle('selected',s===activeReview);
  });
  $('prevStrokeBtn').disabled=role!=='A'||idx===0||room.phase!=='making'||switchingStroke;
  $('nextStrokeBtn').disabled=role!=='A'||idx===2||room.phase!=='making'||switchingStroke;
  $('strokeStatus').textContent=role==='A'?'':'A changes strokes';
  paint();
}
function updateStudioState(){
  if(!ready||!room)return;
  const both=!!(room.player_b&&room.ready_a&&room.ready_b);
  $('finishBtn').disabled=!allSculpted()||!both||!(role==='A'||room.phase==='finish_requested');
  $('finishBtn').textContent=role==='A'?(room.phase==='finish_requested'?'CANCEL FINISH REQUEST':'REQUEST TO FINISH ↗'):
    (room.phase==='finish_requested'?'CONFIRM FINISH ↗':'WAIT FOR A TO FINISH');
  $('stagePhase').textContent='02 / SCULPT';updateRoleUI();
}
async function changeStroke(delta){
  if(role!=='A'||!room||room.phase!=='making'||switchingStroke||jointBusy)return;
  const from=currentStroke(),i=STROKES.indexOf(from),next=STROKES[i+delta];if(!next)return;
  if(delta>0&&!opsFor(from).length){notify('Both people must sculpt this stroke before continuing.');return;}
  switchingStroke=true;priorPair=null;
  try{await sendSoft({k:'stage',stroke:next});}
  catch(e){safeError(e);}finally{switchingStroke=false;updateStrokeUI();}
}
function setupStageEvents(){
  const svg=$('strokeCanvas');svg.style.touchAction='none';
  const activePoint=()=>{const list=[...pointerStates.values()];return list.at(-1)||null;};
  function refreshPointer(e){
    if(handMode||!pointerStates.size)return;
    const item=activePoint();if(!item)return;
    const mode=pointerStates.size>1||(e?.shiftKey&&e?.pointerType==='mouse')?'point':'pinch';
    setOwnGesture(mode,item.p,item.contact);
  }
  svg.addEventListener('pointerdown',e=>{
    if(handMode||!ready||room?.phase!=='making'||(e.pointerType==='mouse'&&e.button!==0))return;
    const p=coordOnSVG(e);if(!p)return;
    const contact=!!nearestOutline(p);
    if(!contact && pointerStates.size===0)return;
    e.preventDefault();try{svg.setPointerCapture(e.pointerId);}catch{}
    pointerStates.set(e.pointerId,{p,contact:pointerStates.size?true:contact});
    refreshPointer(e);
  });
  svg.addEventListener('pointermove',e=>{
    if(handMode||!pointerStates.has(e.pointerId))return;
    const p=coordOnSVG(e);if(!p)return;
    pointerStates.get(e.pointerId).p=p;
    refreshPointer(e);
  });
  function release(e){if(!pointerStates.has(e.pointerId))return;pointerStates.delete(e.pointerId);
    if(!pointerStates.size)resetOwnGesture();else refreshPointer(e);}
  svg.addEventListener('pointerup',release);svg.addEventListener('pointercancel',release);
  window.addEventListener('blur',()=>{pointerStates.clear();resetOwnGesture();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){pointerStates.clear();resetOwnGesture();}});
  setInterval(()=>{
    if(!ready||!role)return;
    if(handMode&&(!localStream?.getVideoTracks().some(t=>t.enabled&&t.readyState==='live')||Date.now()-lastCameraDetection>550))
      resetOwnGesture();
    if(ownGesture.mode!=='none')sendOwnGesture();
    if(role==='A')maybeJointEdit();
    updatePairStatus();
  },145);
}

// --- 21-point hand skeleton and optional gesture control (camera is local) ---
const HAND_LINKS=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
let handOverlay=null,handTag=null;
function ensureHandOverlay(){
  if(handOverlay)return;
  const tile=$('localVideo').closest('.video-tile');
  handOverlay=document.createElement('canvas');handOverlay.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2';
  handTag=document.createElement('span');handTag.style.cssText='position:absolute;left:8px;top:8px;background:#302636d9;color:white;padding:4px 7px;font:700 10px sans-serif;z-index:3';
  tile.append(handOverlay,handTag);
}
function handDist(h,i,j){return Math.hypot(h[i].x-h[j].x,h[i].y-h[j].y);}
function handPinch(h,was=false){return handDist(h,4,8)/Math.max(handDist(h,0,9),.001)<(was?.72:.54);}
function handPokePose(h){const palm=handDist(h,0,9)||.1;return handDist(h,8,5)>palm*.64&&handDist(h,12,9)<palm*.85&&handDist(h,16,13)<palm*.85;}
function handPoint(h){return {x:clamp((1-h[8].x)*1000,0,1000),y:clamp(h[8].y*700,0,700)};}
function renderHandOverlay(items){
  if(!handOverlay)return;
  const tile=handOverlay.parentElement,v=$('localVideo'),W=tile.clientWidth,H=tile.clientHeight;
  const dpr=Math.min(devicePixelRatio||1,2);
  handOverlay.width=Math.max(1,W*dpr);handOverlay.height=Math.max(1,H*dpr);
  const ctx=handOverlay.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,W,H);
  if(!v.videoWidth)return;
  const scale=Math.max(W/v.videoWidth,H/v.videoHeight),ox=(W-v.videoWidth*scale)/2,oy=(H-v.videoHeight*scale)/2;
  const pixel=p=>({x:W-(ox+p.x*v.videoWidth*scale),y:oy+p.y*v.videoHeight*scale});
  items.forEach(({hand,active},i)=>{
    const pts=hand.map(pixel);ctx.strokeStyle=i?'#acbdf4':'#eab1d0';ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=active?3:2;
    for(const[a,b]of HAND_LINKS){ctx.beginPath();ctx.moveTo(pts[a].x,pts[a].y);ctx.lineTo(pts[b].x,pts[b].y);ctx.stroke();}
    pts.forEach((p,j)=>{ctx.beginPath();ctx.arc(p.x,p.y,j===8||j===4?3.6:2.1,0,Math.PI*2);ctx.fill();});
  });
  handTag.textContent='PINCH TO GRAB · POINT TO POKE';
}
// iPad-safe hand startup: report which asset is loading, cap waits, and
// never leave the UI stuck at LOADING HANDS if a CDN or model request stalls.
let handLoading=false, handLoadEpoch=0;
function setHandStatus(message,error=false){
  const node=$('handLoadStatus');
  if(!node)return;
  node.textContent=message||'';
  node.classList.toggle('hidden',!message);
  node.classList.toggle('hand-load-error',!!error);
}
function handTimeout(promise,ms,label){
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out ('+Math.round(ms/1000)+'s). Check iPad Wi-Fi / Safari, then retry.')),ms);})
  ]).finally(()=>clearTimeout(timer));
}
async function waitForHandVideo(video,ms){
  const started=Date.now();
  while(Date.now()-started<ms){
    if(video.readyState>=2&&video.videoWidth>0&&video.videoHeight>0)return;
    await new Promise(resolve=>setTimeout(resolve,180));
  }
  throw new Error('Camera video has no frames. Check iPad camera permission, then turn CAMERA OFF / ON and retry.');
}
async function toggleHandMode(){
  const button=$('handModeBtn');
  // A second tap cancels a hanging load while touch still works.
  if(handLoading){
    handLoadEpoch++;handLoading=false;
    button.textContent='HAND MODE OFF';
    setHandStatus('Hand loading cancelled. Touch is still available.');
    return;
  }
  if(handMode){
    handLoadEpoch++;handMode=false;handHistory.clear();resetOwnGesture();
    button.textContent='HAND MODE OFF';
    if(handOverlay)handOverlay.getContext('2d').clearRect(0,0,handOverlay.width,handOverlay.height);
    if(handTag)handTag.textContent='';
    setHandStatus('');
    return;
  }
  if(!localStream?.getVideoTracks().some(t=>t.enabled&&t.readyState==='live')){
    setHandStatus('Turn on your camera before Hand Mode.',true);
    notify('Camera ON is required for Hand Mode. Touch still works.');
    return;
  }
  const epoch=++handLoadEpoch;
  handLoading=true;
  button.textContent='CANCEL HAND LOAD';
  const video=$('localVideo');
  video.playsInline=true;video.muted=true;
  // Trigger playback in the same tap event on iPad, before any await.
  try{const attempt=video.play();if(attempt?.catch)attempt.catch(()=>{});}catch{}
  try{
    if(!handTracker){
      let loadError=null;
      const providers=[
        {name:'jsDelivr',bundle:'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs',wasm:'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'},
        {name:'UNPKG',bundle:'https://unpkg.com/@mediapipe/tasks-vision@0.10.21/vision_bundle.mjs',wasm:'https://unpkg.com/@mediapipe/tasks-vision@0.10.21/wasm'}
      ];
      for(const provider of providers){
        try{
          setHandStatus('Loading hand library · '+provider.name+'…');
          const {HandLandmarker,FilesetResolver}=await handTimeout(import(provider.bundle),16000,'Hand library');
          if(epoch!==handLoadEpoch)return;
          setHandStatus('Loading hand WASM · '+provider.name+'…');
          const files=await handTimeout(FilesetResolver.forVisionTasks(provider.wasm),22000,'Hand WASM');
          if(epoch!==handLoadEpoch)return;
          setHandStatus('Starting hand model · first use may be slower…');
          const task=HandLandmarker.createFromOptions(files,{
            baseOptions:{modelAssetPath:'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',delegate:'CPU'},
            runningMode:'VIDEO',numHands:1,
            minHandDetectionConfidence:.5,minHandPresenceConfidence:.5,minTrackingConfidence:.5
          });
          const tracker=await handTimeout(task,45000,'Hand model');
          if(epoch!==handLoadEpoch){try{tracker.close();}catch{}return;}
          handTracker=tracker;
          break;
        }catch(e){
          loadError=e;
          console.warn('[Held hand load] '+provider.name,e);
          if(epoch!==handLoadEpoch)return;
        }
      }
      if(!handTracker)throw new Error('Hand tracker could not start: '+(loadError?.message||'Unknown model/network error'));
    }
    if(epoch!==handLoadEpoch)return;
    setHandStatus('Checking camera frames…');
    await waitForHandVideo(video,9000);
    if(epoch!==handLoadEpoch)return;
    ensureHandOverlay();
    handMode=true;handHistory.clear();pointerStates.clear();resetOwnGesture();
    button.textContent='HAND MODE ON';
    setHandStatus('HAND ON · show one hand to camera');
    lastCameraDetection=Date.now();
    if(!handLoopRunning)handLoop();
  }catch(e){
    if(epoch!==handLoadEpoch)return;
    handMode=false;
    button.textContent='HAND MODE OFF';
    const message=e?.message||String(e);
    setHandStatus(message+' · Touch remains available.',true);
    console.error('[Held hand startup]',e);
    notify('Hand Mode failed: '+message);
  }finally{
    if(epoch===handLoadEpoch)handLoading=false;
  }
}
let lastCameraDetection=0,handContactSession='',handStatusTick=0;
function handLoop(){
  handLoopRunning=true;const video=$('localVideo');
  function tick(){
    if(!handMode){handLoopRunning=false;return;}
    const now=performance.now();
    if(video.readyState>=2&&video.videoWidth&&now-handLast>105){
      handLast=now;
      try{
        const result=handTracker.detectForVideo(video,now);
        lastCameraDetection=Date.now();
        const hands=(result.landmarks||[]).map((hand,i)=>({hand,key:String(result.handednesses?.[i]?.[0]?.categoryName||i)}));
        const draw=[],candidates=[],liveKeys=new Set();
        for(const {hand,key} of hands){
          liveKeys.add(key);const old=handHistory.get(key)||{};
          const pinch=handPinch(hand,old.pinch),point=!pinch&&handPokePose(hand);
          const mode=pinch?'pinch':point?'point':'none',p=handPoint(hand);
          // A held pinch stays attached through movement; a new grab starts only
          // when fingers genuinely touch the current silhouette.
          const contact=mode!=='none'&&(old.mode===mode?(old.contact||!!nearestOutline(p)):!!nearestOutline(p));
          draw.push({hand,active:mode!=='none'});
          if(mode!=='none')candidates.push({mode,p,contact,key,score:contact?2:1});
          handHistory.set(key,{pinch,mode,p,contact});
        }
        for(const key of handHistory.keys())if(!liveKeys.has(key))handHistory.delete(key);
        candidates.sort((a,b)=>b.score-a.score);
        if(candidates.length){const c=candidates[0];setOwnGesture(c.mode,c.p,c.contact);}
        else resetOwnGesture();
        renderHandOverlay(draw);
        if(now-handStatusTick>700){
          handStatusTick=now;
          setHandStatus('HAND ON · '+hands.length+' hand'+(hands.length===1?'':'s')+' detected'+(candidates[0]?' · '+candidates[0].mode.toUpperCase():' · show PINCH or POINT'));
        }
      }catch(e){
        console.warn('[Held] hand tracking',e);resetOwnGesture();
        setHandStatus('Hand detection error: '+(e?.message||String(e)),true);
        if(handTag)handTag.textContent='HAND TRACKING ERROR';
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// --- individual words + six individual FIMO color selections ------------------
function updateColorUI(){
  if(!role)return;
  const colors=paletteChoices[role]||{};
  STROKES.forEach(s=>{
    const el=$('colorDot_'+s);if(el)el.style.background=colors[s]||'transparent';
  });
  $('paletteFor').textContent=`PLAYER ${role} · CHOOSE COLORS FOR ALL THREE STROKES`;
  const mine=colors[activeReview]||null;
  $('paletteCurrent').textContent=mine?`Selected: ${PALETTE.find(p=>p.hex===mine)?.name||mine}`:'Choose a color for this stroke';
  $('paletteGrid').innerHTML=PALETTE.map(s=>`<button type="button" class="color-choice ${mine===s.hex?'picked':''}" style="--swatch:${s.hex}" data-palette="${xmlEscape(s.id)}" aria-label="${xmlEscape(s.name)}" title="${xmlEscape(s.name)}"><span></span><small>${xmlEscape(s.name)}</small></button>`).join('');
  $('paletteGrid').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>saveColor(b.dataset.palette)));
  const mineCount=STROKES.filter(s=>paletteChoices[role]?.[s]).length;
  const other=role==='A'?'B':'A',otherCount=STROKES.filter(s=>paletteChoices[other]?.[s]).length;
  $('paletteProgress').textContent=`YOUR COLORS ${mineCount}/3 · PARTNER COLORS ${otherCount}/3`;
}
function applyColorSignal(message,sender,id){
  if(message.type!=='color'||!STROKES.includes(message.stroke)||!PALETTE.some(x=>x.hex===message.hex))return;
  const side=room?.player_a===sender?'A':room?.player_b===sender?'B':null;if(!side)return;
  const n=Number(id)||Number(message.ts)||0;
  if(n<(paletteVersions[side][message.stroke]||0))return;
  paletteVersions[side][message.stroke]=n;paletteChoices[side][message.stroke]=message.hex;
  updateColorUI();
}
async function saveColor(id){
  const swatch=PALETTE.find(x=>x.id===id);if(!swatch||!ready)return;
  try{
    await sendSignal({type:'color',stroke:activeReview,hex:swatch.hex,ts:Date.now()});
    // Local choice is immediately visible; remote receives it from signal stream.
    paletteChoices[role][activeReview]=swatch.hex;updateColorUI();notify(`Saved ${swatch.name} for your ${activeReview} stroke.`);
  }catch(e){safeError(e);}
}
async function requestFinish(){
  if(!allSculpted()){notify('Shape all three strokes before finishing.');return;}
  try{
    if(role==='A')await patchRoom({phase:room.phase==='finish_requested'?'making':'finish_requested'});
    else if(room.phase==='finish_requested')await patchRoom({phase:'review'});
    await getRoom();
  }catch(e){safeError(e);}
}
function showReview(){
  show('studio',false);show('review');pointerStates.clear();resetOwnGesture();
  const v=role==='A'?room.word_a:room.word_b;
  if(v&&document.activeElement!==$('secretWord'))$('secretWord').value=v;
  paint();updateStrokeUI();updateColorUI();
}
function selectReviewStroke(stroke){if(!STROKES.includes(stroke))return;activeReview=stroke;paint();updateStrokeUI();updateColorUI();}
async function saveWord(){
  const word=$('secretWord').value.trim();if(!word){notify('Enter your word before saving.');return;}
  try{await patchRoom(role==='A'?{word_a:word}:{word_b:word});await getRoom();notify('Your word saved. Your partner may choose a different word.');}
  catch(e){safeError(e);}
}
function vectorSVG(stroke,hex='#FFFFFF',border=true){
  const d=smoothPath(outlinePoints(stroke)),line=border?'stroke="#d4ccd1" stroke-width="2"':'stroke="none"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700" viewBox="0 0 1000 700"><path d="${d}" fill="${hex}" ${line} stroke-linejoin="round"/></svg>`;
}
function pngFor(stroke,color='#FFFFFF'){
  const canvas=document.createElement('canvas');canvas.width=1400;canvas.height=980;
  const ctx=canvas.getContext('2d');if(!ctx)throw Error('Canvas 2D not supported');ctx.scale(1.4,1.4);
  ctx.fillStyle=color;ctx.strokeStyle='#d4ccd1';ctx.lineWidth=2;ctx.lineJoin='round';
  const p=new Path2D(smoothPath(outlinePoints(stroke)));ctx.fill(p);ctx.stroke(p);
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('PNG rendering failed')),'image/png'));
}
function wordsAndColors(){
  return ['HELD — SOFT STROKES / TWO INDEPENDENT WORDS','==========================================','',
    `Room: ${roomId}`,`Saved: ${new Date().toISOString()}`,'',
    'WORDS',`Player A: ${String(room?.word_a||'').replace(/[\r\n\t]/g,' ')}`,`Player B: ${String(room?.word_b||'').replace(/[\r\n\t]/g,' ')}`,'',
    'SELECTED FIMO COLORS (TEMPORARY PALETTE — CONFIRM PHYSICAL CLAY)',
    ...['A','B'].flatMap(side=>['Player '+side,...STROKES.map(s=>`  ${s}: ${paletteChoices[side]?.[s]||'NOT SELECTED'} (${PALETTE.find(c=>c.hex===paletteChoices[side]?.[s])?.name||'-'})`)]),
    '','THREE ORIGINAL 2D OUTLINES','',...STROKES.map(s=>`${s}: ${opsFor(s).length} edits`),'',
    'ARTIST NOTES','The participants shaped only three shared base strokes.',
    'They each chose their own word and three stroke colors.',
    'The artist makes the typography manually: mirror / rotate / overlap the strokes.',
    'Vector SVGs are 2D. For 3D printing, extrude and prepare solid meshes separately.',
    'Colors are hex suggestions sampled from a provisional palette, not physical FIMO recipes.',''].join('\n');
}
function sessionJSON(){
  return JSON.stringify({app:'Held 2D Soft Strokes v10 / two-person only',roomId,created:room?.created_at,exported:new Date().toISOString(),
    words:{A:room?.word_a,B:room?.word_b},palette:PALETTE,selections:paletteChoices,
    anchor:room?.steer?.anchor||null,strokes:STROKES.map(s=>({name:s,ops:opsFor(s),svgPath:smoothPath(outlinePoints(s))}))},null,2);
}
function blobDownload(blob,filename){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),7000);}
async function exportFiles(){
  const files=[];
  for(const stroke of STROKES){
    files.push([`${stroke}-outline.svg`,new Blob([vectorSVG(stroke)],{type:'image/svg+xml'})]);
    files.push([`${stroke}-transparent.png`,await pngFor(stroke)]);
    for(const side of ['A','B']){
      const hex=paletteChoices[side][stroke];
      if(hex)files.push([`${stroke}-player-${side}-color.svg`,new Blob([vectorSVG(stroke,hex,false)],{type:'image/svg+xml'})]);
    }
  }
  files.push(['held-words-and-colors.txt',new Blob([wordsAndColors()],{type:'text/plain'})]);
  files.push(['held-session.json',new Blob([sessionJSON()],{type:'application/json'})]);
  files.push(['README-TO-ARTIST.txt',new Blob([['HELD 2D STROKE ARCHIVE','These are raw 2D typographic components. Not finished letters.',
    'Open the three *-outline.svg files in Illustrator. Duplicate, mirror, rotate and overlap them to create the letters in each participant\'s word.',
    'Use selected colors as your palette. To make jewelry, extrude cleaned joined shapes in Blender, or use the 2D outlines as hand-sculpting references.',
    'No STL files exist at this stage. SVGs are not printable 3D solids.'].join('\n')],{type:'text/plain'})]);
  return files;
}
async function downloadFiles(){
  try{$('uploadStatus').textContent='PREPARING VECTOR FILES…';const files=await exportFiles(),zip=new JSZip();
    for(const [name,b]of files)zip.file(name,b);
    blobDownload(await zip.generateAsync({type:'blob'}),`held-soft-strokes-${roomId.slice(0,8)}.zip`);
    $('uploadStatus').textContent='DOWNLOADED TO THIS DEVICE. Supabase is separate — click SUBMIT to upload.';
  }catch(e){safeError(e);}
}
async function submitFiles(){
  if(!allSculpted()||!room.word_a?.trim()||!room.word_b?.trim()){
    notify('Complete all three strokes and save both individual words first.');return;
  }
  if(!['A','B'].every(side=>STROKES.every(s=>paletteChoices[side]?.[s]))){
    notify('Both players need to choose a color for each of the three strokes.');return;
  }
  $('submitBtn').disabled=true;
  try{
    const files=await exportFiles(),folder=`${roomId}/${userId}/${Date.now()}`;
    for(let i=0;i<files.length;i++){
      const [name,blob]=files[i];$('uploadStatus').textContent=`UPLOADING ${i+1}/${files.length}: ${name}`;
      const {error}=await supabase.storage.from('submissions').upload(`${folder}/${name}`,blob,{contentType:blob.type,upsert:false});
      if(error)throw Error(`${name}: ${error.message}`);
    }
    $('uploadStatus').textContent=`SUBMITTED ✓ ${files.length} files · Supabase Storage / submissions / ${folder}`;
    notify('Your three 2D strokes, both words and six color choices were submitted!');
  }catch(e){$('uploadStatus').textContent=`UPLOAD FAILED: ${e.message}. Files already uploaded may remain in Storage.`;safeError(e);}
  finally{$('submitBtn').disabled=false;}
}

async function toggleRecording(){
  if(mediaRecorder?.state==='recording'){mediaRecorder.stop();$('recordBtn').textContent='START SCREEN RECORDING';return;}
  if(!(room?.filming_ok_a&&room?.filming_ok_b)){notify('Both people must consent before recording.');return;}
  try{
    recordingStream=await navigator.mediaDevices.getDisplayMedia({video:{displaySurface:'browser'},audio:true});
    const preferred=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm']
      .find(t=>MediaRecorder.isTypeSupported(t));
    mediaRecorder=new MediaRecorder(recordingStream,preferred?{mimeType:preferred}:undefined);
    recordChunks=[];
    mediaRecorder.ondataavailable=e=>{if(e.data.size)recordChunks.push(e.data);};
    mediaRecorder.onstop=()=>{
      const blob=new Blob(recordChunks,{type:mediaRecorder.mimeType||'video/webm'});
      if(blob.size)blobDownload(blob,`together-type-session-${roomId.slice(0,8)}.webm`);
      recordingStream?.getTracks().forEach(t=>t.stop());
      $('recordBtn').textContent='START SCREEN RECORDING';
      notify('Recording saved locally. It was not uploaded.');
    };
    recordingStream.getVideoTracks()[0].addEventListener('ended',()=>{if(mediaRecorder?.state==='recording')mediaRecorder.stop();});
    mediaRecorder.start(1000);$('recordBtn').textContent='STOP + SAVE RECORDING';
    notify('Choose THIS TAB in the screen share popup. Tab audio support depends on browser.');
  }catch(e){safeError(e);}
}



$('createBtn').addEventListener('click',createRoom);
$('copyLinkBtn').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(location.href);notify('Invite link copied.');}catch{notify(location.href);}});
$('toggleCam').addEventListener('click',()=>toggleTrack('video'));
$('toggleMic').addEventListener('click',()=>toggleTrack('audio'));
$('handModeBtn').addEventListener('click',toggleHandMode);
$('recordBtn').addEventListener('click',toggleRecording);
$('consentBtn').addEventListener('click',async()=>{try{const key=role==='A'?'filming_ok_a':'filming_ok_b';await patchRoom({[key]:!room[key]});await getRoom();}catch(e){safeError(e);}});
// No manual tool selectors or swap action: gesture pairs decide the edit.
$('prevStrokeBtn').addEventListener('click',()=>changeStroke(-1));
$('nextStrokeBtn').addEventListener('click',()=>changeStroke(1));
STROKES.forEach(s=>$('reviewTab_'+s).addEventListener('click',()=>selectReviewStroke(s)));
$('finishBtn').addEventListener('click',requestFinish);
$('saveWordBtn').addEventListener('click',saveWord);
$('submitBtn').addEventListener('click',submitFiles);
$('downloadBtn').addEventListener('click',downloadFiles);

setInterval(()=>{if(ready&&room?.player_b&&pc?.connectionState!=='connected')catchUpSignals().catch(console.warn);},5000);
(async()=>{
  if(!configured){$('setupError').textContent='Keep your existing config.js containing your Supabase project URL and public publishable key.';show('setupError');setConnection('NEEDS SETUP');return;}
  try{await login();setConnection('SIGNED IN');if(roomId)await setupRoom();else setConnection('READY');}
  catch(e){safeError(e);$('setupError').textContent=`Setup error: ${e.message}`;show('setupError');}
})();
