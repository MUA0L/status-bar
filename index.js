/**
 * status-bar —— 双形态状态栏
 *
 * 解决什么问题：
 *   跑剧情时，时间、地点、心情、好感这类持续变化的量散落在正文里，
 *   翻记录才能拼出当前状态。这个扩展把它们抽成结构化数据，固定显示两处：
 *
 *     1. 每条 AI 回复末尾的简洁条   —— 跟着消息走，回看历史方便
 *     2. 输入框上方的悬浮面板       —— 固定在可视区底部，始终是「当前状态」
 *
 * 三条设计原则：
 *   A. 不碰角色卡、不碰预设。提示词通过 setExtensionPrompt 注入，删掉扩展即恢复原样。
 *   B. 数据跟着聊天走。<status> 区块从正文剥离后存进 message.extra 和 chat_metadata，
 *      换聊天、重启、导出记录都不会丢。
 *   C. 配置可搬移。字段定义 + 提示词 + 显示设置打包成一份 JSON，
 *      换设备（包括手机）导进去就能完整还原。
 *
 * 数据流：
 *   生成前 → buildPrompt() 按当前字段生成要求，注入上下文
 *   生成后 → 剥离 <status>，宽松解析，按字段校验
 *          → 写入 message.extra.statusbar（该条快照）+ chat_metadata.statusbar.current（当前态）
 *   渲染   → renderInline() 画简洁条，renderFloat() 画悬浮面板
 *
 * 配套：parse.js（数据层）、style.css（样式）
 */

import { extension_settings } from '../../../extensions.js';
import {
    chat,
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    messageFormatting,
    saveMetadata,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import {
    CONFIG_FORMAT,
    CONFIG_VERSION,
    SAMPLE_VALUES,
    buildExample,
    collectKeys,
    describeFields,
    extractBlock,
    inferFieldFromSample,
    isUsableKey,
    looseParse,
    normalizeConfig,
    normalizeData,
    normalizeFieldList,
    sampleValue,
} from './parse.js';

/* ============================================================
   常量
   ============================================================ */

/** extension_settings 下的命名空间 */
const MODULE = 'status-bar';

/** chat_metadata 与 message.extra 下存放状态的键 */
const STORE_KEY = 'statusbar';

/** setExtensionPrompt 的键，同键重复设置会覆盖而非叠加 */
const PROMPT_KEY = 'STATUSBAR_INSTRUCTIONS';

/* ============================================================
   默认配置
   ============================================================ */

/**
 * 默认字段。
 *
 * type：text 纯文本 / number 数字 / bar 0..max 进度条 / tags 标签组
 * inline：是否出现在「消息末尾简洁条」，悬浮面板始终显示全部
 */
const DEFAULT_FIELDS = [
    { key: 'time', label: '时间', type: 'text', icon: 'fa-regular fa-clock', max: 100, inline: true },
    { key: 'location', label: '地点', type: 'text', icon: 'fa-solid fa-location-dot', max: 100, inline: true },
    { key: 'mood', label: '心情', type: 'text', icon: 'fa-regular fa-face-smile', max: 100, inline: true, dynamic: 'mood' },
    { key: 'affection', label: '好感', type: 'bar', icon: 'fa-solid fa-heart', max: 100, inline: true },
    { key: 'date', label: '日期', type: 'text', icon: 'fa-regular fa-calendar', max: 100, inline: false },
    { key: 'weather', label: '天气', type: 'text', icon: 'fa-solid fa-cloud-sun', max: 100, inline: false },
    { key: 'relation', label: '关系', type: 'text', icon: 'fa-solid fa-link', max: 100, inline: false },
    { key: 'outfit', label: '服装', type: 'text', icon: 'fa-solid fa-shirt', max: 100, inline: false },
];

/**
 * 字段方案：整套字段配置，一键套用。
 *
 * 和 QUICK_FIELDS 的区别：快选是单个字段的加减，方案是成体系的替换
 * （比如从"日常"整个切到"孕期追踪"）。套用时可以选替换或追加。
 */
const FIELD_TEMPLATES = [
    {
        id: 'basic',
        name: '日常',
        desc: '时间地点心情好感，通用剧情',
        fields: [
            { key: 'time', label: '时间', type: 'text', icon: 'fa-regular fa-clock', max: 100, inline: true },
            { key: 'location', label: '地点', type: 'text', icon: 'fa-solid fa-location-dot', max: 100, inline: true },
            { key: 'mood', label: '心情', type: 'text', icon: 'fa-regular fa-face-smile', max: 100, inline: true, dynamic: 'mood' },
            { key: 'affection', label: '好感', type: 'bar', icon: 'fa-solid fa-heart', max: 100, inline: true },
            { key: 'date', label: '日期', type: 'text', icon: 'fa-regular fa-calendar', max: 100, inline: false },
            { key: 'weather', label: '天气', type: 'text', icon: 'fa-solid fa-cloud-sun', max: 100, inline: false },
            { key: 'relation', label: '关系', type: 'text', icon: 'fa-solid fa-link', max: 100, inline: false },
            { key: 'outfit', label: '服装', type: 'text', icon: 'fa-solid fa-shirt', max: 100, inline: false },
        ],
    },
    {
        id: 'body',
        name: '身体状态',
        desc: '体征指标，体力饥渴疲劳',
        fields: [
            { key: 'stamina', label: '体力', type: 'bar', icon: 'fa-solid fa-heart-pulse', max: 100, inline: true },
            { key: 'fatigue', label: '疲劳', type: 'bar', icon: 'fa-solid fa-bed', max: 100, inline: true },
            { key: 'temperature', label: '体温', type: 'number', icon: 'fa-solid fa-thermometer', max: 42, inline: true },
            { key: 'hunger', label: '饥饿', type: 'bar', icon: 'fa-solid fa-utensils', max: 100, inline: false },
            { key: 'thirst', label: '口渴', type: 'bar', icon: 'fa-solid fa-droplet', max: 100, inline: false },
            { key: 'sleep', label: '睡眠', type: 'number', icon: 'fa-solid fa-moon', max: 12, inline: false },
            { key: 'pain', label: '疼痛', type: 'bar', icon: 'fa-regular fa-face-grimace', max: 10, inline: false },
            { key: 'weight', label: '体重', type: 'number', icon: 'fa-solid fa-weight-scale', max: 200, inline: false },
        ],
    },
    {
        id: 'pregnancy',
        name: '孕期',
        desc: '孕周、预产期、胎儿与体征',
        fields: [
            { key: 'pregnancyWeek', label: '孕周', type: 'bar', icon: 'fa-solid fa-person-pregnant', max: 42, inline: true },
            { key: 'dueDate', label: '预产期', type: 'text', icon: 'fa-solid fa-calendar-day', max: 100, inline: true },
            { key: 'fetusState', label: '胎儿状态', type: 'text', icon: 'fa-solid fa-baby', max: 100, inline: false },
            { key: 'symptom', label: '孕期反应', type: 'text', icon: 'fa-regular fa-face-tired', max: 100, inline: true },
            { key: 'bellyMeasure', label: '腹围', type: 'number', icon: 'fa-solid fa-ruler-vertical', max: 150, inline: false },
            { key: 'fetalMove', label: '胎动', type: 'text', icon: 'fa-solid fa-hand', max: 100, inline: false },
            { key: 'milkVolume', label: '母乳量', type: 'bar', icon: 'fa-solid fa-person-breastfeeding', max: 100, inline: false },
            { key: 'weight', label: '体重', type: 'number', icon: 'fa-solid fa-weight-scale', max: 200, inline: false },
        ],
    },
    {
        id: 'cycle',
        name: '生理周期',
        desc: '周期阶段、经期与基础体温',
        fields: [
            { key: 'cyclePhase', label: '周期阶段', type: 'text', icon: 'fa-solid fa-calendar-days', max: 100, inline: true },
            { key: 'cycleDay', label: '经期第几天', type: 'number', icon: 'fa-solid fa-droplet', max: 10, inline: true },
            { key: 'nextCycle', label: '距下次', type: 'number', icon: 'fa-solid fa-hourglass-half', max: 40, inline: false },
            { key: 'flow', label: '经量', type: 'text', icon: 'fa-solid fa-droplet', max: 100, inline: false },
            { key: 'basalTemp', label: '基础体温', type: 'number', icon: 'fa-solid fa-thermometer', max: 42, inline: false },
            { key: 'breast', label: '乳房状态', type: 'text', icon: 'fa-solid fa-heart', max: 100, inline: false },
            { key: 'cramp', label: '腰腹不适', type: 'bar', icon: 'fa-solid fa-person', max: 10, inline: false },
        ],
    },
    {
        id: 'combat',
        name: '战斗',
        desc: '生命魔力护甲与状态',
        fields: [
            { key: 'hp', label: '生命', type: 'bar', icon: 'fa-solid fa-heart', max: 100, inline: true },
            { key: 'mp', label: '魔力', type: 'bar', icon: 'fa-solid fa-bolt', max: 100, inline: true },
            { key: 'armor', label: '护甲', type: 'bar', icon: 'fa-solid fa-shield', max: 100, inline: true },
            { key: 'buffs', label: '状态', type: 'tags', icon: 'fa-solid fa-skull', max: 100, inline: false },
            { key: 'round', label: '回合', type: 'number', icon: 'fa-solid fa-hourglass-half', max: 999, inline: false },
        ],
    },
];

/**
 * 心情 → 表情图标。
 *
 * 字段把「动态图标」设成 mood 后，图标不再写死，而是按当前值挑一个表情。
 * 顺序有讲究：越具体的情绪放越前面，避免「疲惫但满足」被宽泛规则先命中。
 */
const MOOD_ICONS = [
    // 复合情绪（如"疲惫但放松"）取更主要的那种 —— 负面/中性排前面，正面词排后面
    { pattern: /(心动|爱慕|迷恋|脸红心跳)/, icon: 'fa-regular fa-face-grin-hearts' },
    { pattern: /(害羞|羞怯|忸怩)/, icon: 'fa-regular fa-face-flushed' },
    { pattern: /(非常兴奋|极度兴奋|特别高兴|雀跃|欢快)/, icon: 'fa-regular fa-face-laugh-beam' },
    { pattern: /(生气|愤怒|恼火|不满|恼怒|不悦|火大)/, icon: 'fa-regular fa-face-angry' },
    { pattern: /(难过|悲伤|失落|沮丧|委屈|低落|伤心)/, icon: 'fa-regular fa-face-sad-tear' },
    { pattern: /(吃惊|惊讶|震惊|意外|诧异)/, icon: 'fa-regular fa-face-surprise' },
    { pattern: /(紧张|焦虑|不安|慌乱|局促|心慌)/, icon: 'fa-regular fa-face-grimace' },
    { pattern: /(疲惫|倦怠|困倦|劳累|乏力|精疲力竭)/, icon: 'fa-regular fa-face-tired' },
    { pattern: /(晕|恍惚|迷茫|失神)/, icon: 'fa-regular fa-face-dizzy' },
    { pattern: /(平静|淡然|中性|无表情|冷淡|漠然|冷静)/, icon: 'fa-regular fa-face-meh' },
    { pattern: /(微笑|温柔|满足|安心|放松|平和|柔和|开心|高兴|愉快|喜悦|兴奋)/, icon: 'fa-regular fa-face-smile' },
];

/** 按心情文本挑表情；匹配不到返回空串 */
function matchMoodIcon(text) {
    const value = String(text ?? '');

    for (const entry of MOOD_ICONS) {
        if (entry.pattern.test(value)) {
            return entry.icon;
        }
    }

    return '';
}

/**
 * 图标库：字段图标和悬浮球图标都从这里选。
 *
 * 全部逐个验证过存在于 FontAwesome 6 **Free** 里 ——
 * fa-sword / fa-bow-arrow 这类是 Pro 图标，Free 版渲染为空，不要放进来。
 * 想用库外的图标照样可以在输入框里手填类名。
 */
const ICON_GROUPS = [
    {
        name: '时间',
        icons: [
            'fa-regular fa-clock', 'fa-regular fa-calendar', 'fa-regular fa-calendar-days',
            'fa-solid fa-calendar-day', 'fa-solid fa-hourglass-half', 'fa-solid fa-stopwatch',
            'fa-solid fa-bell', 'fa-solid fa-bell-slash', 'fa-solid fa-moon',
            'fa-solid fa-sun', 'fa-solid fa-cloud-sun',
        ],
    },
    {
        name: '环境与天气',
        icons: [
            'fa-solid fa-cloud', 'fa-solid fa-cloud-rain', 'fa-solid fa-cloud-bolt',
            'fa-solid fa-tornado', 'fa-solid fa-rainbow', 'fa-solid fa-smog',
            'fa-solid fa-snowflake', 'fa-solid fa-fire', 'fa-solid fa-water',
            'fa-solid fa-wind', 'fa-solid fa-mountain', 'fa-solid fa-tree',
            'fa-solid fa-house', 'fa-solid fa-compass', 'fa-solid fa-route',
        ],
    },
    {
        name: '人物',
        icons: [
            'fa-solid fa-user', 'fa-solid fa-users', 'fa-solid fa-user-large',
            'fa-solid fa-eye', 'fa-solid fa-hand', 'fa-solid fa-hand-fist',
            'fa-solid fa-crown', 'fa-solid fa-star', 'fa-solid fa-star-half-stroke',
        ],
    },
    {
        name: '情绪',
        icons: [
            'fa-regular fa-face-smile', 'fa-regular fa-face-laugh-beam', 'fa-regular fa-face-grin-hearts',
            'fa-regular fa-face-meh', 'fa-regular fa-face-frown', 'fa-regular fa-face-sad-tear',
            'fa-regular fa-face-angry', 'fa-regular fa-face-surprise', 'fa-regular fa-face-flushed',
            'fa-regular fa-face-tired', 'fa-regular fa-face-dizzy', 'fa-regular fa-face-grimace',
        ],
    },
    {
        name: '人体 / 生理',
        icons: [
            'fa-solid fa-person-pregnant', 'fa-solid fa-person-breastfeeding', 'fa-solid fa-baby',
            'fa-solid fa-baby-carriage', 'fa-solid fa-children', 'fa-solid fa-child',
            'fa-solid fa-person', 'fa-solid fa-person-dress', 'fa-solid fa-dna',
            'fa-solid fa-heart', 'fa-solid fa-heart-pulse', 'fa-solid fa-heart-circle-plus',
            'fa-solid fa-hand-holding-heart', 'fa-solid fa-hand-holding-droplet',
            'fa-solid fa-hand-dots', 'fa-solid fa-ear-listen', 'fa-solid fa-head-side-cough',
            'fa-solid fa-head-side-mask', 'fa-solid fa-shoe-prints',
        ],
    },
    {
        name: '体征 / 医疗',
        icons: [
            'fa-solid fa-thermometer', 'fa-solid fa-weight-scale', 'fa-solid fa-ruler-vertical',
            'fa-solid fa-pills', 'fa-solid fa-syringe', 'fa-solid fa-vial', 'fa-solid fa-staff-snake',
            'fa-solid fa-lungs', 'fa-solid fa-tooth', 'fa-solid fa-bone',
            'fa-solid fa-wheelchair', 'fa-solid fa-person-cane',
        ],
    },
    {
        name: '状态与判定',
        icons: [
            'fa-solid fa-bolt', 'fa-solid fa-brain', 'fa-solid fa-shield', 'fa-solid fa-dumbbell',
            'fa-solid fa-gauge-high', 'fa-solid fa-battery-half', 'fa-solid fa-droplet',
            'fa-solid fa-wand-sparkles', 'fa-solid fa-ghost', 'fa-solid fa-skull',
            'fa-solid fa-circle-check', 'fa-solid fa-circle-xmark', 'fa-solid fa-triangle-exclamation',
            'fa-solid fa-circle-info', 'fa-solid fa-circle-question', 'fa-solid fa-ban',
            'fa-solid fa-eye-slash', 'fa-solid fa-scale-balanced',
        ],
    },
    {
        name: '战斗与冒险',
        icons: [
            'fa-solid fa-khanda', 'fa-solid fa-shield-halved', 'fa-solid fa-bullseye',
            'fa-solid fa-gavel', 'fa-solid fa-dice', 'fa-solid fa-map',
            'fa-solid fa-key', 'fa-solid fa-lock', 'fa-solid fa-gun',
            'fa-solid fa-bomb', 'fa-solid fa-explosion', 'fa-solid fa-shield-virus',
        ],
    },
    {
        name: '场景',
        icons: [
            'fa-solid fa-door-open', 'fa-solid fa-stairs', 'fa-solid fa-city',
            'fa-solid fa-building', 'fa-solid fa-store', 'fa-solid fa-church',
            'fa-solid fa-tent', 'fa-solid fa-campground',
        ],
    },
    {
        name: '食物与饮品',
        icons: [
            'fa-solid fa-utensils', 'fa-solid fa-bowl-food', 'fa-solid fa-bread-slice',
            'fa-solid fa-apple-whole', 'fa-solid fa-carrot', 'fa-solid fa-pizza-slice',
            'fa-solid fa-ice-cream', 'fa-solid fa-mug-hot', 'fa-solid fa-wine-glass',
            'fa-solid fa-beer-mug-empty',
        ],
    },
    {
        name: '物品与财物',
        icons: [
            'fa-solid fa-bag-shopping', 'fa-solid fa-coins', 'fa-solid fa-gem',
            'fa-solid fa-scroll', 'fa-solid fa-flask', 'fa-solid fa-book',
            'fa-solid fa-bed', 'fa-solid fa-shirt', 'fa-solid fa-ring',
            'fa-solid fa-hammer', 'fa-solid fa-screwdriver-wrench', 'fa-solid fa-toolbox',
            'fa-solid fa-anchor', 'fa-solid fa-compass-drafting',
            'fa-solid fa-money-bill', 'fa-solid fa-wallet', 'fa-solid fa-credit-card',
            'fa-solid fa-sack-dollar',
        ],
    },
    {
        name: '魔法与生灵',
        icons: [
            'fa-solid fa-hat-wizard', 'fa-solid fa-broom', 'fa-solid fa-meteor',
            'fa-solid fa-eye-low-vision', 'fa-solid fa-paw', 'fa-solid fa-dragon',
            'fa-solid fa-cat', 'fa-solid fa-dog', 'fa-solid fa-fish',
            'fa-solid fa-crow', 'fa-solid fa-horse', 'fa-solid fa-spider',
            'fa-solid fa-feather',
        ],
    },
    {
        name: '互动与标记',
        icons: [
            'fa-solid fa-handshake', 'fa-solid fa-hand-peace', 'fa-solid fa-thumbs-up',
            'fa-solid fa-thumbs-down', 'fa-solid fa-heart-crack', 'fa-solid fa-heart-circle-exclamation',
            'fa-solid fa-list-check', 'fa-solid fa-comment', 'fa-solid fa-music',
            'fa-solid fa-camera',
        ],
    },
];

/**
 * 常用字段：一键加进字段表。
 * 加的时候连键名、图标、类型、上限一起带上，用户不用再手填。
 */
const QUICK_FIELDS = [
    { key: 'time', label: '时间', type: 'text', icon: 'fa-regular fa-clock', inline: true },
    { key: 'location', label: '地点', type: 'text', icon: 'fa-solid fa-location-dot', inline: true },
    { key: 'mood', label: '心情', type: 'text', icon: 'fa-regular fa-face-smile', inline: true, dynamic: 'mood' },
    { key: 'affection', label: '好感', type: 'bar', icon: 'fa-solid fa-heart', inline: true, max: 100 },
    { key: 'hp', label: '体力', type: 'bar', icon: 'fa-solid fa-heart-pulse', inline: true, max: 100 },
    { key: 'mp', label: '灵力', type: 'bar', icon: 'fa-solid fa-bolt', inline: false, max: 100 },
    { key: 'san', label: '理智', type: 'bar', icon: 'fa-solid fa-brain', inline: false, max: 100 },
    { key: 'temperature', label: '体温', type: 'number', icon: 'fa-solid fa-thermometer', inline: true, max: 42 },
    { key: 'fatigue', label: '疲劳', type: 'bar', icon: 'fa-solid fa-bed', inline: true, max: 100 },
    { key: 'pregnancyWeek', label: '孕周', type: 'bar', icon: 'fa-solid fa-person-pregnant', inline: true, max: 42 },
    { key: 'weight', label: '体重', type: 'number', icon: 'fa-solid fa-weight-scale', inline: false, max: 200 },
    { key: 'date', label: '日期', type: 'text', icon: 'fa-regular fa-calendar', inline: false },
    { key: 'weather', label: '天气', type: 'text', icon: 'fa-solid fa-cloud-sun', inline: false },
    { key: 'relation', label: '关系', type: 'text', icon: 'fa-solid fa-link', inline: false },
    { key: 'outfit', label: '服装', type: 'text', icon: 'fa-solid fa-shirt', inline: false },
    { key: 'task', label: '任务', type: 'text', icon: 'fa-solid fa-list-check', inline: false },
    { key: 'states', label: '状态', type: 'tags', icon: 'fa-solid fa-wand-sparkles', inline: false },
    { key: 'items', label: '物品', type: 'tags', icon: 'fa-solid fa-bag-shopping', inline: false },
];

/**
 * 默认提示词。
 *
 * {{fields}}  字段清单，按当前字段自动生成
 * {{example}} 示例 JSON，按当前字段自动生成
 */
const DEFAULT_PROMPT = `[状态栏要求]
每次回复正文结束后，另起一行输出一个 <status> 区块，记录该时刻的场景状态。

格式：
<status>
{{example}}
</status>

字段（全部必填）：
{{fields}}

多角色：
如果同时有多名角色需要分别追踪，按角色名分组输出 —— 外层是角色名，内层是该角色的字段：
<status>
{"角色甲":{"字段":"值"},"角色乙":{"字段":"值"}}
</status>
只追踪一个人时不要加外层，直接输出字段对象。

时效状态：
临时效果（中毒、祝福、 buffs 等）写成「效果(剩余回合数)」，如 "中毒(3)"。
系统会每回合自动倒数，归零自动消失；你只需在效果首次出现时写上回合数，
之后重复输出时会以系统倒数后的值为准。

硬性要求：
1. 整条回复只输出一次该区块，紧跟在正文末尾；
2. 区块内只有一段合法 JSON，不要加注释、代码块围栏或任何解释文字；
3. 数值字段输出纯数字，不要带 % 或其它单位；
4. 字段值用简短词组，不要写成句子；
5. 不要在正文里用自然语言复述状态栏的内容。`;

const DEFAULT_INJECT = {
    depth: 1,
    role: extension_prompt_roles.SYSTEM,
    strip: true,
};

const DEFAULT_DISPLAY = {
    showInline: true,
    /** 只在最新一条回复末尾显示简洁条；关掉则每条带状态的回复都显示 */
    inlineLatestOnly: true,
    /** 是否启用悬浮球（关了球和窗都不出现） */
    showFloat: true,
    /** 悬浮球上的图标类名 */
    ballIcon: 'fa-solid fa-chart-simple',
    /** 悬浮窗当前是否打开；由悬浮球控制。属于本机状态，不随配置导出 */
    floatOpen: false,
    /**
     * 模型输出了字段表之外的键时，是否自动建成新字段。
     * 默认关闭 —— 字段表保持稳定，未知键只用于「跟随心情」这类动态图标识别。
     */
    autoAddFields: false,
    /** 悬浮窗坐标 { left, top }；null 表示跟随悬浮球。属于本机偏好，不随配置导出 */
    floatPos: null,
    /** 悬浮球坐标 { left, top }；null 表示用 CSS 默认位置。属于本机偏好，不随配置导出 */
    ballPos: null,
    accent: '',
    density: 'normal',
};

/** 新建配置时的完整默认值 */
function defaultSettings() {
    return {
        enabled: true,
        name: '默认状态栏',
        fields: structuredClone(DEFAULT_FIELDS),
        prompt: DEFAULT_PROMPT,
        inject: structuredClone(DEFAULT_INJECT),
        display: structuredClone(DEFAULT_DISPLAY),
    };
}

/* ============================================================
   配置读写
   ============================================================ */

/**
 * 取配置并补齐缺失键。
 *
 * 刻意不对 fields 做过滤或规范化：字段编辑器允许临时空 key
 * （用户正在清空重打），一规范化就把这个字段抹掉、输入框跟着消失。
 */
function settings() {
    if (!extension_settings[MODULE] || typeof extension_settings[MODULE] !== 'object') {
        extension_settings[MODULE] = defaultSettings();
    }

    const s = extension_settings[MODULE];

    if (!Array.isArray(s.fields)) {
        s.fields = structuredClone(DEFAULT_FIELDS);
    }

    if (!s.inject || typeof s.inject !== 'object') {
        s.inject = structuredClone(DEFAULT_INJECT);
    } else {
        for (const key of Object.keys(DEFAULT_INJECT)) {
            if (s.inject[key] === undefined) {
                s.inject[key] = DEFAULT_INJECT[key];
            }
        }
    }

    if (!s.display || typeof s.display !== 'object') {
        s.display = structuredClone(DEFAULT_DISPLAY);
    } else {
        for (const key of Object.keys(DEFAULT_DISPLAY)) {
            if (s.display[key] === undefined) {
                s.display[key] = DEFAULT_DISPLAY[key];
            }
        }
    }

    if (typeof s.enabled !== 'boolean') {
        s.enabled = true;
    }

    if (typeof s.prompt !== 'string' || !s.prompt.trim()) {
        s.prompt = DEFAULT_PROMPT;
    }

    if (typeof s.name !== 'string') {
        s.name = '状态栏';
    }

    return s;
}

/* ============================================================
   状态解析
   ============================================================ */

/** 从消息正文提取状态；发现字段表里没有的键时按需补字段 */
function parseMessage(mes) {
    let found = extractBlock(mes);

    // 兜底：模型偶尔会忘包 <status> 标签，把 JSON 裸放在回复末尾。
    // 只有解析结果里认得出已知字段（或是多角色结构）才收下，避免误伤正文。
    if (!found) {
        const tail = mes.match(/\{[\s\S]*\}\s*$/);

        if (tail) {
            const raw = looseParse(tail[0]);
            const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw) : [];
            const fieldKeys = new Set(settings().fields.map(field => field.key));
            const hasKnown = keys.some(key => fieldKeys.has(key));
            const looksMulti = keys.length > 0 && keys.every(key => raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key]));

            if (hasKnown || looksMulti) {
                found = { json: tail[0], cleaned: mes.slice(0, tail.index).trim() };
            }
        }
    }

    if (!found) {
        return null;
    }

    const raw = looseParse(found.json);

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        console.warn('[status-bar] 状态块解析失败，原文：', found.json);
        return null;
    }

    // 自动补字段会改动字段表，必须在 normalizeData 之前做，
    // 否则新键在这一轮就被丢掉了
    autoDiscoverFields(raw);

    const data = normalizeData(raw, settings().fields);

    if (!data) {
        console.warn('[status-bar] 状态块里没有可用字段，原文：', found.json);
        return null;
    }

    return { data, cleaned: found.cleaned };
}

/**
 * 把模型输出里字段表没有的键自动建成字段。
 *
 * 这样不用提前把所有字段配齐 —— 模型给了什么就显示什么。
 * 只补一次，之后走正常字段流程（可在编辑器里改名、换图标、删掉）。
 */
function autoDiscoverFields(raw) {
    const s = settings();

    if (!s.display.autoAddFields) {
        return;
    }

    const known = new Set(s.fields.map(field => field.key));
    const incoming = [...collectKeys(raw, s.fields)];

    const fresh = incoming
        .filter(key => !known.has(key) && isUsableKey(key))
        .slice(0, 5); // 一次最多补 5 个，防止模型跑偏时灌进来一大堆

    if (!fresh.length) {
        return;
    }

    for (const key of fresh) {
        s.fields.push(inferFieldFromSample(key, sampleValue(raw, s.fields, key)));
    }

    saveSettingsDebounced();
    scheduleRefresh(120);
    notify('info', `自动添加了 ${fresh.length} 个字段：${fresh.join('、')}`);
}

/* ============================================================
   状态存储
   ============================================================ */

/**
 * 取当前聊天的状态容器。
 *
 * chat_metadata 会在切换聊天时被整体替换，所以每次都要重新从 getContext() 取。
 * 这里不校验 chatId：半初始化状态（角色刚载入、chat_metadata 还是空对象）下
 * getCurrentChatId() 可能为空，但内存里的 chat_metadata 依然可用。
 */
function store(create) {
    const meta = getContext()?.chatMetadata;

    if (!meta || typeof meta !== 'object') {
        return null;
    }

    if (!meta[STORE_KEY] || typeof meta[STORE_KEY] !== 'object') {
        if (!create) {
            return null;
        }
        meta[STORE_KEY] = { current: {}, msgId: null };
    }

    const bag = meta[STORE_KEY];

    if (!bag.current || typeof bag.current !== 'object') {
        bag.current = {};
    }

    return bag;
}

/**
 * 从消息流里倒查最近一条带状态的快照。
 * chat_metadata 不可用时的兜底 —— 状态本来就随消息走。
 */
function latestSnapshot() {
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const data = chat[i]?.extra?.[STORE_KEY];

        if (data && Object.keys(data).length) {
            return { data, msgId: i };
        }
    }

    return null;
}

/** 当前状态快照（悬浮面板默认显示这个） */
function currentData() {
    const bag = store(false);

    if (bag && Object.keys(bag.current).length) {
        return bag.current;
    }

    return latestSnapshot()?.data ?? {};
}

/** 某条消息自带的状态快照 */
function messageData(msgId) {
    return chat[msgId]?.extra?.[STORE_KEY] || null;
}

/**
 * 按消息流重算「当前状态」。
 *
 * 重新生成 / 切换 swipe 会替换掉原来那条的状态，新内容有可能压根没解析出状态块
 * （模型漏输出、格式跑偏）。这时不能留着旧值，否则状态栏显示的是上一版的状态。
 * 做法是清空后从最后一条带快照的消息回填 —— 没有就真的清空。
 */
async function recomputeCurrent() {
    const snap = latestSnapshot();
    const bag = store(true);

    if (!bag) {
        return;
    }

    if (snap) {
        bag.current = { ...snap.data };
        bag.charOrder = Object.keys(snap.data);
        bag.msgId = snap.msgId;
    } else {
        bag.current = {};
        bag.charOrder = [];
        bag.msgId = null;
    }

    bag.updatedAt = Date.now();
    await saveMetadata();
}

/**
 * 多人上限：同屏最多追踪 4 个角色。
 * 超出时淘汰最久没被模型更新过的（角色淡出再回归，数据不会丢，只是占位）。
 */
const MAX_CHARS = 4;

/** 单角色快照在 current 里占的键名（单人模式用空字符串） */
const SOLO_KEY = '';

/**
 * 时效状态推进：值里带 "(N)" 的效果每回合减一，减到 0 自动消失。
 * 没带数字的部分永久保留。tags 数组逐个元素处理。
 */
function advanceTtlValue(value) {
    const step = text => {
        const m = String(text).match(/^(.*?)\s*[（(](\d+)[)）]\s*$/);

        if (!m) {
            return text;
        }

        const n = Number(m[2]) - 1;
        return n > 0 ? `${m[1]}(${n})` : null;
    };

    if (Array.isArray(value)) {
        const next = value.map(step).filter(Boolean);
        return next.length ? next : undefined;
    }

    const next = step(value);
    return next === null ? undefined : next;
}

/** 对单角色的数据推进所有开了「时效」的字段 */
function advanceTtlFields(data) {
    for (const field of settings().fields) {
        if (!field.ttl) {
            continue;
        }

        const val = data[field.key];

        if (val === undefined) {
            continue;
        }

        const next = advanceTtlValue(val);

        if (next === undefined) {
            delete data[field.key];
        } else {
            data[field.key] = next;
        }
    }
}

/**
 * 合并写入当前态。
 *
 * 单人输出：整体回到单人模式。
 * 多人输出：本次输出的角色用新值整体替换（角色回归 = 以实际输出更新）；
 *           这次没提到的角色保留最后已知状态（淡出不消失）；
 *           角色总数超过 MAX_CHARS 时，淘汰排在最尾（最久未更新）的。
 *
 * 注意和 recomputeCurrent 的区别：那边是"从消息快照重建"，
 * 这里是"实时合并" —— 两者语义不同，不要混用。
 */
async function commit(patch, msgId) {
    const bag = store(true);
    if (!bag) {
        return;
    }

    const isSolo = Object.prototype.hasOwnProperty.call(patch, SOLO_KEY);
    const oldOrder = Array.isArray(bag.charOrder) ? bag.charOrder : Object.keys(bag.current ?? {});

    let merged;
    let order;

    if (isSolo) {
        merged = { ...patch };
        order = [SOLO_KEY];
        advanceTtlFields(merged[SOLO_KEY]);
    } else {
        merged = {};
        order = [];

        // 本次输出的角色排前面，保持模型给的顺序
        for (const name of Object.keys(patch)) {
            const data = patch[name];
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                merged[name] = { ...data };
                advanceTtlFields(merged[name]);
                order.push(name);
            }
        }

        // 淡出的角色跟在后面，保留最后已知状态；
        // 时效状态照样倒数 —— 人不在场，时间也在流逝
        for (const name of oldOrder) {
            if (name === SOLO_KEY || order.includes(name)) {
                continue;
            }

            const prev = bag.current?.[name];

            if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
                merged[name] = { ...prev };
                advanceTtlFields(merged[name]);
                order.push(name);
            }
        }

        while (order.length > MAX_CHARS) {
            const dropped = order.pop();
            delete merged[dropped];
        }
    }

    bag.current = merged;
    bag.charOrder = order;
    bag.msgId = msgId ?? null;
    bag.updatedAt = Date.now();

    await saveMetadata();
}

/**
 * 从消息正文提取状态，写进 message.extra，并按需剥离原文。
 * @returns {object|null} 解析出的状态
 */
function ingest(msg, shouldStrip) {
    const parsed = parseMessage(msg.mes);

    if (!parsed) {
        return null;
    }

    msg.extra = msg.extra || {};
    msg.extra[STORE_KEY] = parsed.data;

    if (shouldStrip) {
        msg.mes = parsed.cleaned;
    }

    return parsed.data;
}

/* ============================================================
   渲染工具
   ============================================================ */

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
}

/**
 * 字段图标。
 * dynamic === 'mood' 时按当前值挑表情 —— 心情一变，图标跟着换。
 */
function iconHtml(field, value) {
    let cls = field.icon || '';

    if (field.dynamic === 'mood' && value !== undefined) {
        const moodIcon = matchMoodIcon(value);

        if (moodIcon) {
            cls = moodIcon;
        }
    }

    return cls ? `<i class="${esc(cls)}" aria-hidden="true"></i>` : '';
}

/** 进度条取值分级：低于 20% 提示告警，高于 80% 强化 */
function barLevel(pct) {
    if (pct <= 20) {
        return ' is-low';
    }
    if (pct >= 80) {
        return ' is-high';
    }
    return '';
}

/** 简洁条上的一个字段 */
function chipHtml(field, value) {
    const icon = iconHtml(field, value);

    if (field.type === 'bar') {
        const max = field.max || 100;
        const num = Number(value) || 0;
        const pct = Math.max(0, Math.min(100, (num / max) * 100));

        return `<span class="sb-chip">${icon}`
            + `<span class="sb-chip-key">${esc(field.label)}</span>`
            + `<span class="sb-mini"><span class="sb-mini-fill${barLevel(pct)}" style="width:${pct.toFixed(1)}%"></span></span>`
            + `<span class="sb-chip-val sb-num">${esc(num)}</span>`
            + `</span>`;
    }

    if (field.type === 'tags') {
        const tags = (Array.isArray(value) ? value : [value]).filter(Boolean);
        return `<span class="sb-chip">${icon}`
            + `<span class="sb-chip-key">${esc(field.label)}</span>`
            + `<span class="sb-chip-val">${esc(tags.join('、'))}</span>`
            + `</span>`;
    }

    if (field.type === 'number') {
        return `<span class="sb-chip">${icon}`
            + `<span class="sb-chip-key">${esc(field.label)}</span>`
            + `<span class="sb-chip-val sb-num">${esc(value)}</span>`
            + `</span>`;
    }

    // 纯文本只显示值：值本身通常已是可读短语（傍晚 / 书房 / 疲惫）
    return `<span class="sb-chip">${icon}<span class="sb-chip-val">${esc(value)}</span></span>`;
}

/** 悬浮面板上的一个字段 */
function itemHtml(field, value) {
    const icon = iconHtml(field, value);

    if (field.type === 'bar') {
        const max = field.max || 100;
        const num = Number(value) || 0;
        const pct = Math.max(0, Math.min(100, (num / max) * 100));

        return `<div class="sb-item sb-item--bar">`
            + `<div class="sb-item-label">${icon}${esc(field.label)}</div>`
            + `<div class="sb-bar">`
            + `<span class="sb-bar-track"><span class="sb-bar-fill${barLevel(pct)}" style="width:${pct.toFixed(1)}%"></span></span>`
            + `<span class="sb-bar-num sb-num">${esc(num)}<span class="sb-bar-max">/${esc(max)}</span></span>`
            + `</div></div>`;
    }

    if (field.type === 'number') {
        return `<div class="sb-item">`
            + `<div class="sb-item-label">${icon}${esc(field.label)}</div>`
            + `<div class="sb-item-value sb-num">${esc(value)}</div>`
            + `</div>`;
    }

    if (field.type === 'tags') {
        const tags = (Array.isArray(value) ? value : [value]).filter(Boolean);
        const html = tags.map(tag => `<span class="sb-tag">${esc(tag)}</span>`).join('');
        return `<div class="sb-item">`
            + `<div class="sb-item-label">${icon}${esc(field.label)}</div>`
            + `<div class="sb-item-value">${html}</div>`
            + `</div>`;
    }

    return `<div class="sb-item">`
        + `<div class="sb-item-label">${icon}${esc(field.label)}</div>`
        + `<div class="sb-item-value">${esc(value)}</div>`
        + `</div>`;
}

/* ============================================================
   渲染：消息末尾简洁条
   ============================================================ */

function messageElement(msgId) {
    return document.querySelector(`#chat .mes[mesid="${msgId}"]`);
}

/** 最后一条 AI 回复的下标；没有则返回 -1 */
function latestAssistantIndex() {
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const msg = chat[i];
        if (msg && !msg.is_user && !msg.is_system) {
            return i;
        }
    }
    return -1;
}

function renderInline(msgId) {
    const el = messageElement(msgId);
    if (!el) {
        return;
    }

    const existing = el.querySelector('.sb-inline');
    const s = settings();

    let html = null;

    if (s.enabled && s.display.showInline) {
        const latestOk = !s.display.inlineLatestOnly || msgId === latestAssistantIndex();
        const bagData = messageData(msgId);

        if (latestOk && bagData) {
            // 每个角色一行；单人的角色名是空串，不渲染名字
            const rows = Object.entries(bagData)
                .map(([name, charData]) => {
                    const fields = s.fields.filter(field => field.inline && charData[field.key] !== undefined);

                    if (!fields.length) {
                        return '';
                    }

                    const nameHtml = name ? `<span class="sb-inline-name">${esc(name)}</span>` : '';
                    const chips = fields.map(field => chipHtml(field, charData[field.key])).join('');

                    return `<div class="sb-inline-row">${nameHtml}${chips}</div>`;
                })
                .filter(Boolean);

            if (rows.length) {
                html = rows.join('');
            }
        }
    }

    // 没有可显示的内容：清掉旧条
    if (html === null) {
        existing?.remove();
        return;
    }

    // 内容没变就不重建，避免每轮刷新都闪一下
    const sig = contentSig(html);

    if (existing) {
        if (existing.dataset.sig !== sig) {
            existing.innerHTML = html;
            existing.dataset.sig = sig;
        }
        return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'sb-inline';
    wrap.dataset.mesid = String(msgId);
    wrap.dataset.sig = sig;
    wrap.title = '点击查看该时刻的完整状态';
    wrap.innerHTML = html;

    el.querySelector('.mes_text').insertAdjacentElement('afterend', wrap);
}

/** 短内容签名：只用于比较，不需要密码学强度 */
function contentSig(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i += 1) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return String(hash);
}

function renderAllInline() {
    const s = settings();

    // 全量清理最快的一条路
    if (!s.enabled || !s.display.showInline) {
        document.querySelectorAll('#chat .sb-inline').forEach(el => el.remove());
        return;
    }

    // 按数据决定该渲染哪些楼层，DOM 里多余的条统一清掉。
    // 长聊天里这比「逐楼查 DOM 再逐楼 add/remove」便宜得多。
    const valid = new Set();
    const latest = latestAssistantIndex();

    if (s.display.inlineLatestOnly) {
        if (latest >= 0 && chat[latest]?.extra?.[STORE_KEY]) {
            renderInline(latest);
            valid.add(String(latest));
        }
    } else {
        chat.forEach((msg, index) => {
            if (msg?.extra?.[STORE_KEY]) {
                renderInline(index);
                valid.add(String(index));
            }
        });
    }

    document.querySelectorAll('#chat .sb-inline').forEach(el => {
        if (!valid.has(el.dataset.mesid)) {
            el.remove();
        }
    });
}

/* ============================================================
   渲染：底部固定面板
   ============================================================ */

/** 回看中的消息 id；null 表示跟随最新 */
let viewMsgId = null;

/** 是否正在生成（悬浮窗显示等待提示） */
let generating = false;

/** 悬浮窗是否处于字段编辑模式（本机会话状态，不持久化） */
let editorMode = false;

/** 标签页选中的角色名；null = 全部视图 */
let activeChar = null;

/**
 * 编辑器内容是否已渲染。
 *
 * 编辑模式下不能每次 renderFloat 都重绘列表 —— 那会把输入焦点、
 * 展开状态、正在输入的内容全冲掉。只在进入编辑模式时渲染一次，
 * 后续变更走 refreshFieldUI()。
 */
let editorRendered = false;

/** 刷新防抖句柄 */
let refreshTimer = null;

function floatElement() {
    return document.getElementById('sb-float');
}

function ballElement() {
    return document.getElementById('sb-ball');
}

/**
 * 悬浮球：常驻右下角的圆形按钮，点一下开关悬浮窗。
 * 用 div 而不是 button，避免被 ST 的全局 button 样式影响。
 */
function mountBall() {
    if (ballElement()) {
        return;
    }

    const ball = document.createElement('div');
    ball.id = 'sb-ball';
    ball.setAttribute('role', 'button');
    ball.setAttribute('tabindex', '0');
    ball.setAttribute('aria-label', '状态栏');
    ball.title = '状态栏';
    ball.innerHTML = '<i class="fa-solid fa-chart-simple" aria-hidden="true"></i>';

    bindBallDrag(ball);

    ball.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleFloat();
        }
    });

    document.body.appendChild(ball);

    applyBallPosition();
}

/* ---------- 悬浮球拖动 ---------- */

/** 球拖动状态；null 表示没在拖 */
let ballDragState = null;

function bindBallDrag(ball) {
    ball.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) {
            return;
        }

        const rect = ball.getBoundingClientRect();

        ballDragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: rect.left,
            top: rect.top,
            moved: false,
        };

        ball.classList.add('sb-ball-dragging');

        try {
            ball.setPointerCapture(event.pointerId);
        } catch {
            // 忽略
        }

        event.preventDefault();
    });

    ball.addEventListener('pointermove', event => {
        if (!ballDragState || event.pointerId !== ballDragState.pointerId) {
            return;
        }

        const dx = event.clientX - ballDragState.startX;
        const dy = event.clientY - ballDragState.startY;

        if (!ballDragState.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
            return;
        }

        ballDragState.moved = true;
        setBallPosition(ballDragState.left + dx, ballDragState.top + dy);

        // 窗口还跟着球的话，跟着一起挪，避免拖到一半两者分家
        const s = settings();
        if (s.display.floatOpen && !positionFitsViewport(s.display.floatPos)) {
            windowAnchorToBall();
        }
    });

    ball.addEventListener('pointerup', event => {
        if (!ballDragState || event.pointerId !== ballDragState.pointerId) {
            return;
        }

        ball.classList.remove('sb-ball-dragging');

        try {
            ball.releasePointerCapture?.(event.pointerId);
        } catch {
            // 忽略
        }

        if (ballDragState.moved) {
            const rect = ball.getBoundingClientRect();
            settings().display.ballPos = {
                left: Math.round(rect.left),
                top: Math.round(rect.top),
            };
            saveSettingsDebounced();
        } else {
            // 没移动 = 一次点击，开关悬浮窗
            toggleFloat();
        }

        ballDragState = null;
    });

    ball.addEventListener('pointercancel', event => {
        if (!ballDragState || event.pointerId !== ballDragState.pointerId) {
            return;
        }
        ball.classList.remove('sb-ball-dragging');
        ballDragState = null;
    });
}

/** 把球摆到指定坐标，夹在视口内 */
function setBallPosition(left, top) {
    const ball = ballElement();
    if (!ball) {
        return;
    }

    const maxLeft = Math.max(0, window.innerWidth - ball.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - ball.offsetHeight);

    ball.style.left = Math.min(Math.max(0, Math.round(left)), maxLeft) + 'px';
    ball.style.top = Math.min(Math.max(0, Math.round(top)), maxTop) + 'px';
    ball.style.right = 'auto';
    ball.style.bottom = 'auto';
}

/**
 * 若球与输入区重叠，把它顶到输入区上方。
 *
 * 只在恢复保存位置时调用 —— 用户主动拖到那里的话不拦，
 * 但下次重新加载布局（换设备、窗口变小）时自动让开，
 * 避免球压在发送按钮上导致点不到。
 */
function clampAboveInput() {
    const ball = ballElement();
    const form = document.getElementById('form_sheld');
    if (!ball || !form) {
        return;
    }

    const br = ball.getBoundingClientRect();
    const fr = form.getBoundingClientRect();

    if (!fr.height) {
        return;
    }

    const overlap = !(br.right <= fr.left || br.left >= fr.right || br.bottom <= fr.top || br.top >= fr.bottom);

    if (!overlap) {
        return;
    }

    const top = Math.max(8, fr.top - br.height - 12);
    setBallPosition(br.left, top);

    const pos = settings().display.ballPos;
    if (pos) {
        pos.top = Math.round(top);
        saveSettingsDebounced();
    }
}

/** 按保存的坐标摆放球；没有坐标就交给 CSS 的 right/bottom */
/**
 * 坐标是否还落在当前视口里。
 *
 * 从别的设备同步过来的配置（PC 的坐标搬到手机上）常常超出屏幕，
 * 那种情况直接当无效处理，回到默认位置，免得球半截露在外面。
 */
function positionFitsViewport(pos) {
    if (!pos || typeof pos !== 'object') {
        return false;
    }

    const left = Number(pos.left);
    const top = Number(pos.top);

    if (!Number.isFinite(left) || !Number.isFinite(top)) {
        return false;
    }

    return left >= 0 && top >= 0 && left < window.innerWidth - 20 && top < window.innerHeight - 20;
}

function applyBallPosition() {
    const ball = ballElement();
    if (!ball) {
        return;
    }

    const pos = settings().display.ballPos;

    if (positionFitsViewport(pos)) {
        setBallPosition(Number(pos.left), Number(pos.top));
        clampAboveInput();
    } else {
        ball.style.left = '';
        ball.style.top = '';
        ball.style.right = '';
        ball.style.bottom = '';
    }
}

/**
 * 让悬浮窗贴着球出现：优先球上方，上方放不下就放下方，水平以球为中心。
 * 只在用户没手动拖过窗口时（floatPos 为 null）生效。
 */
function windowAnchorToBall() {
    const ball = ballElement();
    const win = floatElement();
    if (!ball || !win || win.hidden) {
        return;
    }

    const br = ball.getBoundingClientRect();
    const width = win.offsetWidth;
    const height = win.offsetHeight;

    let left = br.left + br.width / 2 - width / 2;
    let top = br.top - height - 10;

    if (top < 8) {
        top = br.bottom + 10;
    }

    setFloatPosition(left, top);
}

/** 球点击：开 / 关悬浮窗 */
function toggleFloat() {
    const s = settings();
    s.display.floatOpen = !s.display.floatOpen;
    saveSettingsDebounced();
    renderFloat();
}

function mountFloat() {
    if (floatElement()) {
        return;
    }

    const el = document.createElement('div');
    el.id = 'sb-float';
    el.className = 'sb-float';

    el.innerHTML = `
        <div class="sb-float-head" role="button" tabindex="0" aria-label="拖动移动，点击折叠">
            <span class="sb-float-title">状态</span>
            <span class="sb-float-badge" hidden></span>
            <span class="sb-float-tools">
                <button type="button" class="sb-tool" data-act="settings" title="自定义字段" aria-label="自定义字段">
                    <i class="fa-solid fa-sliders" aria-hidden="true"></i>
                </button>
                <button type="button" class="sb-tool" data-act="history" title="历史快照" aria-label="历史快照">
                    <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>
                </button>
            </span>
        </div>
        <div class="sb-history-menu" hidden></div>
        <div class="sb-char-tabs" hidden></div>
        <div class="sb-float-body"></div>
        <div class="sb-float-editor" hidden>
            <div class="sb-hint">
                先挑方案，或用下面的按钮逐个加字段。改「显示名」就能用，图标在 <b>⋯</b> 里选。
            </div>
            <div class="sb-templates" data-role="templates"></div>
            <div class="sb-quick" data-role="quick"></div>
            <div class="sb-field-list" data-role="list"></div>
            <div class="sb-editor-actions">
                <button type="button" class="sb-btn sb-btn--primary" data-act="done">完成</button>
                <button type="button" class="sb-btn" data-act="addfield">+ 自定义字段</button>
                <button type="button" class="sb-btn" data-act="preview">预览</button>
                <button type="button" class="sb-btn" data-act="adv">提示词等设置</button>
                <button type="button" class="sb-btn sb-btn--danger" data-act="reset">恢复默认</button>
            </div>
            <div class="sb-icon-picker" hidden>
                <div class="sb-icon-grid"></div>
            </div>
        </div>`;

    // 直接挂 body：fixed 定位，浮在页面上，不参与 #sheld 的 flex 布局，
    // 所以不会挤压聊天区，也不会盖住消息（位置由用户自己拖）。
    document.body.appendChild(el);

    bindFloatDrag(el);
    bindFieldEvents(el.querySelector('.sb-float-editor'));

    // 图标选择器：点中即写入并收起
    el.querySelector('.sb-icon-picker').addEventListener('click', event => {
        const cell = event.target.closest('.sb-icon-cell');
        if (!cell) {
            return;
        }

        const field = settings().fields[iconPickerIndex];
        if (field) {
            field.icon = cell.dataset.icon || '';
            saveSettingsDebounced();
            refreshFieldUI(el.querySelector('.sb-float-editor'));
            scheduleRefresh(120);
        }

        closeIconPicker();
    });

    el.querySelector('.sb-float-badge').addEventListener('click', event => {
        event.stopPropagation();
        viewMsgId = null;
        renderFloat();
    });

    el.querySelector('.sb-tool[data-act="history"]').addEventListener('click', event => {
        event.stopPropagation();
        toggleHistoryMenu();
    });

    el.querySelector('.sb-tool[data-act="settings"]').addEventListener('click', event => {
        event.stopPropagation();
        // 原地进编辑模式：字段编辑器就长在悬浮窗里，不用再跳 ST 设置
        editorMode = !editorMode;

        settings().display.floatOpen = true;

        saveSettingsDebounced();
        renderFloat();
    });

    el.querySelector('.sb-history-menu').addEventListener('click', event => {
        const item = event.target.closest('.sb-history-item');
        if (!item) {
            return;
        }

        const msgId = Number(item.dataset.msgid);
        if (!Number.isFinite(msgId)) {
            return;
        }

        viewMsgId = msgId;
        closeHistoryMenu();
        renderFloat();
    });

    // 角色标签：点名字只看该角色，点「全部」回概览
    el.querySelector('.sb-char-tabs').addEventListener('click', event => {
        const tab = event.target.closest('.sb-char-tab');
        if (!tab) {
            return;
        }

        event.stopPropagation();
        activeChar = tab.dataset.char || null;
        renderFloat();
    });

    applyFloatPosition();
}

/* ---------- 历史快照菜单 ---------- */

function historyMenuElement() {
    return floatElement()?.querySelector('.sb-history-menu') ?? null;
}

function toggleHistoryMenu() {
    const menu = historyMenuElement();
    if (!menu) {
        return;
    }
    if (menu.hidden) {
        openHistoryMenu();
    } else {
        menu.hidden = true;
    }
}

function closeHistoryMenu() {
    const menu = historyMenuElement();
    if (menu) {
        menu.hidden = true;
    }
}

/** 列出聊天里所有带快照的楼层，最新的在最上面 */
function openHistoryMenu() {
    const menu = historyMenuElement();
    if (!menu) {
        return;
    }

    const snapshots = [];

    for (let i = chat.length - 1; i >= 0 && snapshots.length < 30; i -= 1) {
        const data = chat[i]?.extra?.[STORE_KEY];
        if (data && Object.keys(data).length) {
            snapshots.push({ msgId: i, data });
        }
    }

    menu.innerHTML = snapshots.length
        ? snapshots.map(({ msgId, data }) => {
            // data 是 { 角色名: 字段 }，摘要取第一个角色
            const names = Object.keys(data).filter(Boolean);
            const first = data[names[0] ?? ''] || {};
            const bits = [first.time, first.location, first.mood].filter(Boolean).join(' · ');
            const summary = [names.join('、'), bits].filter(Boolean).join(' · ') || '(无摘要)';
            const active = msgId === viewMsgId ? ' is-active' : '';

            return `<div class="sb-history-item${active}" data-msgid="${msgId}">`
                + `<span class="sb-history-num sb-num">#${msgId + 1}</span>`
                + `<span class="sb-history-sum">${esc(summary)}</span>`
                + `</div>`;
        }).join('')
        : '<div class="sb-history-empty">还没有历史快照</div>';

    menu.hidden = false;
}

/* ---------- 悬浮窗拖动 ---------- */

/** 拖动过程状态；null 表示当前没在拖 */
let dragState = null;

/** 判定位移超过这个像素才算拖动，否则当成一次点击 */
const DRAG_THRESHOLD = 4;

function bindFloatDrag(el) {
    const head = el.querySelector('.sb-float-head');

    head.addEventListener('pointerdown', onDragStart);
    head.addEventListener('pointermove', onDragMove);
    head.addEventListener('pointerup', onDragEnd);
    head.addEventListener('pointercancel', onDragEnd);

}

function onDragStart(event) {
    if (event.button !== undefined && event.button !== 0) {
        return;
    }

    // 按钮、角标和历史菜单有各自的行为，不参与拖动
    if (event.target.closest('.sb-tool, .sb-float-badge, .sb-history-menu')) {
        return;
    }

    const el = floatElement();
    if (!el) {
        return;
    }

    const rect = el.getBoundingClientRect();

    dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
    };

    el.classList.add('sb-dragging');

    // 捕获指针，保证拖出头部范围也能继续收到 move / up
    try {
        event.target.setPointerCapture(event.pointerId);
    } catch {
        // 某些浏览器在 pointerdown 阶段不允许捕获，忽略即可
    }
}

function onDragMove(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
    }

    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;

    if (!dragState.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
        return;
    }

    dragState.moved = true;
    setFloatPosition(dragState.left + dx, dragState.top + dy);
}

function onDragEnd(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
    }

    const el = floatElement();
    el?.classList.remove('sb-dragging');

    try {
        event.target.releasePointerCapture?.(event.pointerId);
    } catch {
        // 忽略
    }

    if (dragState.moved && el) {
        // 拖完记住位置，下次打开还在原地
        const rect = el.getBoundingClientRect();
        settings().display.floatPos = {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
        };
        saveSettingsDebounced();
    }

    dragState = null;
}

/** 把悬浮窗摆到指定坐标，并夹在视口内 */
function setFloatPosition(left, top) {
    const el = floatElement();
    if (!el) {
        return;
    }

    const maxLeft = Math.max(0, window.innerWidth - el.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - el.offsetHeight);

    el.style.left = Math.min(Math.max(0, Math.round(left)), maxLeft) + 'px';
    el.style.top = Math.min(Math.max(0, Math.round(top)), maxTop) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
}

/** 按保存的坐标摆放；没有坐标就交给 CSS 的 right/bottom 默认值 */
function applyFloatPosition() {
    const el = floatElement();
    if (!el) {
        return;
    }

    const pos = settings().display.floatPos;

    if (positionFitsViewport(pos)) {
        setFloatPosition(Number(pos.left), Number(pos.top));
    } else {
        el.style.left = '';
        el.style.top = '';
        el.style.right = '';
        el.style.bottom = '';
    }
}

function renderFloat() {
    const el = floatElement();
    const ball = ballElement();
    const s = settings();
    const active = s.enabled && s.display.showFloat;

    // 球常驻（只要功能开着），窗口由球控制显隐。
    // 编辑模式下先藏起来 —— 球是 fixed 且层级最高，很容易压住编辑器的按钮。
    if (ball) {
        ball.hidden = !active || editorMode;
        ball.classList.toggle('sb-ball-active', active && !!s.display.floatOpen && !editorMode);

        // 图标可自定义，改完即时生效
        const iconEl = ball.querySelector('i');
        const want = s.display.ballIcon || 'fa-solid fa-chart-simple';
        if (iconEl && iconEl.className !== want) {
            iconEl.className = want;
        }
    }

    if (!el) {
        return;
    }

    if (!active || !s.display.floatOpen) {
        el.hidden = true;
        return;
    }

    el.hidden = false;
    el.classList.toggle('sb-editing', editorMode);
    el.classList.toggle('sb-history', viewMsgId !== null);
    el.classList.toggle('sb-compact', s.display.density === 'compact');

    // 自定义强调色优先，否则交给 CSS 的主题变量
    if (s.display.accent) {
        el.style.setProperty('--sb-accent', s.display.accent);
    } else {
        el.style.removeProperty('--sb-accent');
    }

    const editorEl = el.querySelector('.sb-float-editor');
    const editing = editorMode;

    if (editorEl) {
        editorEl.hidden = !editing;

        if (editing && !editorRendered) {
            // 只在刚进编辑模式时渲染一次
            renderTemplatesInto(editorEl.querySelector('[data-role="templates"]'));
            renderQuickAddInto(editorEl.querySelector('[data-role="quick"]'));
            renderFieldListInto(editorEl.querySelector('[data-role="list"]'));
            editorRendered = true;
        } else if (!editing) {
            editorRendered = false;
        }
    }

    const bagData = viewMsgId !== null ? (messageData(viewMsgId) || {}) : currentData();

    // 数据结构是 { 角色名: { 字段 } }；单人的角色名是空字符串
    let chars = Object.entries(bagData).filter(([, fields]) => fields && typeof fields === 'object');

    // 选中的角色可能已被淘汰（上限 4），此时回退到全部视图
    if (activeChar && !chars.some(([name]) => name === activeChar)) {
        activeChar = null;
    }

    const multi = chars.length > 1;

    // 角色标签：≥2 人时显示，点名字看单人详情，「全部」是简版概览
    const tabsEl = el.querySelector('.sb-char-tabs');
    if (tabsEl) {
        tabsEl.hidden = !multi || editing;

        if (multi) {
            tabsEl.innerHTML = `<button type="button" class="sb-char-tab${activeChar === null ? ' is-active' : ''}" data-char="">全部</button>`
                + chars.map(([name]) =>
                    `<button type="button" class="sb-char-tab${name === activeChar ? ' is-active' : ''}" data-char="${escAttr(name)}">${esc(name)}</button>`,
                ).join('');
        }
    }

    // 视图过滤：选了角色只看那一个（全字段）；「全部」视图每人只显示勾了简洁条的，防拥挤
    let viewChars = chars;
    const brief = multi && activeChar === null;

    if (multi && activeChar) {
        viewChars = chars.filter(([name]) => name === activeChar);
    }

    const bodyEl = el.querySelector('.sb-float-body');

    if (!editing) {
        const groups = viewChars
            .map(([name, charData]) => {
                let fields = s.fields.filter(field => charData[field.key] !== undefined);

                if (brief) {
                    fields = fields.filter(field => field.inline);
                }

                if (!fields.length) {
                    return '';
                }

                const head = name ? `<div class="sb-char-head">${esc(name)}</div>` : '';
                const items = fields.map(field => itemHtml(field, charData[field.key])).join('');

                return `<div class="sb-char-group">${head}<div class="sb-char-grid">${items}</div></div>`;
            })
            .filter(Boolean)
            .join('');

        bodyEl.innerHTML = groups || '<div class="sb-item sb-item--empty">'
            + '<i class="fa-regular fa-circle-question" aria-hidden="true"></i>'
            + '<span>还没有状态数据。下一次回复产生后会自动填充；</span>'
            + '<span>也可以点 ⚙ 进入编辑模式，先填一份预览。</span>'
            + '</div>';
    }

    const badge = el.querySelector('.sb-float-badge');
    badge.hidden = viewMsgId === null || editing;
    if (viewMsgId !== null && !editing) {
        badge.textContent = `回看 #${viewMsgId + 1} · 返回`;
    }

    // 内容渲染完再定位，否则量不到正确高度
    applyBallPosition();

    // 窗口：有落在屏幕内的坐标就用自己的，否则贴着球
    if (positionFitsViewport(s.display.floatPos)) {
        applyFloatPosition();
    } else {
        windowAnchorToBall();
    }
}

/* ============================================================
   刷新调度
   ============================================================ */

function refreshAll() {
    mountBall();
    mountFloat();
    renderFloat();
    renderAllInline();
}

function scheduleRefresh(delay = 60) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshAll, delay);
}

/* ============================================================
   提示词注入
   ============================================================ */

/** 组装最终注入文本 */
function buildPrompt() {
    const s = settings();
    const template = String(s.prompt || DEFAULT_PROMPT);
    const fields = describeFields(s.fields);

    if (!fields) {
        return '';
    }

    let text = template
        .replace(/\{\{fields\}\}/g, fields)
        .replace(/\{\{example\}\}/g, buildExample(s.fields));

    // 用户把占位符删了也要把字段清单带上，否则模型不知道输出什么
    if (!template.includes('{{fields}}')) {
        text += `\n\n字段清单：\n${fields}`;
    }

    return text.trim();
}

/**
 * 刷新注入内容。
 *
 * 用 IN_CHAT + depth 插在对话历史里，比塞进系统提示更稳：
 * 系统提示常被用户预设大段覆盖，越靠后的上下文权重越高。
 */
function injectPrompt() {
    const s = settings();

    if (!s.enabled) {
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.NONE, 0);
        return;
    }

    setExtensionPrompt(
        PROMPT_KEY,
        buildPrompt(),
        extension_prompt_types.IN_CHAT,
        Math.max(0, Number(s.inject.depth) || 0),
        false,
        Number(s.inject.role) || extension_prompt_roles.SYSTEM,
    );
}

/* ============================================================
   设置面板
   ============================================================ */

/**
 * 从悬浮窗直达设置面板。
 *
 * 默认路径要「顶栏 → 扩展设置 → 找到状态栏 → 展开」，三层菜单；
 * 这里一步到位：关窗 → 展开 ST 抽屉 → 展开本扩展面板 → 滚动 + 高亮。
 */
function openSettingsFromFloat() {
    settings().display.floatOpen = false;
    saveSettingsDebounced();
    renderFloat();

    const drawer = document.getElementById('rm_extensions_block');
    const drawerClosed = !drawer || (!drawer.classList.contains('openDrawer') && drawer.offsetParent === null);

    if (drawerClosed) {
        document.getElementById('extensions-settings-button')?.click();
    }

    const panel = document.getElementById('sb-settings');

    if (!panel) {
        notify('warning', '设置面板还没加载好，稍等一下再点');
        return;
    }

    panel.classList.add('sb-open');

    // 等抽屉的展开动画走完，否则滚动位置会算偏
    setTimeout(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        panel.classList.add('sb-flash');
        setTimeout(() => panel.classList.remove('sb-flash'), 1500);
    }, 280);
}

function escAttr(value) {
    return esc(value);
}

function fieldRowHtml(field, index, total) {
    const typeOptions = [
        ['text', '文本'],
        ['number', '数字'],
        ['bar', '进度条'],
        ['tags', '标签'],
    ]
        .map(([value, label]) => `<option value="${value}"${field.type === value ? ' selected' : ''}>${label}</option>`)
        .join('');

    // 主行只放最常改的两项：显示名 + 类型。
    // key / 上限 / 图标 / 简洁条收进「更多」，日常不用碰。
    return `
<div class="sb-field-row" data-idx="${index}">
    <div class="sb-field-line">
        <input class="sb-inp sb-label" value="${escAttr(field.label)}" placeholder="显示名，如 灵力">
        <select class="sb-inp sb-type" title="值类型">${typeOptions}</select>
        <div class="sb-row-tools">
            <button type="button" class="sb-btn" data-act="more" title="更多设置（键名 / 上限 / 图标）">⋯</button>
            <button type="button" class="sb-btn" data-act="up" title="上移"${index === 0 ? ' disabled' : ''}>↑</button>
            <button type="button" class="sb-btn" data-act="down" title="下移"${index === total - 1 ? ' disabled' : ''}>↓</button>
            <button type="button" class="sb-btn sb-btn--danger" data-act="del" title="删除">✕</button>
        </div>
    </div>
    <div class="sb-field-advanced" hidden>
        <label class="sb-adv-item">键名
            <input class="sb-inp sb-key" value="${escAttr(field.key)}" title="模型输出的 JSON 键名，改动后已有状态不会迁移">
        </label>
        <label class="sb-adv-item">上限
            <input class="sb-inp sb-max" type="number" min="1" step="1" value="${field.max || 100}">
        </label>
        <label class="sb-adv-item">图标
            <input class="sb-inp sb-icon" value="${escAttr(field.icon || '')}" placeholder="fa-solid fa-heart">
            <button type="button" class="sb-btn sb-icon-pick" data-act="icon" title="从图标库里选">
                <i class="${escAttr(field.icon || 'fa-regular fa-square')}" aria-hidden="true"></i>
            </button>
        </label>
        <label class="sb-adv-item">动态
            <select class="sb-inp sb-dynamic" title="跟随心情：图标按当前值自动换表情">
                <option value="">固定</option>
                <option value="mood"${field.dynamic === 'mood' ? ' selected' : ''}>跟随心情</option>
            </select>
        </label>
        <label class="sb-chk"><input type="checkbox" class="sb-inline-chk"${field.inline ? ' checked' : ''}> 显示在简洁条</label>
        <label class="sb-chk" title="值里写「效果(回合数)」，每收到一条回复自动减一，归零消失"><input type="checkbox" class="sb-ttl-chk"${field.ttl ? ' checked' : ''}> 时效倒数</label>
    </div>
</div>`;
}

function panelHtml() {
    return `
<div class="inline-drawer sb-settings" id="sb-settings">
    <div class="inline-drawer-toggle inline-drawer-header sb-toggle">
        <b>状态栏</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <label class="sb-chk sb-chk--block"><input type="checkbox" id="sb-enabled"> 启用状态栏</label>
        <label class="sb-chk sb-chk--block"><input type="checkbox" id="sb-show-inline"> 在每条回复末尾显示简洁条</label>
        <label class="sb-chk sb-chk--block"><input type="checkbox" id="sb-inline-latest"> 只在最新一条回复末尾显示（历史楼层不带）</label>
        <label class="sb-chk sb-chk--block"><input type="checkbox" id="sb-show-float"> 显示悬浮球（点击开关悬浮窗）</label>
        <label class="sb-chk sb-chk--block"><input type="checkbox" id="sb-strip"> 从正文里剥离 &lt;status&gt; 区块</label>
        <label class="sb-chk sb-chk--block"><input type="checkbox" id="sb-auto-fields"> 自动识别新字段（模型多给的键自动建成字段）</label>
        <div class="sb-row" style="margin-top:-2px">
            <button type="button" class="sb-btn" id="sb-reset-pos">重置球 / 窗口位置</button>
        </div>

        <span class="sb-sublabel">字段</span>
        <div class="sb-hint">
            字段的添加和编辑都在<b>悬浮窗的 ⚙ 里</b>：点按钮加字段、改「显示名」就能用。
            这里负责提示词、注入方式这些全局项。
        </div>

        <span class="sb-sublabel">提示词</span>
        <div class="sb-hint">
            <code>{{fields}}</code> 会替换成字段清单，<code>{{example}}</code> 会替换成示例 JSON。
            模型不听话时优先微调这里，不同模型对格式的遵守度差别很大。
        </div>
        <textarea id="sb-prompt" spellcheck="false"></textarea>
        <div class="sb-row" style="margin-top:6px">
            <label class="sb-chk">注入深度
                <input class="sb-inp" id="sb-depth" type="number" min="0" max="20" step="1" style="width:62px">
            </label>
            <label class="sb-chk">角色
                <select class="sb-inp" id="sb-role" style="width:88px">
                    <option value="0">系统</option>
                    <option value="1">用户</option>
                    <option value="2">助手</option>
                </select>
            </label>
            <label class="sb-chk">密度
                <select class="sb-inp" id="sb-density" style="width:76px">
                    <option value="normal">标准</option>
                    <option value="compact">紧凑</option>
                </select>
            </label>
            <button type="button" class="sb-btn" id="sb-prompt-reset">恢复默认提示词</button>
        </div>
        <div class="sb-row">
            <label class="sb-chk" style="flex:1 1 160px">强调色
                <input class="sb-inp" id="sb-accent" placeholder="留空跟随主题" style="flex:1 1 auto">
            </label>
        </div>
        <div class="sb-row">
            <label class="sb-chk" style="flex:1 1 200px">悬浮球图标
                <input class="sb-inp" id="sb-ball-icon" placeholder="fa-solid fa-chart-simple" style="flex:1 1 auto">
            </label>
        </div>

        <div class="sb-transfer">
            <span class="sb-sublabel" style="margin-top:0">配置导入 / 导出（JSON）</span>
            <div class="sb-hint">
                导出的 JSON 含字段定义、提示词、注入与显示设置，不含聊天记录。
                换设备时导入同一份即可完整还原；手机上直接粘贴文本比选文件方便。
            </div>
            <div class="sb-row">
                <button type="button" class="sb-btn sb-btn--primary" id="sb-export">下载 JSON</button>
                <button type="button" class="sb-btn" id="sb-copy">复制 JSON</button>
                <button type="button" class="sb-btn" id="sb-import-file-btn">选择文件导入</button>
                <input type="file" id="sb-import-file" accept=".json,application/json" hidden>
            </div>
            <textarea id="sb-import-text" spellcheck="false" placeholder="把 JSON 粘贴到这里，再点下面的按钮"></textarea>
            <div class="sb-row" style="margin-top:6px">
                <button type="button" class="sb-btn sb-btn--primary" id="sb-import-apply">从文本导入</button>
            </div>
        </div>
    </div>
</div>`;
}

/** 把字段列表渲染进指定容器（悬浮窗编辑模式用） */
function renderFieldListInto(container) {
    const fields = settings().fields;
    container.innerHTML = fields.map((field, index) => fieldRowHtml(field, index, fields.length)).join('');
}

/** 常用字段按钮：已有的打勾并禁用 */
function renderQuickAddInto(container) {
    const keys = new Set(settings().fields.map(field => field.key));

    container.innerHTML = QUICK_FIELDS.map(field => {
        const has = keys.has(field.key);
        return `<button type="button" class="sb-chipbtn" data-preset="${escAttr(field.key)}"${has ? ' disabled' : ''}>`
            + `${has ? '✓ ' : '+ '}${esc(field.label)}</button>`;
    }).join('');
}

/** 方案按钮 */
function renderTemplatesInto(container) {
    container.innerHTML = FIELD_TEMPLATES.map(tpl =>
        `<button type="button" class="sb-tpl" data-tpl="${escAttr(tpl.id)}" title="${escAttr(tpl.desc)}">${esc(tpl.name)}</button>`,
    ).join('');
}

/**
 * 套用方案。
 * 已有字段时问一句：确定 = 整套替换，取消 = 只补缺失的。
 */
function applyTemplate(id, root) {
    const tpl = FIELD_TEMPLATES.find(item => item.id === id);
    if (!tpl) {
        return;
    }

    const current = settings().fields;
    const missing = tpl.fields.filter(field => !current.some(have => have.key === field.key));

    let fields;

    if (!current.length) {
        fields = structuredClone(tpl.fields);
    } else if (!missing.length) {
        notify('info', `「${tpl.name}」里的字段都已经在表里了`);
        return;
    } else {
        const replace = window.confirm(
            `套用「${tpl.name}」方案（${tpl.desc}）？\n\n`
            + `确定：替换当前 ${current.length} 个字段\n`
            + `取消：只把缺少的 ${missing.length} 个追加进来`,
        );

        fields = replace
            ? structuredClone(tpl.fields)
            : [...current, ...missing.map(field => ({ ...field }))];
    }

    settings().fields = fields;
    saveSettingsDebounced();
    refreshFieldUI(root);
    scheduleRefresh(120);
    notify('success', `已套用「${tpl.name}」方案`);
}

/** 当前正在选图标的字段下标；-1 表示选择器没开 */
let iconPickerIndex = -1;

/** 打开图标选择器，按语义分组列出 */
function openIconPicker(index) {
    const picker = floatElement()?.querySelector('.sb-icon-picker');
    const field = settings().fields[index];

    if (!picker || !field) {
        return;
    }

    iconPickerIndex = index;
    const current = field.icon || '';
    const grid = picker.querySelector('.sb-icon-grid');

    const cell = icon => {
        const active = icon === current ? ' is-active' : '';
        return `<button type="button" class="sb-icon-cell${active}" data-icon="${escAttr(icon)}" title="${escAttr(icon)}">`
            + `<i class="${escAttr(icon)}" aria-hidden="true"></i></button>`;
    };

    grid.innerHTML = ICON_GROUPS.map(group => {
        const cells = group.icons.map(cell).join('');
        return `<div class="sb-icon-group">`
            + `<div class="sb-icon-group-title">${esc(group.name)}</div>`
            + `<div class="sb-icon-grid-inner">${cells}</div>`
            + `</div>`;
    }).join('')
        + '<div class="sb-icon-group"><div class="sb-icon-group-title">清除</div>'
        + '<div class="sb-icon-grid-inner">'
        + '<button type="button" class="sb-icon-cell sb-icon-none" data-icon="" title="不用图标">∅</button>'
        + '</div></div>';

    picker.hidden = false;
}

function closeIconPicker() {
    const picker = floatElement()?.querySelector('.sb-icon-picker');
    if (picker) {
        picker.hidden = true;
    }
    iconPickerIndex = -1;
}

/**
 * 字段编辑器的全部交互（事件委托，挂在编辑器容器上）。
 * 两个数据出口：settings().fields（保存）和 refreshFieldUI（重绘）。
 */
function bindFieldEvents(root) {
    root.addEventListener('click', event => {
        // 方案按钮
        const tplBtn = event.target.closest('.sb-tpl[data-tpl]');
        if (tplBtn) {
            applyTemplate(tplBtn.dataset.tpl, root);
            return;
        }

        // 快选按钮
        const quickBtn = event.target.closest('.sb-chipbtn[data-preset]');
        if (quickBtn) {
            if (quickBtn.disabled) {
                return;
            }

            const preset = QUICK_FIELDS.find(field => field.key === quickBtn.dataset.preset);
            if (!preset) {
                return;
            }

            settings().fields.push({ ...preset });
            saveSettingsDebounced();
            refreshFieldUI(root);
            scheduleRefresh(120);
            notify('success', `已添加「${preset.label}」`);
            return;
        }

        const button = event.target.closest('button[data-act]');
        if (!button) {
            return;
        }

        const row = button.closest('.sb-field-row');
        const index = Number(row?.dataset.idx);
        const fields = settings().fields;
        const action = button.dataset.act;

        switch (action) {
            case 'more': {
                // 只切折叠，不重绘 —— 重绘会把这个展开状态丢掉
                const adv = row.querySelector('.sb-field-advanced');
                if (adv) {
                    adv.hidden = !adv.hidden;
                }
                return;
            }
            case 'up': {
                if (index > 0) {
                    [fields[index - 1], fields[index]] = [fields[index], fields[index - 1]];
                    saveSettingsDebounced();
                    refreshFieldUI(root);
                    scheduleRefresh(120);
                }
                return;
            }
            case 'down': {
                if (index < fields.length - 1) {
                    [fields[index + 1], fields[index]] = [fields[index], fields[index + 1]];
                    saveSettingsDebounced();
                    refreshFieldUI(root);
                    scheduleRefresh(120);
                }
                return;
            }
            case 'del': {
                if (fields.length <= 1) {
                    notify('warning', '至少保留一个字段');
                    return;
                }
                fields.splice(index, 1);
                saveSettingsDebounced();
                refreshFieldUI(root);
                scheduleRefresh(120);
                return;
            }
            case 'icon': {
                openIconPicker(index);
                return;
            }
            case 'addfield': {
                // 任意自定义字段：带一套默认值建好，自动展开高级项并聚焦显示名
                const list = settings().fields;
                list.push({
                    key: `custom${list.length + 1}`,
                    label: `自定义${list.length + 1}`,
                    type: 'text',
                    icon: '',
                    max: 100,
                    inline: false,
                });
                saveSettingsDebounced();
                refreshFieldUI(root);

                const rows = root.querySelectorAll('.sb-field-row');
                const lastRow = rows[rows.length - 1];
                const adv = lastRow?.querySelector('.sb-field-advanced');
                if (adv) {
                    adv.hidden = false;
                }
                lastRow?.querySelector('.sb-label')?.focus();

                scheduleRefresh(120);
                notify('info', '已添加，改个显示名就能用');
                return;
            }
            case 'done': {
                editorMode = false;
                renderFloat();
                notify('success', '字段配置已保存');
                return;
            }
            case 'preview': {
                editorMode = false;
                previewData();
                return;
            }
            case 'adv': {
                openSettingsFromFloat();
                return;
            }
            case 'reset': {
                if (!window.confirm('恢复默认字段与提示词？当前配置会被覆盖，聊天里的状态数据不受影响。')) {
                    return;
                }
                const s = settings();
                s.fields = structuredClone(DEFAULT_FIELDS);
                s.prompt = DEFAULT_PROMPT;
                s.inject = structuredClone(DEFAULT_INJECT);
                saveSettingsDebounced();
                refreshFieldUI(root);
                scheduleRefresh(120);
                notify('success', '已恢复默认配置');
                return;
            }
            default:
                return;
        }
    });

    root.addEventListener('input', event => {
        const row = event.target.closest('.sb-field-row');
        if (!row) {
            return;
        }

        const field = settings().fields[Number(row.dataset.idx)];
        if (!field) {
            return;
        }

        const target = event.target;

        if (target.classList.contains('sb-label')) {
            field.label = target.value;
            saveSettingsDebounced();
            scheduleRefresh(120);
        } else if (target.classList.contains('sb-key')) {
            field.key = target.value.trim();
            saveSettingsDebounced();
        } else if (target.classList.contains('sb-max')) {
            field.max = Math.max(1, Number(target.value) || 100);
            saveSettingsDebounced();
        } else if (target.classList.contains('sb-icon')) {
            field.icon = target.value.trim();
            saveSettingsDebounced();
            scheduleRefresh(120);
        }
    });

    root.addEventListener('change', event => {
        const row = event.target.closest('.sb-field-row');
        if (!row) {
            return;
        }

        const field = settings().fields[Number(row.dataset.idx)];
        if (!field) {
            return;
        }

        if (event.target.classList.contains('sb-type')) {
            field.type = event.target.value;
            saveSettingsDebounced();
            scheduleRefresh(120);
        } else if (event.target.classList.contains('sb-dynamic')) {
            field.dynamic = event.target.value === 'mood' ? 'mood' : '';
            saveSettingsDebounced();
            scheduleRefresh(120);
        } else if (event.target.classList.contains('sb-ttl-chk')) {
            field.ttl = event.target.checked;
            saveSettingsDebounced();
            scheduleRefresh(120);
        } else if (event.target.classList.contains('sb-inline-chk')) {
            field.inline = event.target.checked;
            saveSettingsDebounced();
            scheduleRefresh(120);
        }
    });
}

/** 字段编辑器内容重绘（编辑模式下） */
function refreshFieldUI(root) {
    const list = root.querySelector('[data-role="list"]');
    const quick = root.querySelector('[data-role="quick"]');

    if (list) {
        renderFieldListInto(list);
    }
    if (quick) {
        renderQuickAddInto(quick);
    }
}

function setChecked(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.checked = !!value;
    }
}

function syncControls() {
    const s = settings();

    setChecked('sb-enabled', s.enabled);
    setChecked('sb-show-inline', s.display.showInline);
    setChecked('sb-inline-latest', s.display.inlineLatestOnly);
    setChecked('sb-show-float', s.display.showFloat);
    setChecked('sb-strip', s.inject.strip);
    setChecked('sb-auto-fields', s.display.autoAddFields);

    const promptEl = document.getElementById('sb-prompt');
    if (promptEl) {
        promptEl.value = s.prompt;
    }

    const depthEl = document.getElementById('sb-depth');
    if (depthEl) {
        depthEl.value = String(s.inject.depth);
    }

    const roleEl = document.getElementById('sb-role');
    if (roleEl) {
        roleEl.value = String(s.inject.role);
    }

    const densityEl = document.getElementById('sb-density');
    if (densityEl) {
        densityEl.value = s.display.density;
    }

    const accentEl = document.getElementById('sb-accent');
    if (accentEl) {
        accentEl.value = s.display.accent;
    }

    const ballIconEl = document.getElementById('sb-ball-icon');
    if (ballIconEl) {
        ballIconEl.value = s.display.ballIcon || '';
    }
}

function notify(kind, message) {
    const toast = window.toastr;
    if (toast && typeof toast[kind] === 'function') {
        toast[kind](message, '状态栏');
    } else {
        console.log('[status-bar]', message);
    }
}

function bindPanel(root) {
    // 折叠自己接管，不依赖 ST 对动态节点的事件绑定
    root.querySelector('.sb-toggle').addEventListener('click', () => {
        root.classList.toggle('sb-open');
    });

    const flags = [
        ['sb-enabled', () => settings().enabled, value => { settings().enabled = value; }],
        ['sb-show-inline', () => settings().display.showInline, value => { settings().display.showInline = value; }],
        ['sb-inline-latest', () => settings().display.inlineLatestOnly, value => { settings().display.inlineLatestOnly = value; }],
        ['sb-show-float', () => settings().display.showFloat, value => { settings().display.showFloat = value; }],
        ['sb-strip', () => settings().inject.strip, value => { settings().inject.strip = value; }],
        ['sb-auto-fields', () => settings().display.autoAddFields, value => { settings().display.autoAddFields = value; }],
    ];

    for (const [id, , apply] of flags) {
        const el = document.getElementById(id);
        if (!el) {
            continue;
        }
        el.addEventListener('change', () => {
            apply(el.checked);
            saveSettingsDebounced();
            scheduleRefresh();
        });
    }

    document.getElementById('sb-prompt').addEventListener('input', event => {
        settings().prompt = event.target.value;
        saveSettingsDebounced();
    });

    document.getElementById('sb-depth').addEventListener('input', event => {
        settings().inject.depth = Math.max(0, Math.min(20, Number(event.target.value) || 0));
        saveSettingsDebounced();
    });

    document.getElementById('sb-role').addEventListener('change', event => {
        settings().inject.role = Number(event.target.value) || 0;
        saveSettingsDebounced();
    });

    document.getElementById('sb-density').addEventListener('change', event => {
        settings().display.density = event.target.value;
        saveSettingsDebounced();
        scheduleRefresh();
    });

    document.getElementById('sb-accent').addEventListener('input', event => {
        settings().display.accent = event.target.value.trim();
        saveSettingsDebounced();
        scheduleRefresh(120);
    });

    document.getElementById('sb-ball-icon').addEventListener('input', event => {
        settings().display.ballIcon = event.target.value.trim() || 'fa-solid fa-chart-simple';
        saveSettingsDebounced();
        scheduleRefresh(120);
    });

    document.getElementById('sb-prompt-reset').addEventListener('click', () => {
        settings().prompt = DEFAULT_PROMPT;
        saveSettingsDebounced();
        syncControls();
        notify('success', '提示词已恢复默认');
    });

    document.getElementById('sb-reset-pos').addEventListener('click', () => {
        const s = settings();
        s.display.floatPos = null;
        s.display.ballPos = null;
        saveSettingsDebounced();
        applyBallPosition();
        renderFloat();
        notify('success', '悬浮球与悬浮窗已回到默认位置');
    });

    bindTransfer();
}

/* ============================================================
   预览
   ============================================================ */

function previewData() {
    const s = settings();
    const demo = {};

    for (const field of s.fields) {
        if (!field.key) {
            continue;
        }

        if (field.type === 'bar' || field.type === 'number') {
            demo[field.key] = Math.round((field.max || 100) * 0.62);
        } else if (field.type === 'tags') {
            demo[field.key] = ['示例一', '示例二'];
        } else {
            demo[field.key] = SAMPLE_VALUES[field.key] || '示例';
        }
    }

    viewMsgId = null;

    const bag = store(true);
    if (bag) {
        // 预览用单人结构，角色名为空
        bag.current = { '': demo };
        void saveMetadata();
    }

    renderFloat();
    notify('info', '已写入示例数据，固定面板可查看效果');
}

/* ============================================================
   配置导入 / 导出
   ============================================================ */

/** 组装对外导出的完整配置 */
function buildConfig() {
    const s = settings();

    return {
        $format: CONFIG_FORMAT,
        $version: CONFIG_VERSION,
        $note: 'SillyTavern 状态栏配置：字段定义 + 提示词 + 显示设置，不含聊天记录。换设备导入此文件即可完整还原。',
        name: s.name,
        fields: s.fields.map(field => ({
            key: field.key,
            label: field.label,
            type: field.type,
            icon: field.icon,
            max: field.max,
            inline: field.inline,
            dynamic: field.dynamic || '',
        })),
        prompt: s.prompt,
        inject: {
            depth: s.inject.depth,
            role: s.inject.role,
            strip: s.inject.strip,
        },
        display: {
            showInline: s.display.showInline,
            inlineLatestOnly: s.display.inlineLatestOnly,
            showFloat: s.display.showFloat,
            ballIcon: s.display.ballIcon,
            accent: s.display.accent,
            density: s.display.density,
            autoAddFields: s.display.autoAddFields,
            floatPos: s.display.floatPos ?? null,
            ballPos: s.display.ballPos ?? null,
        },
    };
}

function configText() {
    return JSON.stringify(buildConfig(), null, 2);
}

function downloadConfig() {
    const blob = new Blob([configText()], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.download = `status-bar-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('success', '配置已导出');
}

/** 兼容非安全上下文：手机走局域网 IP 访问时 navigator.clipboard 不可用 */
function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();

    try {
        document.execCommand('copy');
    } catch {
        // 失败交给上层提示
    }

    area.remove();
}

async function copyConfig() {
    const text = configText();

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            legacyCopy(text);
        }
        notify('success', 'JSON 已复制到剪贴板');
    } catch {
        legacyCopy(text);
        notify('warning', '已尝试复制，请到粘贴板确认');
    }
}

/**
 * 应用配置。
 *
 * 容错范围：完整导出 / 只有 fields+prompt 的简版 / 裸字段数组。
 * 单条字段坏掉只跳过那一条，不影响其它。
 */
function applyConfig(raw, options = {}) {
    const parsed = normalizeConfig(raw);

    if (!parsed) {
        notify('error', '配置里没有可用的 fields，检查一下是否贴错了内容');
        return false;
    }

    const s = settings();
    s.fields = parsed.fields;

    if (parsed.prompt) {
        s.prompt = parsed.prompt;
    }

    s.inject = parsed.inject;

    if (options.withDisplay !== false) {
        // 坐标跟着配置走：文件里带了就用导入的（手机/PC 同步布局），
        // 没带（旧配置或别人分享的）就保留本机位置
        s.display = {
            ...s.display,
            ...parsed.display,
            floatPos: parsed.display.floatPos ?? s.display.floatPos,
            ballPos: parsed.display.ballPos ?? s.display.ballPos,
        };
    }

    if (parsed.name) {
        s.name = parsed.name;
    }

    saveSettingsDebounced();
    syncControls();

    // 导入后如果编辑器正开着，把列表也换掉
    if (editorMode) {
        const editorRoot = floatElement()?.querySelector('.sb-float-editor');
        if (editorRoot) {
            refreshFieldUI(editorRoot);
        }
    }

    scheduleRefresh(0);
    notify('success', `已导入 ${parsed.fields.length} 个字段`);

    return true;
}

function readFileInto(file) {
    if (!file) {
        return;
    }

    const reader = new FileReader();

    reader.onload = () => {
        if (applyConfig(String(reader.result ?? ''))) {
            const area = document.getElementById('sb-import-text');
            if (area) {
                area.value = '';
            }
        }
    };

    reader.onerror = () => notify('error', '文件读取失败');
    reader.readAsText(file, 'utf-8');
}

function bindTransfer() {
    document.getElementById('sb-export').addEventListener('click', downloadConfig);
    document.getElementById('sb-copy').addEventListener('click', () => void copyConfig());

    const fileInput = document.getElementById('sb-import-file');

    document.getElementById('sb-import-file-btn').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
        readFileInto(fileInput.files?.[0]);
        fileInput.value = '';
    });

    document.getElementById('sb-import-apply').addEventListener('click', () => {
        const area = document.getElementById('sb-import-text');
        const text = String(area?.value ?? '').trim();

        if (!text) {
            notify('warning', '先粘贴 JSON 内容');
            return;
        }

        if (applyConfig(text)) {
            area.value = '';
        }
    });
}

/* ============================================================
   事件
   ============================================================ */

/**
 * 新消息到达。
 *
 * MESSAGE_RECEIVED 在 addOneMessage 之前触发，此时改 msg.mes 是安全的：
 * 紧接着的渲染只会画出剥离后的正文，不会闪一下 JSON。
 */
async function onMessageReceived(msgId, type) {
    const msg = chat[msgId];
    if (!msg || msg.is_user || !settings().enabled) {
        return;
    }

    // 重新生成 swipe 时旧快照必须先清掉，否则解析失败会残留上次的值
    if (type === 'swipe' && msg.extra) {
        delete msg.extra[STORE_KEY];
    }

    const before = msg.mes;
    const parsed = ingest(msg, settings().inject.strip);

    // 流式模式下这条事件在 DOM 已经画出原文之后才来：
    // strip 改了 mes 但界面不会自己重画，得手动刷一遍正文
    if (parsed && before !== msg.mes) {
        const textEl = document.querySelector(`#chat .mes[mesid="${msgId}"] .mes_text`);

        if (textEl) {
            textEl.innerHTML = messageFormatting(msg.mes, msg.name, msg.is_system, msg.is_user, msgId);
        }
    }

    if (!parsed) {
        if (msg.extra) {
            delete msg.extra[STORE_KEY];
        }
        await recomputeCurrent();
        renderFloat();
        return;
    }

    await commit(parsed, msgId);
    // 不赌 RENDERED 事件的先后：收到消息就立刻把简洁条对齐
    renderAllInline();
    renderFloat();
}

/**
 * 消息渲染完成。
 *
 * 兜两类漏网场景：
 *   1. 流式输出 —— MESSAGE_RECEIVED 在流式路径上不会触发
 *   2. 历史聊天加载 —— 老消息直接渲染，没有接收事件
 * 两种情况下 <status> 都还留在正文里，需要当场剥掉并重绘正文。
 */
function onMessageRendered(msgId) {
    const msg = chat[msgId];
    if (!msg || msg.is_user || !settings().enabled) {
        return;
    }

    const s = settings();

    if (s.inject.strip && extractBlock(msg.mes)) {
        const before = msg.mes;
        const parsed = ingest(msg, true);

        if (parsed) {
            if (before !== msg.mes) {
                const textEl = document.querySelector(`#chat .mes[mesid="${msgId}"] .mes_text`);
                if (textEl) {
                    textEl.innerHTML = messageFormatting(msg.mes, msg.name, false, false, msgId);
                }
            }

            // 只有最后一条能改写「当前状态」，
            // 否则加载历史会把状态一路覆盖成中间某条的值
            if (msgId === chat.length - 1) {
                void commit(parsed, msgId);
            }
        } else if (msg.extra?.[STORE_KEY]) {
            // 有块但解析不出来：旧快照留着只会误导，清掉并重算
            delete msg.extra[STORE_KEY];
            void recomputeCurrent();
        }
    }

    // 用全量渲染而不是只画这一条：
    // 「只显示最新」模式下，新消息到达必须把上一条的简洁条撤掉，
    // 否则历史楼层会残留一排状态。
    renderAllInline();
    renderFloat();
}

/** 手动编辑消息后重新解析（用户可能自己改了数值） */
async function onMessageEdited(msgId) {
    const msg = chat[msgId];
    if (!msg || msg.is_user || !settings().enabled) {
        return;
    }

    const s = settings();
    const before = msg.mes;
    const parsed = ingest(msg, s.inject.strip);

    if (parsed) {
        if (before !== msg.mes) {
            const textEl = document.querySelector(`#chat .mes[mesid="${msgId}"] .mes_text`);
            if (textEl) {
                textEl.innerHTML = messageFormatting(msg.mes, msg.name, false, false, msgId);
            }
        }

        if (msgId === chat.length - 1) {
            void commit(parsed, msgId);
        }
    } else if (msg.extra) {
        // 手动改成了不含状态块的内容：这条的快照要作废，当前态跟着重算
        delete msg.extra[STORE_KEY];
        await recomputeCurrent();
    }

    renderInline(msgId);
    renderFloat();
}

/** 切换 swipe：换到不含状态块的分支时清掉这条的快照 */
async function onMessageSwiped(msgId) {
    const msg = chat[msgId];
    if (!msg || msg.is_user || !settings().enabled) {
        return;
    }

    if (!extractBlock(msg.mes)) {
        if (msg.extra) {
            delete msg.extra[STORE_KEY];
        }
        // 当前分支没有状态，重算到上一条有效快照
        await recomputeCurrent();
        renderInline(msgId);
        renderFloat();
        return;
    }

    onMessageEdited(msgId);
}

function onChatChanged() {
    viewMsgId = null;
    scheduleRefresh(120);
}

async function onMessageDeleted() {
    viewMsgId = null;
    // 删掉的可能是当前状态所在那条，重算到剩下的最后一条
    await recomputeCurrent();
    // 索引会整体前移，已渲染的简洁条必须按新索引重画
    scheduleRefresh(120);
}

/** 点击消息末尾的简洁条：面板切到该条的快照 */
function onDocumentClick(event) {
    // 点了菜单和按钮以外的区域：收起历史菜单 / 图标选择器
    const menu = historyMenuElement();
    if (menu && !menu.hidden && !event.target.closest('.sb-history-menu, .sb-tool[data-act="history"]')) {
        menu.hidden = true;
    }

    const picker = floatElement()?.querySelector('.sb-icon-picker');
    if (picker && !picker.hidden && !event.target.closest('.sb-icon-picker, .sb-icon-pick')) {
        closeIconPicker();
    }

    const inline = event.target.closest('#chat .sb-inline');
    if (!inline) {
        return;
    }

    const msgId = Number(inline.dataset.mesid);
    if (!Number.isFinite(msgId)) {
        return;
    }

    const s = settings();

    // 窗口没开时点简洁条，顺手把窗口打开，否则用户看不到切换结果
    if (!s.display.floatOpen) {
        s.display.floatOpen = true;
        saveSettingsDebounced();
    }

    if (viewMsgId === msgId) {
        viewMsgId = null;
    } else {
        viewMsgId = msgId;
    }

    renderFloat();
}

function bindEvents() {
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // 每次生成前重刷注入：字段可能刚被改过，chat 也可能刚切换
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, injectPrompt);

    // 生成期间悬浮窗显示等待提示，避免被误读成「状态没变」。
    // dryRun（预检）不算真的生成。
    eventSource.on(event_types.GENERATION_STARTED, (type, options, dryRun) => {
        if (dryRun) {
            return;
        }
        generating = true;
        renderFloat();
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        generating = false;
        renderFloat();
    });

    document.addEventListener('click', onDocumentClick);
    window.addEventListener('resize', () => scheduleRefresh(160));

    // Esc：先关弹层（图标选择器 / 历史菜单），再关悬浮窗
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') {
            return;
        }

        const picker = floatElement()?.querySelector('.sb-icon-picker');
        if (picker && !picker.hidden) {
            closeIconPicker();
            return;
        }

        const menu = historyMenuElement();
        if (menu && !menu.hidden) {
            menu.hidden = true;
            return;
        }

        if (settings().display.floatOpen) {
            settings().display.floatOpen = false;
            saveSettingsDebounced();
            renderFloat();
        }
    });
}

/* ============================================================
   启动
   ============================================================ */

/** 等一个元素出现，已在则立即返回 */
function waitFor(selector, timeout = 6000) {
    const existing = document.querySelector(selector);
    if (existing) {
        return Promise.resolve(existing);
    }

    return new Promise(resolve => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            const el = document.querySelector(selector);

            if (el || Date.now() - startedAt > timeout) {
                clearInterval(timer);
                resolve(el || null);
            }
        }, 200);
    });
}

function buildSettingsPanel() {
    if (document.getElementById('sb-settings')) {
        return;
    }

    const host = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');

    if (!host) {
        return;
    }

    const holder = document.createElement('div');
    holder.innerHTML = panelHtml().trim();
    host.appendChild(holder.firstElementChild);

    bindPanel(document.getElementById('sb-settings'));
    syncControls();
}

async function boot() {
    // 启动时做一次整体规范化：坏字段、重复 key 在这里清掉
    const s = settings();
    s.fields = normalizeFieldList(s.fields);

    if (!s.fields.length) {
        s.fields = structuredClone(DEFAULT_FIELDS);
    }

    saveSettingsDebounced();
    bindEvents();

    await waitFor('#extensions_settings2');

    buildSettingsPanel();
    mountFloat();
    refreshAll();
    injectPrompt();
}

// ST 以 module 方式加载扩展，此时 document 通常已就绪；兜一下极早期加载的情况
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
} else {
    void boot();
}
