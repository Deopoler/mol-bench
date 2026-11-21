document.documentElement.classList.toggle("dark",matchMedia("(prefers-color-scheme: dark)").matches);
const grid=document.querySelector('#room-grid');const empty=document.querySelector('[data-bench="empty-state"]');
// L-R2: Korean/English. Original Korean text is captured once and restored for "ko"; English strings live here.
const EN_GROUPS=[['header nav a',['Rooms','About']],['#theme',['Theme']],['[data-bench="hero-title"]',['Welcome to the<br>Museum of Light']],['[data-bench="body"]',['Wander through a collection of rooms. Pick one that catches your eye and step inside for a new kind of experience.','An online museum that gathers light and ideas.']],['main h2',['Rooms','About']],['[data-bench="empty-state"]',['No rooms yet.']]];
const SUM_EN={'빛과 기억이 포개지는 작은 전시를 천천히 거닐어 보세요. 새로운 시선으로 익숙한 풍경을 만납니다.':'Stroll slowly through a small exhibition where light and memory overlap. See familiar scenery with fresh eyes.','조용한 관찰과 발견을 위한 공간입니다. 머무는 동안 각자의 이야기를 발견해 보세요.':'A space for quiet looking and discovery. While you stay, find a story of your own.'};
const titleKo=document.title;const base=new Map();const groups=EN_GROUPS.map(([sel,en])=>[[...document.querySelectorAll(sel)],en]);
for(const [els] of groups)for(const el of els)base.set(el,el.innerHTML);
const saved=(()=>{try{return localStorage.getItem('mol-lang')}catch{return null}})();
let lang=saved==='ko'||saved==='en'?saved:/^en\b/i.test(navigator.language||'')?'en':'ko';
const langBtn=document.createElement('button');langBtn.type='button';langBtn.id='lang';langBtn.dataset.bench='lang-toggle';document.querySelector('#theme').before(langBtn);
langBtn.onclick=()=>{lang=lang==='ko'?'en':'ko';try{localStorage.setItem('mol-lang',lang)}catch{}apply()};
function renderRooms(){const rooms=window.__benchHost?.params?.rooms??[];grid.replaceChildren();for(const [i,r] of rooms.entries()){const el=document.createElement(r.status==='coming_soon'?'article':'a');el.dataset.bench='room-card';el.className='room-card';if(r.status!=='coming_soon')el.href=r.route;el.innerHTML=`<div class="stage" aria-hidden="true"><div class="prism" style="--c:${(r.accent_oklch??[.68,.12,250]).join(' ')}">${'<i></i>'.repeat(6)}</div></div><small>ROOM ${i+1}</small><h3></h3><p></p>${r.status==='coming_soon'?'<b>Coming soon</b>':''}`;const en=lang==='en';el.querySelector('h3').textContent=en?r.title_en??r.title_ko:r.title_ko;el.querySelector('p').textContent=en?SUM_EN[r.summary_ko]??r.summary_ko:r.summary_ko;grid.append(el)}empty.hidden=rooms.length!==0}
// L-R4: CSS 3D prism per card. Pose is a pure function of the clock (host clock, or the seek time), never wall time.
const still=matchMedia('(prefers-reduced-motion: reduce)').matches;let seekT=null,gen=0;
const now=()=>seekT??(window.__benchHost?.clock?.now()??0);
function paint(t){grid.querySelectorAll('.prism').forEach((p,i)=>{p.style.transform=still?'rotateX(-18deg) rotateY(35deg)':`rotateX(${(-18+10*Math.sin(t/1400+i)).toFixed(2)}deg) rotateY(${((t/25+i*40)%360).toFixed(2)}deg)`})}
function tick(g){if(g!==gen)return;paint(now());requestAnimationFrame(()=>tick(g))}
function live(){gen++;seekT=null;if(still)paint(0);else tick(gen)}
function seek(t){gen++;seekT=t;paint(t)}
function apply(){document.documentElement.lang=lang;document.title=lang==='en'?'Museum of Light':titleKo;for(const [els,en] of groups)els.forEach((el,i)=>{el.innerHTML=lang==='en'?en[i]:base.get(el)});langBtn.textContent=lang==='en'?'한국어':'English';langBtn.lang=lang==='en'?'ko':'en';renderRooms()}
document.querySelector('#theme').onclick=()=>document.documentElement.classList.toggle('dark');const route=()=>location.hash.startsWith('#/room/')?location.hash.slice(7):'lobby';
apply();live();
window.__bench={version:1,ready:document.fonts.ready,setSeed(){renderRooms();paint(now())},seek,resume(){live()},async renderFrame(){paint(now());await new Promise(requestAnimationFrame)},state(){return{route:route(),lang,theme:document.documentElement.classList.contains('dark')?'dark':'light'}},stats(){return{drawCalls:0,triangles:0}}};
