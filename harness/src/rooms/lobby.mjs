/** Public deterministic lobby data generator. Hidden grading data stays in hidden/lobby. */
export const room = "lobby";
const ko = ["고요한 빛의 정원","기억을 수집하는 방","작은 파도의 기록","시간의 표면을 걷다","낯선 행성의 식물도감","사라진 색을 찾아서","밤의 건축과 낮의 꿈","보이지 않는 선들의 지도","마지막 종이배를 띄우며","천천히 흐르는 푸른 세계","창문 너머의 오래된 별","바람이 머문 자리"];
const en = ["A Garden of Quiet Light","Rooms That Gather Memory","Notes from a Small Wave","Walking the Surface of Time","Field Guide to Alien Plants","In Search of a Vanished Color","Night Architecture, Daydreams","Atlas of Invisible Lines","Launch the Last Paper Boat","A World in Slow Blue","Old Stars Beyond the Window","Where the Wind Has Been"];
const summaries = ["빛과 기억이 포개지는 작은 전시를 천천히 거닐어 보세요. 새로운 시선으로 익숙한 풍경을 만납니다.","조용한 관찰과 발견을 위한 공간입니다. 머무는 동안 각자의 이야기를 발견해 보세요."];
export function generate(seed, { variant = "normal" } = {}) {
  let count = 8 + (seed % 5);
  if (variant === "empty_rooms") count = 0;
  if (variant === "one_room" || variant === "long_title" || variant === "lang_en" || variant === "lang_ko") count = 1;
  if (variant === "many_rooms") count = 24;
  const rooms = Array.from({length:count},(_,i)=>({id:`room-${i+1}`,route:`#/room/room-${i+1}`,title_ko:ko[(seed+i)%ko.length],title_en:en[(seed+i)%en.length],summary_ko:summaries[(seed+i)%2],accent_oklch:[0.68,0.12,((seed*39+i*31)%360)],status:"open"}));
  if (variant === "long_title" && rooms[0]) {
    rooms[0].title_ko = "빛의 기억이 머무는 아주 긴 복도에서 만나는 서른여덟 글자의 긴 이야기를 다시 천천히 읽어요";
    rooms[0].title_en = "A Quiet Museum of Light for Curious Visitors Everywhere Today";
  }
  if (variant === "coming_soon" && rooms[0]) rooms[0].status = "coming_soon";
  return { rooms };
}
export async function extraCapture() {}
export async function extraMetrics() {}
