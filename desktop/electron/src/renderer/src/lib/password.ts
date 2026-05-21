// 密码生成与强度评估工具库
// ---------------------------------------------------------------------------
// 提供三类纯函数（无副作用、无状态、可单元测试）：
//
//   1. 密码生成
//        - generatePassword(opts)   随机字符密码（大小写/数字/符号自由组合）
//        - generatePassphrase(opts) 单词组合密码（EFF 风格）
//        - generatePin(length)      纯数字 PIN
//
//   2. 强度评估
//        - estimateEntropy(pw)      估算香农熵（bits）
//        - estimateStrength(pw)     0..100 直观打分
//        - strengthLabel(score)     "weak"/"fair"/"strong"/"excellent"
//        - estimateCrackTime(bits)  根据熵估算暴力破解时间（人类可读）
//
//   3. 工具
//        - secureRandomInt(max)     基于 crypto.getRandomValues 的整数随机
//        - shuffleString(s)         基于 Fisher–Yates 的字符串洗牌（无偏）
//
// ---------------------------------------------------------------------------
// 安全性说明
//
// 浏览器 / Wails WebView 都暴露了 `window.crypto.getRandomValues`，本模块
// **始终使用** 它作为随机源；Math.random 仅在不可用环境下作为 hard
// fallback（理论上桌面 WebView 不会触发）。这是密码生成器的底线 ——
// `Math.random()` 在 V8 中是 PRNG（xorshift128+），输出可预测，绝不能
// 用于安全敏感场景。
//
// 字符抽取使用"拒绝采样"（rejection sampling）方案，避免 `% poolSize` 带来
// 的模偏差。例如池大小 10 用 `Uint32 % 10` 时，2^32 不能被 10 整除，最末
// 几个数字会被略高概率选中（偏差 ≈ 2.3e-9）。对单字符这点偏差可忽略，
// 但在密码生成器这种"被反复审视加密强度"的场景，无偏才能让 entropy 估算
// 真正等于 log2(poolSize) * length，否则差一个 bit 都会被挑刺。
//
// 强度评估借鉴 zxcvbn 的"按字符集类别叠加 entropy"算法，但不引入 zxcvbn
// （200KB+，需要词典；此处仅做客户端粗略提示）。真实的密码强度评估发生
// 在后端：vault 的 KDF 已经把"被破解"成本顶到 Argon2id 64MB / 3 iter，
// 即便用户选了一个"弱"密码，配合慢 KDF 也能撑住数年的 GPU 攻击。这里
// 的强度条仅作 UX 引导，不是安全屏障。

// ---------------------------------------------------------------------------
// 字符集预设
// ---------------------------------------------------------------------------

/**
 * 完整大写字母集（含 I O 等可能与数字混淆的字符）
 *
 * 当 `avoidAmbiguous` 选项打开时，会从这里剔除 I L O。
 */
const POOL_UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const POOL_UPPER_UNAMB = "ABCDEFGHJKMNPQRSTUVWXYZ"; // 去掉 I L O

const POOL_LOWER = "abcdefghijklmnopqrstuvwxyz";
const POOL_LOWER_UNAMB = "abcdefghjkmnpqrstuvwxyz"; // 去掉 i l o

const POOL_NUMBER = "0123456789";
const POOL_NUMBER_UNAMB = "23456789"; // 去掉 0 1（与 O / l 形似）

/**
 * 符号集
 *
 * 选择标准：
 *   - 覆盖大多数网站允许的特殊字符（! @ # 等被广泛白名单）
 *   - 避开会被引号 / 转义机制误处理的字符（` ' " \ 等）
 *   - 避开空格（许多旧系统会自动 trim 导致用户困惑）
 *   - 避开 Unicode 高位字符（部分老旧后端只接受 ASCII）
 */
const POOL_SYMBOL = "!@#$%^&*()-_=+[]{};:,.<>/?";
const POOL_SYMBOL_UNAMB = "!@#$%^&*-_=+?"; // 去掉看起来像字母的 ()[]{},.<>/

// ---------------------------------------------------------------------------
// EFF 短词表（部分子集 —— 完整版有 7776 个词，此处取 256 个高频英语词，
// 长度 4-7 字母，覆盖日常场景；每词约 8 bits 熵，5 词 = ~40 bits，已经
// 比 12 字符随机密码更强）
//
// 选词原则：
//   - 长度 4..=7（短而易记）
//   - 全英语小写（避免大小写混淆 / 输入法切换烦扰）
//   - 无脏话、政治词、容易混淆的同形异词
//   - 无前缀重叠太多的词（避免输入到一半触发歧义补全）
// ---------------------------------------------------------------------------
const EFF_WORDS = [
	"able",
	"acid",
	"aged",
	"also",
	"area",
	"army",
	"atom",
	"back",
	"ball",
	"band",
	"bank",
	"base",
	"bath",
	"bean",
	"beat",
	"bell",
	"belt",
	"bend",
	"best",
	"bird",
	"bite",
	"blue",
	"boat",
	"body",
	"bold",
	"bone",
	"book",
	"boot",
	"born",
	"boss",
	"both",
	"bowl",
	"brake",
	"branch",
	"brave",
	"bread",
	"brick",
	"bring",
	"broad",
	"brown",
	"build",
	"burst",
	"buyer",
	"cable",
	"calm",
	"camp",
	"cannon",
	"canvas",
	"card",
	"care",
	"case",
	"cash",
	"cast",
	"cave",
	"cell",
	"chain",
	"chair",
	"chalk",
	"chart",
	"cheap",
	"check",
	"chest",
	"child",
	"claim",
	"class",
	"clean",
	"clear",
	"clerk",
	"click",
	"cliff",
	"climb",
	"cloak",
	"clock",
	"close",
	"cloth",
	"cloud",
	"clown",
	"coach",
	"coast",
	"coat",
	"code",
	"coin",
	"cold",
	"color",
	"comet",
	"cone",
	"coral",
	"core",
	"corn",
	"cost",
	"couch",
	"cover",
	"craft",
	"crane",
	"crash",
	"cream",
	"crisp",
	"crop",
	"cross",
	"crowd",
	"crown",
	"crust",
	"cube",
	"curve",
	"daily",
	"dance",
	"dare",
	"dark",
	"dash",
	"data",
	"dawn",
	"deal",
	"deep",
	"delta",
	"dense",
	"desk",
	"diet",
	"dime",
	"diner",
	"dirt",
	"dish",
	"dive",
	"dock",
	"dome",
	"door",
	"dose",
	"dove",
	"draft",
	"drag",
	"drama",
	"draw",
	"dream",
	"drift",
	"drink",
	"drive",
	"drop",
	"drum",
	"duck",
	"dull",
	"dust",
	"duty",
	"eager",
	"eagle",
	"early",
	"earth",
	"east",
	"easy",
	"echo",
	"edge",
	"elder",
	"elite",
	"ember",
	"empty",
	"enemy",
	"enter",
	"epic",
	"equal",
	"error",
	"essay",
	"even",
	"event",
	"every",
	"exact",
	"exit",
	"extra",
	"fable",
	"fade",
	"fair",
	"faith",
	"fake",
	"fall",
	"fame",
	"fan",
	"farm",
	"fast",
	"fault",
	"feast",
	"feel",
	"fence",
	"fern",
	"few",
	"field",
	"fifth",
	"fight",
	"file",
	"fill",
	"film",
	"final",
	"find",
	"fine",
	"fire",
	"firm",
	"first",
	"fish",
	"fit",
	"five",
	"flag",
	"flame",
	"flash",
	"flat",
	"flesh",
	"flex",
	"flint",
	"float",
	"flock",
	"flood",
	"floor",
	"flow",
	"fluid",
	"focus",
	"fold",
	"folk",
	"fond",
	"food",
	"fool",
	"foot",
	"force",
	"fork",
	"form",
	"fort",
	"found",
	"frame",
	"frank",
	"free",
	"fresh",
	"front",
	"frost",
	"fruit",
	"fuel",
	"full",
	"fund",
	"funny",
	"fur",
	"future",
	"gale",
	"game",
	"garden",
	"gate",
	"gaze",
	"gear",
	"gem",
	"ghost",
	"giant",
	"gift",
	"girl",
	"give",
	"glade",
	"glance",
	"globe",
	"glow",
	"gold",
	"good",
	"grace",
	"grade",
	"grain",
];

// ---------------------------------------------------------------------------
// 选项类型
// ---------------------------------------------------------------------------

export interface PasswordOptions {
	/** 长度（建议 8..=64） */
	length: number;
	/** 含小写 a-z */
	lower?: boolean;
	/** 含大写 A-Z */
	upper?: boolean;
	/** 含数字 0-9 */
	numbers?: boolean;
	/** 含符号 */
	symbols?: boolean;
	/** 避免歧义字符（I/l/1/0/O 等） */
	avoidAmbiguous?: boolean;
	/** 避免重复字符（每个字符最多出现一次；length 不能超过池大小） */
	avoidRepeats?: boolean;
}

export interface PassphraseOptions {
	/** 单词数（建议 3..=10） */
	words: number;
	/** 单词分隔符 */
	separator?: string;
	/** 首字母大写 */
	capitalize?: boolean;
	/** 在末尾追加一个 0..99 数字（增加熵） */
	includeNumber?: boolean;
}

// ---------------------------------------------------------------------------
// 安全随机源
// ---------------------------------------------------------------------------

/**
 * 返回 [0, max) 范围内的均匀随机整数
 *
 * 实现：拒绝采样（rejection sampling）
 *   1. 计算 `limit = floor(2^32 / max) * max`，作为"无偏接受窗口"的右界
 *   2. 反复从 Uint32 抽 v；只接受 v < limit 的样本
 *   3. 返回 v % max
 *
 * 因为 limit 是 max 的整数倍，所以 [0, limit) 内每个 max 段长度严格相等，
 * mod 后每个值出现概率精确为 1/max，无偏差。
 *
 * 期望迭代次数 < 2（limit/2^32 ≥ 1/2），实际几乎一次成功。
 *
 * fallback：crypto 不可用时退到 Math.random —— 仅为不可能触发的
 * 兜底，正常 Wails / 浏览器都不会走到这里。
 */
function secureRandomInt(max: number): number {
	if (max <= 0) throw new Error("secureRandomInt: max must be > 0");
	if (max === 1) return 0;

	const crypto = globalThis.crypto;
	if (!crypto?.getRandomValues) {
		// 极端 fallback —— 不应在生产路径触发
		return Math.floor(Math.random() * max);
	}

	const buf = new Uint32Array(1);
	const limit = Math.floor(0x1_0000_0000 / max) * max;

	// 拒绝采样
	// 理论上有微小概率连续采到 v >= limit；实际几乎一次成功
	// 上限循环数防御万一（不会发生但保险）
	for (let i = 0; i < 100; i++) {
		crypto.getRandomValues(buf);
		const v = buf[0];
		if (v < limit) return v % max;
	}
	// 兜底：直接 mod（极小偏差），永远不应到达
	crypto.getRandomValues(buf);
	return buf[0] % max;
}

/**
 * Fisher–Yates 洗牌，返回新字符串
 *
 * 用于 password 生成的最后一步：保证"必含每个池一个字符"的约束不会
 * 让结果的前几位永远来自固定池（fixed-position bias）。
 */
function shuffleString(s: string): string {
	const arr = Array.from(s);
	for (let i = arr.length - 1; i > 0; i--) {
		const j = secureRandomInt(i + 1);
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	return arr.join("");
}

/**
 * 从字符串池中随机抽取一个字符
 */
function pickFromPool(pool: string): string {
	if (pool.length === 0) throw new Error("pickFromPool: empty pool");
	return pool[secureRandomInt(pool.length)];
}

// ---------------------------------------------------------------------------
// 密码生成
// ---------------------------------------------------------------------------

/**
 * 生成随机字符密码
 *
 * 算法：
 *   1. 根据开关组合可用池
 *   2. 先从每个开启的池中各抽一个字符 —— 保证每类至少出现一次
 *   3. 剩余位从合并池抽
 *   4. 整体 Fisher-Yates 洗牌
 *
 * 边界：
 *   - 所有开关都关 → 退化为只用 lower
 *   - length < 启用池数 → length 提升到池数（否则没法保证"每类至少一个"）
 *   - avoidRepeats 且 length > poolSize → 抛错（不可满足）
 */
export function generatePassword(opts: PasswordOptions): string {
	const {
		length,
		lower = true,
		upper = true,
		numbers = true,
		symbols = false,
		avoidAmbiguous = false,
		avoidRepeats = false,
	} = opts;

	if (length < 1) return "";

	// 组装池数组
	const pools: string[] = [];
	if (lower) pools.push(avoidAmbiguous ? POOL_LOWER_UNAMB : POOL_LOWER);
	if (upper) pools.push(avoidAmbiguous ? POOL_UPPER_UNAMB : POOL_UPPER);
	if (numbers) pools.push(avoidAmbiguous ? POOL_NUMBER_UNAMB : POOL_NUMBER);
	if (symbols) pools.push(avoidAmbiguous ? POOL_SYMBOL_UNAMB : POOL_SYMBOL);

	// 全部关闭 → 退化为 lower（避免空池抛错让用户困惑）
	if (pools.length === 0) {
		pools.push(avoidAmbiguous ? POOL_LOWER_UNAMB : POOL_LOWER);
	}

	const merged = pools.join("");
	const targetLen = Math.max(length, pools.length);

	// avoidRepeats 不可满足时直接抛错
	if (avoidRepeats && targetLen > merged.length) {
		throw new Error(
			`Cannot generate ${targetLen} unique chars from pool of size ${merged.length}`,
		);
	}

	const chars: string[] = [];
	const used = new Set<string>();

	const tryPick = (pool: string): string | null => {
		if (!avoidRepeats) return pickFromPool(pool);
		// 在 avoidRepeats 模式下，从池中拒绝已用字符
		// 用最多 200 次重试避免极端情况下的死循环
		for (let i = 0; i < 200; i++) {
			const c = pickFromPool(pool);
			if (!used.has(c)) return c;
		}
		// 池里所有字符都已用过 → 上层应该早就检测到 length>poolSize 抛错了
		return null;
	};

	// 第一阶段：从每个池抽一个，保证多样性
	for (const pool of pools) {
		const c = tryPick(pool);
		if (c == null) break;
		chars.push(c);
		used.add(c);
	}

	// 第二阶段：从合并池抽剩余位
	while (chars.length < targetLen) {
		const c = tryPick(merged);
		if (c == null) break;
		chars.push(c);
		used.add(c);
	}

	// 洗牌：避免"前几位总是 lower/upper/number/symbol"的固定模式
	return shuffleString(chars.join(""));
}

/**
 * 生成 passphrase（EFF 风格短句密码）
 *
 * 例：`brave-ocean-forest-magnet-ladder` 或 `Brave-Ocean-Forest-42`
 *
 * 5 个词从 256 词池中独立抽取的熵 = 5 * log2(256) = 40 bits
 *   - 单字符 a-zA-Z0-9（62 池）需要 ~7 字符达到等熵 → 易输错
 *   - passphrase 易记且抗肩窥（更长 → 旁观者更难一眼记下）
 *
 * 完整 EFF 词表是 7776 词（log2 ≈ 12.92 bits/词），本实现简化到 256 词
 * 是为了不引入 ~80KB 词典；用户体验上 5 词依然提供 40 bits 熵，配合 KDF
 * 已远超暴力破解阈值。
 */
export function generatePassphrase(opts: PassphraseOptions): string {
	const {
		words,
		separator = "-",
		capitalize = false,
		includeNumber = false,
	} = opts;

	if (words < 1) return "";

	const parts: string[] = [];
	for (let i = 0; i < words; i++) {
		const w = EFF_WORDS[secureRandomInt(EFF_WORDS.length)];
		parts.push(capitalize ? w.charAt(0).toUpperCase() + w.slice(1) : w);
	}

	if (includeNumber) {
		// 0..99 增加约 6.6 bits 熵
		parts.push(String(secureRandomInt(100)).padStart(2, "0"));
	}

	return parts.join(separator);
}

/**
 * 生成数字 PIN
 *
 * 注意：4 位 PIN 仅 ~13 bits 熵，对暴力破解几乎无防御 —— 这种短码
 * 唯一的安全模型是"配合后端的尝试次数限制 / 锁定策略"。前端只生成、
 * 不评估强度（PIN 的强度评估会误导用户：永远显示"弱"，但这是 PIN
 * 的本质所致，不是用户能改变的）。
 */
export function generatePin(length: number): string {
	if (length < 1) return "";
	let out = "";
	for (let i = 0; i < length; i++) {
		out += String(secureRandomInt(10));
	}
	return out;
}

// ---------------------------------------------------------------------------
// 强度评估
// ---------------------------------------------------------------------------

/**
 * 估算密码的香农熵（bits）
 *
 * 算法：
 *   bits = length * log2(effective_pool_size)
 *
 * effective_pool_size 由实际出现的字符类别决定：
 *   - lower    +26
 *   - upper    +26
 *   - digits   +10
 *   - symbols  +33（按常用 ASCII 符号集合估）
 *
 * 这是上界估算 —— 实际熵在用户用字典词 / 简单 pattern 时远低于此。
 * zxcvbn 用马尔可夫链 + 字典命中估真实熵，但代价是 200KB+。我们仅做
 * "字符多样性 × 长度"粗算，已能区分 `abc123` (~30 bits) 和 `Tx9!q@2P` (~52 bits)。
 */
export function estimateEntropy(pw: string): number {
	if (!pw) return 0;
	let pool = 0;
	if (/[a-z]/.test(pw)) pool += 26;
	if (/[A-Z]/.test(pw)) pool += 26;
	if (/[0-9]/.test(pw)) pool += 10;
	// 任何非字母数字都按"符号"算
	if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
	if (pool === 0) return 0;
	return pw.length * Math.log2(pool);
}

/**
 * 估算密码强度，返回 0..100 分
 *
 * 算法（混合启发式）：
 *   1. 基础分 = entropy * 1.4（60 bits → ~84 分，对齐"强密码"心智）
 *   2. 长度奖励 / 惩罚：< 8 强制封顶 30；≥ 16 加 5 分
 *   3. 常见弱密码黑名单：直接砍到 ≤ 15 分
 *   4. 重复字符模式（aaaa / 1234）扣分
 *
 * 这套规则不追求与 zxcvbn 一致，只追求 UX 上的"直观对应"：
 *   - 0..39  弱（红）
 *   - 40..69 中（橙）
 *   - 70..84 强（绿）
 *   - 85..100 极强（深绿）
 */
export function estimateStrength(pw: string): number {
	if (!pw) return 0;

	const entropy = estimateEntropy(pw);
	let score = Math.min(100, entropy * 1.4);

	// 长度上限校验
	if (pw.length < 8) score = Math.min(score, 30);
	if (pw.length < 6) score = Math.min(score, 15);

	// 长度奖励
	if (pw.length >= 16) score += 5;
	if (pw.length >= 24) score += 3;

	// 常见弱密码黑名单
	const lower = pw.toLowerCase();
	const blacklist = [
		"password",
		"12345",
		"qwerty",
		"letmein",
		"admin",
		"welcome",
		"trustno1",
		"iloveyou",
		"abc123",
		"111111",
		"000000",
		"monkey",
		"dragon",
		"passw0rd",
		"p@ssw0rd",
	];
	for (const bad of blacklist) {
		if (lower.includes(bad)) {
			score = Math.min(score, 15);
			break;
		}
	}

	// 全相同字符 → 砍到极弱
	if (/^(.)\1+$/.test(pw)) score = Math.min(score, 5);

	// 简单递增 / 递减序列（abcdef / 654321）
	if (pw.length >= 4) {
		let asc = true;
		let desc = true;
		for (let i = 1; i < pw.length; i++) {
			if (pw.charCodeAt(i) !== pw.charCodeAt(i - 1) + 1) asc = false;
			if (pw.charCodeAt(i) !== pw.charCodeAt(i - 1) - 1) desc = false;
		}
		if (asc || desc) score = Math.min(score, 20);
	}

	// 高重复字符（同字符占比 > 50%）
	const counts = new Map<string, number>();
	for (const c of pw) counts.set(c, (counts.get(c) ?? 0) + 1);
	const maxCount = Math.max(...counts.values());
	if (maxCount / pw.length > 0.5) score *= 0.6;

	return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * 强度档位标签
 *
 * 返回值是 i18n key 后缀（"weak" / "fair" / "strong" / "excellent"），
 * 调用方拼成 `strength_${label}` 后用 t() 获取本地化文案。
 */
export type StrengthLabel = "weak" | "fair" | "strong" | "excellent";

export function strengthLabel(score: number): StrengthLabel {
	if (score < 40) return "weak";
	if (score < 70) return "fair";
	if (score < 85) return "strong";
	return "excellent";
}

/**
 * 估算暴力破解时间（人类可读字符串）
 *
 * 假设：
 *   - 攻击者每秒 10^11 次尝试（GPU 集群 + 无 KDF 保护的最坏情况）
 *   - 实际穿过 ZPass 的 Argon2id KDF 后，单次猜测成本 ~250ms，攻击者
 *     需要的时间 = 这里估算 × 2.5e10。所以这个数字仅是"裸密码哈希被
 *     拖库后离线攻击"的下限估算 —— 真实场景下还要乘 KDF 系数。
 *
 * 输出单位自适应：
 *   < 1s         → "instantly"
 *   < 1 min      → "Xs"
 *   < 1 hour     → "Xm"
 *   < 1 day      → "Xh"
 *   < 1 year     → "Xd"
 *   < 1000 yr    → "Xy"
 *   ≥ 1000 yr    → "10^X y"（科学计数法，避免天文数字溢出可读区间）
 */
export function estimateCrackTime(entropyBits: number): string {
	if (entropyBits <= 0) return "instantly";

	// 攻击者 10^11 hash/s（高估 GPU 集群裸算 SHA256 速度）
	const guessesPerSec = 1e11;
	const totalGuesses = 2 ** entropyBits;
	// 平均找到的猜测数 ≈ totalGuesses / 2
	const seconds = totalGuesses / 2 / guessesPerSec;

	if (seconds < 1) return "instantly";
	if (seconds < 60) return `${Math.round(seconds)}s`;

	const minutes = seconds / 60;
	if (minutes < 60) return `${Math.round(minutes)}m`;

	const hours = minutes / 60;
	if (hours < 24) return `${Math.round(hours)}h`;

	const days = hours / 24;
	if (days < 365) return `${Math.round(days)}d`;

	const years = days / 365;
	if (years < 1000) return `${Math.round(years)}y`;

	// 超过 1000 年用科学计数法
	const exp = Math.floor(Math.log10(years));
	const mant = (years / 10 ** exp).toFixed(1);
	return `${mant}×10^${exp} y`;
}

// ---------------------------------------------------------------------------
// 字符着色 —— Generator 显示密码时按字符类别染色，提升可读性
// ---------------------------------------------------------------------------

export type CharCategory = "lower" | "upper" | "number" | "symbol";

/**
 * 把单字符归类到 CharCategory
 *
 * 调用方：Generator 页面的密码显示组件，根据返回值取对应 CSS 变量
 * （--text-2 / --text / --info / --warn）画色。这是纯展示功能，
 * 与"安全"无关。
 */
export function categorize(ch: string): CharCategory {
	if (/[a-z]/.test(ch)) return "lower";
	if (/[A-Z]/.test(ch)) return "upper";
	if (/[0-9]/.test(ch)) return "number";
	return "symbol";
}

// ---------------------------------------------------------------------------
// 默认导出便利包
// ---------------------------------------------------------------------------

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
	length: 20,
	lower: true,
	upper: true,
	numbers: true,
	symbols: true,
	avoidAmbiguous: false,
	avoidRepeats: false,
};

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseOptions = {
	words: 5,
	separator: "-",
	capitalize: false,
	includeNumber: false,
};
