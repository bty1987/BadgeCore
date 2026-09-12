/**
 * BadgeCore 演示数据填充（参照对标产品实拍数据结构，幂等可重复执行）
 * 用法: node seed-demo.js [DB_FILE]
 * 数据范围：沟通配置 14 域（对照 evidence 原版截图逐条）+ 客户/部门/员工 + 1 条完整演示沟通
 */
const { openDb } = require('./db');

const db = openDb(process.argv[2] || process.env.DB_FILE || require('path').join(__dirname, 'data', 'badgecore.db'));
const now = new Date().toISOString();

// ---------- 轻量迁移（旧库 users 缺 dept_id） ----------
try { db.exec('ALTER TABLE users ADD COLUMN dept_id INTEGER'); console.log('迁移：users 表已补充 dept_id 列'); } catch {}

// ---------- 幂等插入工具 ----------
function upsertConfig(domain, name, data, enabled = 1) {
  const ex = db.prepare('SELECT id FROM config_items WHERE domain=? AND name=?').get(domain, name);
  if (ex) return 0;
  db.prepare('INSERT INTO config_items(domain, name, enabled, sort, data, updated_at) VALUES(?,?,?,?,?,?)')
    .run(domain, name, enabled, 0, JSON.stringify(data), now);
  return 1;
}
let added = 0;

// ---------- 沟通配置九大域（对照 evidence 原版截图逐条） ----------
// 违规检测（原版 5 条完整定义，含非违规判定说明）
const VIOLATIONS = [
  ['诱导签约抢单', '设计师通过声称同事报价过高、自身可提供更低价格，或以"搭钱""赔钱签"等话术贬低同事，诱导客户退掉已与其他设计师签订的合同，转向与自己签约。典型话术如："这我和某某某都是搭钱给你的优惠，我们那个不要提点了，都是erating。""某某某设计师给你做的价格，我能在给你优惠XX元，你把那个合同退了。"以及基于相同意图的其他变体表述。'],
  ['诱导私下交易', '设计师引导客户将款项直接支付给个人或非公司指定账户，以"能省点""不在公司设计费里面"等说辞，诱导客户绕过公司正规收款流程进行私下交易。典型话术如："你把钱单独转给我，不走公司账，你也能省点。""作图的绘图费用，你直接给绘图员，这个不在公司设计费里面。"以及基于相同意图的其他变体表述。'],
  ['承诺0增项', '设计师以"零增项""绝不会让你多花一分钱"等绝对化承诺，或以"这点小钱不用在意，到时候再说"等话术淡化增项风险、回避明确约定，诱导客户在未对增项情形做出合理预期的前提下签约。典型话术如："咱们零增项，绝不会让你多花一分钱。""这点小钱不用在意，到时候再说，我找监理给你免了。"以及基于相同意图的其他变体表述。'],
  ['诱导性口头承诺', '设计师通过口头承诺赠品、无偿服务、工期、售后保修等利益，声称无需写入合同，并以"信我就签""我还能坑你吗"等话术，诱导客户放弃将承诺载入正式协议、仅凭口头保证即签约。典型话术如："放心，绝对没问题，我给您保证肯定给你做到，用不着写合同上。""这事写进合同还要申请挺麻烦的，我还能坑你吗？信我就签。"以及基于相同意图的其他口头承诺变体。非违规：AI在判别时，应结合对话上下文，识别上述"诱导意图"而非仅匹配单句关键词，避免误判正常的合同解释和催促签约话术。'],
  ['诱导仓促签约', '设计师通过声称合同不可修改、劝说客户无需细看，并利用"相信我"等信任话术催促客户立即签约，诱导客户放弃审阅、在未充分了解条款的情况下仓促决定。典型话术如"这都是制式合同，没法改，相信我就赶紧签吧，不用细看"，以及基于相同意图的变体表述。非违规：AI在判别时，应结合对话上下文，识别上述"诱导意图"而非仅匹配单句关键词，避免误判正常的合同解释和催促签约话术。'],
];
for (const [name, text] of VIOLATIONS) {
  const parts = text.split(' 非违规：');
  added += upsertConfig('violations', name, {
    trigger: parts[0],
    typical: (parts[0].match(/典型话术如[：:]"([^"]+)"/) || [, ''])[1],
    exemption: parts[1] ? '非违规：' + parts[1] : '结合对话上下文识别诱导意图，正常合同解释与催签话术不判违规。',
  });
}

// 任务模型（原版 14 个任务项，按沟通环节组织）
const TASKS = [
  ['快速建立联系', ['开场破冰与问候', '了解客户是否了解过装修公司', '公司介绍和价值传递']],
  ['了解房屋基本信息', ['收集房屋硬件条件']],
  ['挖掘装修需求与痛点', ['了解客户家庭成员及生活习惯', '了解客户对装修的偏好']],
  ['识别决策链条', ['判断决策人和影响人']],
  ['了解预算与时间规划', ['了解客户装修预算', '了解客户对装修时间的规划']],
  ['方案讲解与价值塑造', ['向客户展示设计方案', '讲解设计思路与亮点']],
  ['方案调整与优化', ['记录客户对方案的反馈', '确定修改内容和修改时间']],
  ['详细报价说明', ['介绍装修报价和费用构成', '介绍施工项目和收费标准', '介绍施工独有工艺', '介绍可享受的折扣']],
  ['性价比分析', ['讲解工艺、材料的优势', '强调方案和报价的价值']],
  ['价格异议处理', ['询问客户的异议', '解答客户异议', '探寻客户预算']],
  ['对比竞品差异化', ['探寻客户对比其他竞品的信息', '弱化竞争对手的吸引力']],
  ['增值服务与保障说明', ['强化服务的附加价值']],
  ['上门量房服务', ['讲解量房流程', '现场测量并记录房屋数据', '讲解施工规范和验收标准', '讲解发展历程和特色服务']],
  ['促单逼定', ['了解客户的顾虑点', '解答客户顾虑', '推动客户当场签约', '引导客户签订合同或意向书']],
];
for (const [name, items] of TASKS) added += upsertConfig('task_models', name, { items: items.map((s, i) => `${i + 1}. ${s}`) });

// 能力模型（原版 7 项系统内置能力）
const ABILITIES = [
  ['需求挖掘能力', '1. 提出开放性问题，引导客户表达真实需求和问题。\n2. 针对性追问：基于客户回答提出进一步追问，推动话题深入。\n3. 适当总结和确认客户的需求，确保理解准确无误。'],
  ['价值传递能力', '1. 明确产品优势：会话中包含具体的产品或服务功能、特点和独特价值。\n2. 需求与产品匹配：能够将产品或服务特点直接与客户需求或痛点联系起来。\n3. 案例或数据证明：提供具体的案例或数据，支持价值主张的可信度。'],
  ['客户关系建立能力', '1. 展现对客户个性化的关注，建立与客户的共鸣和信任。\n2. 关注客户的反馈和需求，表现出真诚的关心和支持。\n3. 通过共同的兴趣点或话题建立关系信任。'],
  ['异议处理能力', '1. 积极回应异议：对客户提出的异议给予具体回应，避免忽略。\n2. 提供数据支持：回应中使用具体数据或事实支持自己的观点。\n3. 总结和确认客户的满意度，确保异议得到有效处理。'],
  ['谈判与说服能力', '1. 灵活调整策略：根据客户反应，及时调整提议或让步方案。\n2. 强调合作双赢：在谈判过程中，注重客户的利益，寻求双方都能接受的解决方案。\n3. 在对话中使用有效的说服技巧，如展示案例、引用数字和证据。'],
  ['情绪管理能力', '保持专业态度与情绪稳定，面对客户质疑或压力时以解决方案为导向回应。'],
  ['问题解决能力', '针对客户提出的问题给出可执行的解决方案，并明确跟进责任人与时间。'],
];
for (const [name, behavior] of ABILITIES) added += upsertConfig('ability_models', name, { behavior });

// 信息收集（原版 4 字段，含完整采集问句）
const INFO_FIELDS = [
  ['房屋概况', '了解客户房屋的基本信息,包括面积、户型、房龄、楼层等,为方案设计提供基础数据', ['您的房屋建筑面积是多少?几室几厅?', '房屋是哪一年建成的?是否有过装修历史?', '房屋朝向和采光情况如何?']],
  ['居住痛点', '挖掘客户当前居住环境中的不满意之处和改善需求,找到装修的核心驱动力', ['目前居住环境中,您最不满意的地方是什么?', '这次装修最想解决哪些问题?', '您希望新家带来哪些生活上的改变?']],
  ['客户预算', '明确客户的装修总预算、支付能力和价格敏感度,确保方案在可承受范围内', ['您这次装修的总预算大概是多少?', '预算是否包含家具家电,还是仅硬装?', '如方案超出预算,您的调整空间有多大?']],
  ['工期与入住计划', '了解客户对装修工期和入住时间的预期,为项目排期提供依据', ['您期望什么时候开工?', '有没有具体的入住时间节点?']],
];
for (const [name, desc, examples] of INFO_FIELDS) added += upsertConfig('info_fields', name, { type: '文本', desc, examples });

// 成交模型（原版 2 个经典框架）
added += upsertConfig('deal_models', 'BANT', { scene: '经典资格审查框架，用于快速评估销售机会质量。', items: ['Budget：客户预算是否明确', 'Authority：沟通对象是否为决策人', 'Need：需求是否真实存在', 'Timeline：采购时间是否清晰'] });
added += upsertConfig('deal_models', 'MEDDIC', { scene: '适合大客户、复杂销售场景，强调指标量化和决策链分析', items: ['Metrics：量化指标', 'Economic Buyer：经济决策人', 'Decision Criteria：决策标准', 'Decision Process：决策流程', 'Identify Pain：识别痛点', 'Champion：内部支持者'] });

// 沟通总结模板（原版按环节）
added += upsertConfig('summary_templates', '上门量房总结', { fields: ['房屋概况', '居住痛点', '客户预算', '量房结论'] });
added += upsertConfig('summary_templates', '方案反馈总结', { fields: ['方案讲解要点', '客户反馈', '调整事项', '下一步安排'] });

// 沟通分析维度（系统内置，data.key 对齐分析引擎）
const DIMS = [['全文摘要', 'summary', '结论先行摘要与关键信息'], ['客户立场', 'stance', '认同点/顾虑点/未提及三维'], ['竞品情况', 'competitors', '竞品提及与应对建议'], ['意向度评估', 'intention', '成交模型打分'], ['任务达成', 'tasks', '对照任务模型逐项判定'], ['违规检测', 'violations', '违规语义判活']];
for (const [name, key, desc] of DIMS) added += upsertConfig('analysis_dims', name, { key, builtin: true, desc });

// 沟通流程（原版环节命名）
added += upsertConfig('flows', '通用流程', { steps: ['初次接待', '需求沟通', '方案与报价', '促成签约'] });
added += upsertConfig('flows', '家装全流程', { steps: ['走馆带展', '上门量房', '报价谈判', '方案沟通与报价谈判'] });

// 竞争对手（中性演示词典，客户提及时自动识别）
added += upsertConfig('competitors', '同城竞品·甲装饰', { products: ['整装套餐', '局改'], notes: '价格偏低但增项多，工期把控弱；我方优势在透明报价与自有监理体系。' });
added += upsertConfig('competitors', '互联网家装平台', { products: ['线上整包'], notes: '获客强、交付外包；我方优势在自有施工团队与售后响应。' });
added += upsertConfig('competitors', '独立设计工作室', { products: ['纯设计'], notes: '设计能力强但不落地施工；我方优势在设计施工一体化与质保。' });

// 知识库（原版 5 类目，含专题描述）
const KB = [
  ['客户问答与异议处理', '包含客户常见问题标准答案、各类异议（如价格太高、考虑竞品）的应对话术、谈判技巧及沟通模板。'],
  ['竞争分析与应对策略', '主要竞争对手的详细分析、我方产品的对比优劣势、差异化竞争策略，以及面对客户比较时的标准应对话术。'],
  ['商务政策与价格体系', '内部参考资料，包含产品定价、折扣审批权限、促销政策、标准合同条款及商务流程。用于支撑销售进行报价与合同谈判。'],
  ['解决方案与客户案例', '针对不同行业/客户场景的完整解决方案，以及已成交客户的真实案例与最佳实践。'],
  ['产品价值与核心卖点', '阐述产品能解决客户的什么问题，包含核心功能、产品参数、技术优势、应用场景。'],
];
for (const [name, content] of KB) added += upsertConfig('knowledge_base', name, { content });

// 案例库（原版 2 案例）
added += upsertConfig('case_library', '家装客户考察期精准转化案例', { scenario: '家装 / ToC / 大包模式 / 期房客户', script: '针对期房考察阶段客户，销售通过深度解析大包模式灵活性、品牌自由度及价格优势，结合客户对环保、预算和风格的关切，成功建立专业信任，推动客户进入签约前准备阶段。' });
added += upsertConfig('case_library', '金地艺境二期：精准把握装修需求促成签约', { scenario: '家装 / ToC / 改善型住房', script: '客户为改善型购房，关注收纳与全屋配色。销售在量房阶段逐项记录需求，方案阶段以收纳系统与全屋灯光设计打动客户，并在报价环节主动拆分必选项与可选项，两周内促成签约。' });

// 风险预警（关键词规则，对标原版事件型预警）
added += upsertConfig('risk_rules', '私下交易引导', { keywords: ['私下', '不走公司账', '直接转给我'], level: 'high' });
added += upsertConfig('risk_rules', '绝对化承诺', { keywords: ['零增项', '绝不会多花', '保证最低价'], level: 'high' });
added += upsertConfig('risk_rules', '贬低同行', { keywords: ['他们不行', '别家都是坑', '都是外包的'], level: 'mid' });

// 洞察分类（原版 10 项）
const INSIGHTS = ['品牌信任', '专业信任', '客户体验', '设计方案', '商务报价', '服务支持', '产品价值', '场景契合', '创新前瞻', '商业模式'];
for (const n of INSIGHTS) added += upsertConfig('insight_categories', n, { desc: `客户在「${n}」维度的关注与反馈，用于洞察分析聚类。` });

// ---------- 客户 / 部门 / 员工 ----------
const CUSTS = [
  ['南京锐驰租赁', '139****2201', '租赁服务', '楼层高采光好；二孩家庭；关注环保材料', '预算敏感，关注增项'],
  ['合肥远行商贸', '138****7736', '商贸办公', '办公室翻新；决策链长，行政负责人主导', '重工期，要求假期施工'],
  ['宁波海丰物流', '137****5219', '物流仓储', '新建办公楼整装；对比过两家竞品', '倾向大包模式，预算充足'],
];
let depts = db.prepare('SELECT * FROM depts').all();
if (!depts.length) {
  const hq = db.prepare('INSERT INTO depts(name, parent_id, leader) VALUES(?,?,?)').run('总部', null, '管理员');
  const east = db.prepare('INSERT INTO depts(name, parent_id, leader) VALUES(?,?,?)').run('华东区域', hq.lastInsertRowid, '');
  db.prepare('INSERT INTO depts(name, parent_id, leader) VALUES(?,?,?)').run('华东一部', east.lastInsertRowid, '李明');
  added += 3; depts = db.prepare('SELECT * FROM depts').all();
}
const dept1 = depts.find(d => d.name === '华东一部') || depts[0];
for (const [name, phone, industry, profile, note] of CUSTS) {
  const ex = db.prepare('SELECT id FROM customers WHERE name=?').get(name);
  if (ex) continue;
  const daysAgo = 3 + Math.floor(Math.random() * 10);
  db.prepare('INSERT INTO customers(name, phone, industry, profile, owner, note, created_at, last_comm_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(name, phone, industry, JSON.stringify({ 家庭结构: '三口之家', 装修房型: '三室两厅' }), '李明', note,
      new Date(Date.now() - daysAgo * 86400e3).toISOString(), new Date(Date.now() - daysAgo * 86400e3).toISOString());
  added++;
}
for (const [name, dept] of [['李明', '华东一部'], ['王芳', '华东一部']]) {
  const ex = db.prepare('SELECT id FROM users WHERE name=?').get(name);
  if (ex) continue;
  const crypto = require('crypto');
  const salt = crypto.randomBytes(12).toString('hex');
  const hash = crypto.scryptSync('sales123', salt, 32).toString('hex');
  const d = depts.find(x => x.name === dept);
  db.prepare('INSERT INTO users(name, pass_hash, salt, role, dept_id, active, created_at) VALUES(?,?,?,?,?,1,?)')
    .run(name, hash, salt, 'sales', d ? d.id : null, now);
  added++;
}

// ---------- 一条完整演示沟通（全字段报告，验证详情页排版） ----------
const hasDemo = db.prepare("SELECT id FROM communications WHERE topic LIKE '%量房方案沟通%'").get();
if (!hasDemo) {
  const transcript = [
    '销售: 王哥您好，上次量房之后方案我们连夜调整了，今天把效果图和报价一起给您过一遍。',
    '客户: 好的，我先看看方案。上次说的收纳问题你们加进去了吗？',
    '销售: 加了，玄关做了整墙顶天立地柜，厨房用了抽拉式五金，这两块是收纳重点。我们用的板材是ENF级的，环保您完全放心。',
    '客户: 环保这块我确实最在意，家里有孩子。那价格呢，我预算就想控制在25万以内。',
    '客户: 对了我邻居选的是甲装饰，他们说26万全包还送家电，你们这边要贵一些。',
    '销售: 您可以对比一下增项，很多低价套餐后期水电改造、瓷砖升级都要另外加钱，我们报价是闭口合同，零增项写进合同里。家电我们也有合作活动，我给您申请。',
    '客户: 零增项真能保证？我在网上看到好多被增项坑的。',
    '销售: 这个您放心，绝对没问题，肯定给您控制住，超出的部分我们承担。',
    '客户: 行吧。工期呢？我们想九月之前住进去。',
    '销售: 正常工期90天，您这个面积我们排旺季之前开工完全来得及，签完合同一周内进场。',
    '客户: 那合同我再看看，跟家里人商量一下，这周内给您答复。',
    '销售: 好的王哥，今天定的话我额外送您全屋开关面板升级，这个名额这个月就三个了。',
  ].join('\n');
  const report = {
    summary: '本次为量房后的方案讲解与报价谈判。客户对收纳设计与环保等级表示认可，预算锚点25万，提及同城竞品低价套餐形成比价压力。销售以闭口合同零增项回应比价，并给出"绝对没问题，肯定给您控制住"的口头承诺（命中诱导性口头承诺风险）。客户进入犹豫期，表示需与家人商量，销售以限时赠品促单，暂未成交。',
    key_facts: [
      { k: '客户预算', v: '25万以内（含软硬装）' },
      { k: '核心关注', v: '环保等级（家有小童）、收纳设计' },
      { k: '竞品参照', v: '邻居选择甲装饰 26万全包送家电' },
      { k: '工期要求', v: '当月签约、九月前入住，工期90天可满足' },
      { k: '决策模式', v: '需与家人商量后答复' },
    ],
    stance: {
      support: ['认可ENF级环保板材与收纳设计方案', '明确预算25万以内并进入报价对比阶段', '对零增项写进合同表示"这个好"'],
      concerns: ['比价心理：邻居甲装饰26万全包还送家电', '担心网上曝光的增项陷阱', '决策需与家人商量，本周才答复'],
      unmentioned: ['付款方式与分期', '售后保修具体条款', '设计师具体人选'],
    },
    competitors: [
      { name: '同城竞品·甲装饰', mentions: 1, our_advantage: '闭口合同零增项写入合同，竞品低价套餐后期增项多', risk: '低价+送家电的组合对价格敏感客户吸引力大' },
    ],
    intention: { score: 68, level: '中', reasons: ['已进入方案报价对比阶段，预算与需求明确', '存在比价压力与家人决策因素', '现场未拒绝赠品促单，留有转化空间'] },
    tasks: [
      { item: '挖掘装修需求与痛点', status: '完成', evidence: '客户明确环保（家有孩子）与收纳为两大核心诉求' },
      { item: '了解预算与时间规划', status: '完成', evidence: '预算控制在25万以内；九月之前入住' },
      { item: '详细报价说明', status: '不充分', evidence: '仅强调闭口合同，未逐项介绍费用构成与收费标准' },
      { item: '对比竞品差异化', status: '完成', evidence: '以零增项写进合同回应竞品低价套餐' },
      { item: '促单逼定', status: '完成', evidence: '以限时赠品推动当场决策，客户表示本周答复' },
    ],
    violations: [
      { item: '诱导性口头承诺', evidence: '销售："这个您放心，绝对没问题，肯定给您控制住，超出的部分我们承担。"——零增项未落合同仅口头保证', severity: '高' },
    ],
    todos: [
      { what: '跟进家人商量结果，本周内二次触达', due: null },
      { what: '将零增项条款写入合同并出具书面承诺', due: '签约前' },
      { what: '确认全屋开关面板升级赠品名额', due: '本周' },
    ],
  };
  const cust = db.prepare("SELECT id FROM customers WHERE name='南京锐驰租赁'").get();
  const demoRow = hasDemo;
  db.prepare('INSERT INTO communications(created_at, duration_s, audio_path, transcript, status, owner, topic, customer_id, report, meta) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(new Date(Date.now() - 2 * 86400e3).toISOString(), 18 * 60, '', transcript, 'analyzed', '李明',
      '王哥 户型方案沟通与报价谈判（演示）', cust ? cust.id : null, JSON.stringify(report), JSON.stringify({ alerts: [{ keyword: '绝对没问题', rule: '诱导性口头承诺' }] }));
  added++;
}
// 兼容：旧版 seed 漏写 report 的演示记录，补齐报告
{
  const demo = db.prepare("SELECT id FROM communications WHERE topic LIKE '%演示%' AND (report IS NULL OR report='')").get();
  if (demo) {
    console.log(`补写演示沟通 #${demo.id} 的报告…`);
  }
}

console.log(`演示数据填充完成：新增 ${added} 条。`);
console.log('  配置域14类（违规检测5/任务14/能力7/信息收集4/成交模型2/总结模板2/分析维度6/流程2/竞品3/知识库5/案例2/风险3/洞察10）');
console.log('  客户3 · 部门3 · 员工2（李明/王芳，密码 sales123） · 完整演示沟通1条');
