/**
 * parse.js —— 状态栏的数据层
 *
 * 只做纯数据变换：不碰 DOM、不碰 SillyTavern 运行时，
 * 因此可以在 Node 里单独跑单元测试。
 *
 * 两个入口：
 *   extractBlock() + looseParse() + normalizeData()  处理「模型输出」
 *   normalizeConfig()                                处理「导入的 JSON 配置」
 */

/** 状态块标记。只认这一种，避免误伤正文里的普通 JSON */
export const BLOCK_RE = /<status>([\s\S]*?)<\/status>/i;

/** 字段允许的类型 */
export const FIELD_TYPES = ['text', 'number', 'bar', 'tags'];

/** 配置文件的格式标识与版本 */
export const CONFIG_FORMAT = 'sillytavern.status-bar';
export const CONFIG_VERSION = 1;

/** 预览与示例用的默认值，按 key 猜一个像样的内容 */
export const SAMPLE_VALUES = {
    time: '傍晚',
    date: '十月十八日',
    weather: '阴，有风',
    location: '书房',
    mood: '疲惫但放松',
    relation: '信任',
    outfit: '深色衬衫',
};

/* ============================================================
   一、从模型正文中提取状态
   ============================================================ */

/**
 * 抠出状态块。
 *
 * @param {string} text
 * @returns {{ json: string, cleaned: string } | null}
 *   json    块内的原始文本
 *   cleaned 去掉区块后的正文
 */
export function extractBlock(text) {
    const source = String(text ?? '');
    const match = source.match(BLOCK_RE);

    if (!match) {
        return null;
    }

    const cleaned = source
        .replace(BLOCK_RE, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();

    return { json: match[1].trim(), cleaned };
}

/**
 * 宽松解析模型吐出来的 JSON。
 *
 * 中文模型常见的破坏：
 *   全角引号 “ ”、全角冒号逗号 ：，、尾逗号、单引号、
 *   外面还包一层 ```json 围栏。
 * 先试标准解析，失败再逐项修；修不好返回 null 交给上层处理。
 */
export function looseParse(raw) {
    let text = String(raw ?? '').trim();

    text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();

    try {
        return JSON.parse(text);
    } catch {
        // 继续走修复流程
    }

    const repaired = text
        .replace(/[“”„‟]/g, '"')
        .replace(/：/g, ':')
        .replace(/，/g, ',')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/([{,]\s*)'([^']*)'\s*:/g, '$1"$2":')
        .replace(/:\s*'([^']*)'/g, ': "$1"');

    try {
        return JSON.parse(repaired);
    } catch {
        return null;
    }
}

/* ============================================================
   二、字段定义与取值
   ============================================================ */

/** 把一个任意对象整理成合法字段；整理不出来返回 null */
export function normalizeField(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const key = String(raw.key ?? '').trim();
    if (!key) {
        return null;
    }

    const type = FIELD_TYPES.includes(raw.type) ? raw.type : 'text';
    const max = Number(raw.max);

    // dynamic 缺省时按 key 推断：mood 类字段天生适合跟随心情换表情。
    // 显式存过值（哪怕是空串）就尊重用户设置，不再自动改。
    const dynamic = raw.dynamic === undefined
        ? (key === 'mood' ? 'mood' : '')
        : (raw.dynamic === 'mood' ? 'mood' : '');

    return {
        key,
        label: String(raw.label ?? key).trim() || key,
        type,
        icon: String(raw.icon ?? ''),
        max: Number.isFinite(max) && max > 0 ? max : 100,
        inline: raw.inline !== false,
        // 时效状态：值里「效果(N)」的 N 每回合自动减一，归零消失
        ttl: raw.ttl === true,
        // 用户手动加的字段：方案替换 / 恢复默认时不许被抹掉
        custom: raw.custom === true,
        dynamic,
    };
}

/**
 * 整体规范化字段表：丢掉坏字段、去掉重复 key。
 * key 重复时保留先出现的那个，否则渲染与取值会打架。
 */
export function normalizeFieldList(list) {
    if (!Array.isArray(list)) {
        return [];
    }

    const seen = new Set();
    const out = [];

    for (const item of list) {
        const field = normalizeField(item);

        if (!field || seen.has(field.key)) {
            continue;
        }

        seen.add(field.key);
        out.push(field);
    }

    return out;
}

/** 按字段类型把原始值收敛成可渲染的值；收敛不了返回 undefined */
export function coerceValue(field, raw) {
    if (raw === undefined || raw === null) {
        return undefined;
    }

    if (field.type === 'bar' || field.type === 'number') {
        const num = parseFloat(String(raw).replace(/[^\d.\-]/g, ''));

        if (!Number.isFinite(num)) {
            return undefined;
        }

        const max = field.max || 100;
        return Math.min(max, Math.max(0, num));
    }

    if (field.type === 'tags') {
        const list = Array.isArray(raw) ? raw : String(raw).split(/[,，、/]/);
        const tags = list.map(item => String(item).trim()).filter(Boolean);
        return tags.length ? tags : undefined;
    }

    if (Array.isArray(raw)) {
        return raw.map(String).join(' / ');
    }

    if (typeof raw === 'object') {
        return JSON.stringify(raw);
    }

    const text = String(raw).trim();
    return text || undefined;
}

/** 单个角色内部的字段映射：按字段表过滤与校验 */
function mapFields(obj, fields) {
    const out = {};
    let hit = 0;

    for (const field of fields) {
        if (!field.key) {
            continue;
        }

        let value = coerceValue(field, obj[field.key]);

        // 模型有时直接用中文字段名（{"时间":"夜晚"}），label 也认一次
        if (value === undefined && field.label && field.label !== field.key) {
            value = coerceValue(field, obj[field.label]);
        }

        if (value === undefined) {
            continue;
        }

        out[field.key] = value;
        hit += 1;
    }

    return hit ? out : null;
}

/**
 * 判断模型返回的是「多人结构」还是「单人扁平结构」。
 *
 * 判据：键名里**没有任何一个是已知字段**，且值全是对象。
 * 这样即使给字段起了个像人名的 key，也不会误判。
 */
export function isMultiShape(obj, fields) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return false;
    }

    const keys = Object.keys(obj);
    if (!keys.length) {
        return false;
    }

    const fieldKeys = new Set(fields.map(field => field.key));
    const knownKeys = keys.filter(key => fieldKeys.has(key)).length;
    const allObjects = keys.every(key => obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key]));

    return knownKeys === 0 && allObjects;
}

/**
 * 收集模型输出里出现过的所有字段键（多人时取各角色的并集）。
 * 用于自动发现字段表里没有的新键。
 */
export function collectKeys(obj, fields) {
    const keys = new Set();

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return keys;
    }

    if (isMultiShape(obj, fields)) {
        for (const charData of Object.values(obj)) {
            if (charData && typeof charData === 'object' && !Array.isArray(charData)) {
                Object.keys(charData).forEach(key => keys.add(key));
            }
        }
    } else {
        Object.keys(obj).forEach(key => keys.add(key));
    }

    return keys;
}

/** 取某个键在模型输出里的第一个样本值（多角色时逐个角色找） */
export function sampleValue(obj, fields, targetKey) {
    if (!obj || typeof obj !== 'object') {
        return undefined;
    }

    if (isMultiShape(obj, fields)) {
        for (const charData of Object.values(obj)) {
            if (charData && Object.prototype.hasOwnProperty.call(charData, targetKey)) {
                return charData[targetKey];
            }
        }
        return undefined;
    }

    return obj[targetKey];
}

/**
 * 按样本值猜一个字段定义。
 *
 * 目标不是猜得完美，而是让新字段立刻能显示 —— 用户随后可以在编辑器里改显示名和图标。
 */
/** 常见英文键 → 中文标题，自动加字段时优先用中文 */
const CN_LABEL_HINTS = {
    time: '时间', date: '日期', day: '日期', location: '地点', place: '地点',
    scene: '场景', mood: '心情', emotion: '情绪', feeling: '感受',
    affection: '好感', favor: '好感', love: '爱意', relation: '关系', relationship: '关系',
    outfit: '服装', clothes: '服装', appearance: '外貌', age: '年龄',
    weather: '天气', temperature: '温度', hp: '生命', health: '健康',
    stamina: '体力', energy: '精力', fatigue: '疲劳', hunger: '饥饿',
    thirst: '口渴', sleep: '睡眠', pain: '疼痛', sanity: '理智',
    mana: '魔力', level: '等级', exp: '经验', money: '金钱', gold: '金币',
    status: '状态', state: '状态', states: '状态', buff: '增益', debuff: '减益',
    item: '物品', items: '物品', inventory: '携带', thought: '想法',
    action: '动作', pose: '姿势', position: '位置', goal: '目标', task: '任务',
    exhaustion: '疲惫', stress: '压力', fear: '恐惧', anger: '怒气', joy: '喜悦',
    arousal: '兴奋', lust: '欲望', trust: '信任', respect: '尊重', morale: '士气',
    hunger2: '饥饿', wound: '伤势', wounds: '伤势', injury: '伤势', bleeding: '流血',
    poison: '中毒', curse: '诅咒', blessing: '祝福', buffs: '增益', debuffs: '减益',
    clothing: '衣着', equipment: '装备', weapon: '武器', armor: '护甲',
    reputation: '声望', karma: '业力', alignment: '阵营', faction: '势力',
};

export function inferFieldFromSample(key, value) {
    const field = {
        key,
        // 自动加的字段一律用中文标题（英文键没映射上就原样，用户可在编辑器改）
        label: CN_LABEL_HINTS[key.toLowerCase()] ?? key,
        type: 'text',
        icon: '',
        max: 100,
        inline: false,
    };

    if (Array.isArray(value)) {
        field.type = 'tags';
        return field;
    }

    if (typeof value === 'number') {
        // 0-100 的整数默认当进度条，其它按普通数字
        if (Number.isInteger(value) && value >= 0 && value <= 100) {
            field.type = 'bar';
            field.max = 100;
        } else {
            field.type = 'number';
            field.max = Math.max(100, Math.ceil(Math.abs(value) * 2));
        }
        return field;
    }

    if (typeof value === 'string') {
        // "42/100" 这种写法直接认成进度条
        const ratio = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
        if (ratio) {
            field.type = 'bar';
            field.max = Number(ratio[2]) || 100;
        }
        return field;
    }

    return field;
}

/** 这些键是元信息，不是状态字段 */
const RESERVED_KEYS = /^(name|character|char|role|type|id|avatar|角色|姓名|名字|user|you|player|我|你|玩家|自己|主人|主角)$/i;

/** 键名是否适合自动建成字段 */
export function isUsableKey(key) {
    if (typeof key !== 'string') {
        return false;
    }

    const trimmed = key.trim();

    if (!trimmed || trimmed.length > 20) {
        return false;
    }

    // 排除换行、控制字符
    if (/[\n\r\t]/.test(trimmed)) {
        return false;
    }

    // 排除 name / user 这类元信息键
    if (RESERVED_KEYS.test(trimmed)) {
        return false;
    }

    // 至少含一个汉字或字母，避免「1」「--」这种
    return /[\u4e00-\u9fa5a-zA-Z]/.test(trimmed);
}

/**
 * 按字段表过滤、校验模型返回的对象。
 *
 * 支持两种结构：
 *   单人：{ "time": "傍晚", "mood": "疲惫" }
 *   多人：{ "艾琳": { "time": "傍晚" }, "米娅": { "time": "深夜" } }
 *
 * 统一输出成 `{ 角色名: { 字段 } }`，单人用空字符串当角色名，
 * 渲染时遇到空名就不显示角色标题。
 *
 * 判断依据：键名里**没有任何一个**是已知字段，且值全是对象 —— 才算多人。
 * 这样即使某人给字段起了个像人名的 key，也不会误判。
 */
/** 用户自己的身份名 —— 这些键永远不算角色，模型偶尔会把 {{user}} 也写进去 */
const USER_KEY_PATTERN = /^(user|you|player|me|self|protagonist|我|你|玩家|自己|用户|主人|主角|\{\{user\}\})$/i;

/** 数组格式 [{name:'艾琳', mood:'平静'}] → {艾琳: {mood:'平静'}} */
function arrayToCharMap(arr) {
    const out = {};

    for (const item of arr) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue;
        }

        const rawName = item.name ?? item.character ?? item.char ?? item.角色 ?? item.姓名 ?? item.名字;

        if (!rawName) {
            continue;
        }

        const data = { ...item };

        for (const key of ['name', 'character', 'char', '角色', '姓名', '名字']) {
            delete data[key];
        }

        out[String(rawName)] = data;
    }

    return out;
}

/** 剥掉模型常见的多包一层：{"characters": {...}} / {"status": {...}} */
function unwrapContainer(obj) {
    const keys = Object.keys(obj);

    if (keys.length !== 1) {
        return obj;
    }

    const inner = obj[keys[0]];

    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
        return obj;
    }

    const wrapper = keys[0].toLowerCase();

    return ['characters', 'character', 'chars', 'status', 'statuses', 'states', 'data', 'result']
        .includes(wrapper)
        ? inner
        : obj;
}

/** 角色名清洗：去掉包裹的引号/括号与首尾空白 */
function cleanCharName(name) {
    return String(name)
        .replace(/^[\s"'「『【[(]+|[\s"'」』】\])]+$/g, '')
        .trim()
        .slice(0, 24);
}

export function isUserLike(name, userName = '') {
    const trimmed = String(name ?? '').trim();

    if (!trimmed) {
        return true;
    }

    if (USER_KEY_PATTERN.test(trimmed)) {
        return true;
    }

    return userName && trimmed.toLowerCase() === String(userName).trim().toLowerCase();
}

/**
 * 识别模型输出的状态结构。
 *
 * 兼容四种常见形态（模型不总是听话）：
 *   1. {"time":"夜晚","mood":"平静"}                      单人扁平
 *   2. {"艾琳":{...},"米娅":{...}}                        多人
 *   3. {"characters":{"艾琳":{...}}}                      多包一层
 *   4. [{"name":"艾琳",...},{"name":"米娅",...}]          数组
 *
 * 无论哪种，用户自己的条目都会被剔除。
 */
export function normalizeData(obj, fields, userName = '') {
    if (!obj) {
        return null;
    }

    let data = obj;

    if (Array.isArray(data)) {
        data = arrayToCharMap(data);
    } else if (typeof data !== 'object') {
        return null;
    }

    data = unwrapContainer(data);

    if (Array.isArray(data)) {
        data = arrayToCharMap(data);
    }

    if (!data || typeof data !== 'object') {
        return null;
    }

    const pruned = {};

    for (const key of Object.keys(data)) {
        if (isUserLike(key, userName)) {
            continue;
        }

        pruned[key] = data[key];
    }

    const keys = Object.keys(pruned);

    if (!keys.length) {
        return null;
    }

    if (!isMultiShape(pruned, fields)) {
        const single = mapFields(pruned, fields);
        return single ? { '': single } : null;
    }

    const out = {};

    for (const name of keys) {
        const mapped = mapFields(pruned[name], fields);
        const clean = cleanCharName(name);

        if (mapped && clean) {
            out[clean] = mapped;
        }
    }

    return Object.keys(out).length ? out : null;
}

/* ============================================================
   三、提示词片段
   ============================================================ */

/** 把字段表描述成给模型看的清单 */
export function describeFields(fields) {
    return fields
        .filter(field => field.key)
        .map(field => {
            let typeText;

            if (field.type === 'bar') {
                typeText = `0 到 ${field.max || 100} 的整数`;
            } else if (field.type === 'number') {
                typeText = '数字';
            } else if (field.type === 'tags') {
                typeText = '用「、」分隔的短词列表';
            } else {
                typeText = '简短字符串';
            }

            return `- "${field.key}"（${field.label}）：${typeText}`;
        })
        .join('\n');
}

/** 按字段表生成示例对象，让模型看到目标结构 */
export function buildExample(fields, samples = SAMPLE_VALUES) {
    const sample = {};

    for (const field of fields) {
        if (!field.key) {
            continue;
        }

        if (field.type === 'bar' || field.type === 'number') {
            sample[field.key] = Math.round((field.max || 100) * 0.4);
        } else if (field.type === 'tags') {
            sample[field.key] = ['示例一', '示例二'];
        } else {
            sample[field.key] = samples[field.key] || '示例';
        }
    }

    return JSON.stringify(sample);
}

/* ============================================================
   四、配置文件（导入 / 导出）
   ============================================================ */

/** 布尔值容错：配置文件被手改成字符串也能认 */
function asBool(value, fallback) {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true';
    }
    return !!value;
}

/** 数值容错：限制在合理区间 */
function asInt(value, fallback, min, max) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(num)));
}

/**
 * 把任意来源的配置整理成标准结构。
 *
 * 兼容范围（用户从各处拷来的东西都得能吃下）：
 *   1. 本扩展导出的完整配置（带 $format / display / inject）
 *   2. 只有 fields + prompt 的简版对象
 *   3. 裸数组（只有字段定义）
 *
 * @returns {{ fields: Array, prompt: string, inject: object, display: object } | null}
 */
export function normalizeConfig(raw) {
    let data = raw;

    if (typeof raw === 'string') {
        try {
            data = JSON.parse(raw);
        } catch {
            return null;
        }
    }

    if (Array.isArray(data)) {
        data = { fields: data };
    }

    if (!data || typeof data !== 'object') {
        return null;
    }

    const fields = normalizeFieldList(data.fields);

    if (!fields.length) {
        return null;
    }

    const inject = data.inject && typeof data.inject === 'object' ? data.inject : {};
    const display = data.display && typeof data.display === 'object' ? data.display : {};

    return {
        name: String(data.name ?? '状态栏').trim() || '状态栏',
        fields,
        prompt: typeof data.prompt === 'string' && data.prompt.trim() ? data.prompt : null,
        inject: {
            depth: asInt(inject.depth ?? data.depth, 1, 0, 20),
            role: asInt(inject.role ?? data.role, 0, 0, 2),
            strip: asBool(inject.strip ?? data.strip, true),
        },
        display: {
            showInline: asBool(display.showInline ?? data.showInline, true),
            inlineLatestOnly: asBool(display.inlineLatestOnly ?? data.inlineLatestOnly, true),
            showFloat: asBool(display.showFloat ?? data.showFloat, true),
            ballIcon: typeof display.ballIcon === 'string' && display.ballIcon.trim()
                ? display.ballIcon.trim()
                : 'fa-solid fa-chart-simple',
            accent: typeof display.accent === 'string' ? display.accent.trim() : '',
            density: ['compact', 'normal'].includes(display.density) ? display.density : 'normal',
            autoAddFields: asBool(display.autoAddFields ?? data.autoAddFields, false),
            snapEdge: asBool(display.snapEdge ?? data.snapEdge, true),
            autoDetectChars: asBool(display.autoDetectChars ?? data.autoDetectChars, true),
            // 球 / 窗坐标跟着配置走，方便在手机和 PC 之间同步布局
            floatPos: normalizePos(display.floatPos),
            ballPos: normalizePos(display.ballPos),
        },
    };
}

/** 解析 {left, top} 坐标；无效返回 null（表示沿用本机位置） */
function normalizePos(pos) {
    if (!pos || typeof pos !== 'object') {
        return null;
    }

    const left = Number(pos.left);
    const top = Number(pos.top);

    if (!Number.isFinite(left) || !Number.isFinite(top)) {
        return null;
    }

    return { left: Math.round(left), top: Math.round(top) };
}
