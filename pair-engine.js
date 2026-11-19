// HELD: two distinct participants must both provide fresh, active hand states.
// Pure logic: independently testable and intentionally no single-user fallback.
export const GESTURE_TTL_MS = 850;
const MODES = new Set(['pinch','point']);

export function pairedMode(a,b,now,ttl=GESTURE_TTL_MS){
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

export function actionFromPair(a,b,prior,now){
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
