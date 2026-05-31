// Word lists for human-looking prefixes. Kept in sync with the worker's
// generateAddressForOwner (worker/src/index.ts) so manual and auto-generated
// addresses share the same naming scheme.
const FIRST_NAMES = [
  "james","john","robert","michael","william","david","richard","joseph","thomas","charles",
  "mary","patricia","jennifer","linda","barbara","elizabeth","susan","jessica","sarah","karen",
  "alex","chris","jordan","taylor","morgan","casey","riley","jamie","avery","skyler",
  "emma","liam","noah","olivia","sophia","lucas","mason","ethan","ava","isabella",
  "jack","lily","ryan","grace","owen","zoe","evan","chloe","sean","maya",
];
const LAST_NAMES = [
  "smith","johnson","williams","brown","jones","garcia","miller","davis","rodriguez","martinez",
  "hernandez","lopez","gonzalez","wilson","anderson","thomas","taylor","moore","jackson","martin",
  "lee","perez","thompson","white","harris","sanchez","clark","ramirez","lewis","robinson",
  "walker","young","allen","king","wright","scott","torres","hill","flores","green",
  "adams","nelson","baker","hall","rivera","campbell","mitchell","carter","roberts","reed",
];
const ADJECTIVES = [
  "blue","happy","silent","brave","calm","clever","cosmic","golden","lucky","mellow",
  "noble","quick","rapid","shiny","swift","witty","bright","bold","crisp","fancy",
  "gentle","jolly","keen","lively","misty","proud","royal","sunny","vivid","zen",
];
const NOUNS = [
  "falcon","otter","tiger","river","maple","comet","willow","harbor","meadow","canyon",
  "ember","pixel","cobra","lynx","raven","badger","panda","koala","heron","marlin",
  "quartz","cedar","orchid","summit","breeze","lotus","onyx","drift","wren","fox",
];
// Excludes easily-confused chars: 0 o 1 l i
const SAFE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";

function randInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Reject the small modulo-bias tail for a clean uniform distribution.
  const limit = Math.floor(0xffffffff / max) * max;
  while (buf[0] >= limit) crypto.getRandomValues(buf);
  return buf[0] % max;
}

function pick<T>(arr: T[]): T {
  return arr[randInt(arr.length)];
}

// One separator, weighted toward "" so most addresses read as a solid word.
function randSep(): string {
  return pick(["", "", "", ".", "_"]);
}

// Generate a random email prefix (pure safe random chars)
export function generatePrefix(length = 10): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += SAFE_CHARS.charAt(randInt(SAFE_CHARS.length));
  }
  return result;
}

// Generate a human-looking prefix by picking one of several templates.
// Lowercase only — the worker lowercases addresses on insert.
export function generateNamePrefix(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const sep = randSep();
    let v: string;
    switch (randInt(4)) {
      case 0: // first.last + 2~3 digits
        v = `${pick(FIRST_NAMES)}${sep}${pick(LAST_NAMES)}${randInt(990) + 7}`;
        break;
      case 1: // firstlast + 2 digits (no separator)
        v = `${pick(FIRST_NAMES)}${pick(LAST_NAMES)}${randInt(90) + 10}`;
        break;
      case 2: // adjective + noun + 2 digits
        v = `${pick(ADJECTIVES)}${pick(NOUNS)}${randInt(90) + 10}`;
        break;
      default: // first + separator + 4 random chars
        v = `${pick(FIRST_NAMES)}${sep || "."}${generatePrefix(4)}`;
        break;
    }
    if (v.length >= 6 && v.length <= 20) return v;
  }
  // Fallback that always satisfies the length bound.
  return `${pick(FIRST_NAMES)}${randInt(990) + 7}`;
}

// Generate several prefix options for the quick-pick list
export function generatePrefixOptions(): { label: string; value: string }[] {
  const options: { label: string; value: string }[] = [];
  // 4 human-looking options (mixed templates)
  for (let i = 0; i < 4; i++) {
    const v = generateNamePrefix();
    options.push({ label: v, value: v });
  }
  // 1 pure random option
  const v = generatePrefix(10);
  options.push({ label: v, value: v });
  return options;
}

// Pick a random domain from the list
export function randomDomain(domains: string[]): string {
  return domains[Math.floor(Math.random() * domains.length)];
}

// Format date
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;

  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
