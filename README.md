# 城市地下综合管廊运行维护管理平台

面向管廊主体台账、入廊管线登记、廊内环境监测、通风排水消防、结构沉降与渗漏处置、巡检检修与隐患整改、入廊作业审批和运维值班的一体化城市地下综合管廊运行维护管理工作台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 管廊主体台账 | `tunnel` | 综合管廊 | 管廊编号、管廊名称、所属片区 |
| 入廊管线登记 | `pipeline` | 入廊管线 | 管线编号、所属舱室、管线类型 |
| 廊内环境监测 | `envmonitor` | 环境监测记录 | 监测编号、监测点位、环境温度 |
| 通风系统运维 | `ventilation` | 通风机组 | 机组编号、所属舱室、风机型号 |
| 廊内排水运维 | `drainage` | 排水泵坑 | 泵坑编号、所属舱室、集水坑容积 |
| 消防系统运维 | `firecontrol` | 消防设施 | 设施编号、所属舱室、消防类型 |
| 廊内照明运维 | `lighting` | 照明灯具 | 灯具编号、所属舱室、灯具类型 |
| 门禁安防运维 | `access` | 安防点位 | 点位编号、所属出入口、门禁类型 |
| 廊内巡检任务 | `patrol` | 巡检任务 | 巡检编号、巡检路线、巡检班组 |
| 结构沉降监测 | `settlement` | 沉降监测点 | 监测编号、监测断面、累计沉降量 |
| 渗漏水处置 | `leak` | 渗漏处置单 | 处置编号、渗漏点位、渗漏程度 |
| 设施检修管理 | `maintenance` | 检修记录 | 检修编号、检修对象、检修类别 |
| 隐患整改管理 | `hazard` | 隐患记录 | 隐患编号、隐患部位、隐患等级 |
| 应急演练管理 | `emergency` | 应急演练 | 演练编号、演练场景、参与班组 |
| 廊内能耗计量 | `energy` | 能耗计量记录 | 计量编号、计量点位、用电量 |
| 设备台账管理 | `device` | 管廊设备 | 设备编号、设备名称、设备型号 |
| 入廊作业审批 | `entryapprove` | 作业申请 | 申请编号、申请单位、作业舱室 |
| 保洁作业单台账 | `cleaning` | 保洁作业单 | 作业单号、车次编号、保洁区域、清运量 |
| 运维值班交接 | `duty` | 值班交接记录 | 交接编号、值班班组、值班日期 |

## 保洁作业单台账（文件整批进出）

`cleaning` 模块把“群里喊、纸上记”的保洁与垃圾清运做成可整批进出的台账，全部读写走
`frontend/src/api/cleaning-service.ts`，纯规则在 `frontend/src/data/cleaning.ts`（可在 Node 下单测）。

- **文件进出**：上传只有「导入车单文件」一个口子（CSV，列：车次编号、清运日期、保洁区域、保洁班组、清运量，
  可先下载模板）；下载分「导出台账 / 下载月底归总 / 下载交接清单」。进出都走文件。
- **逐行核对**：车次编号、日期格式、区域、班组、清运量任一缺失或不对，该行**不进账**，在「退行坏行」表里
  另起一行写清缘由；其余按清运日期照常入账。
- **同车次覆盖**：车次编号是业务主键，重复导入不叠加，按车次整笔覆盖旧版。
- **冲突仲裁**：权威等级「监管核定 ＞ 车单导入 ＞ 纸质补录」，同源再比导入批次时间、新者胜。依据是监管核定为
  线下核对终局结论、电子车单为当场原始凭据、纸质补录仅为回溯估计；故车单不能反向推翻已核定单据（拦退后写入坏行表）。
- **巡检核对**：清运量（车）与同区域当日巡检「发现问题数」相差 ≤1 为一致；明显不一致或当日无巡检可比，
  挂**待核**，由监管员在「廊内巡检任务」页核定（一致入账 / 不符作废）。待核、作废不进月底归总。
- **月底另存**：按保洁区域汇总作业单数与清运量；页面表格与下载文件、另存记录取同一个 `summarizeMonth`，是一回事。
- **口径版本（只对新记录生效）**：`纸质版(2023年以前)` 一车一记、残缺补 1 车、不参与核对；`2024版(2024-2025)`
  容差 1 车；`2026版(现行)` 缺量即退行。存量按**完工日期回填一次**，残缺按当年那版补齐，既有记录保留原判不改判。
- **并发**：提交走不可重入锁，同一时刻两笔只让先到的整笔入账，后到的整笔回退、零写入。
- **单一数据源**：台账、退行表、交接清单、月底另存都在同一个 localStorage（键
  `urban-utility-tunnel:entries` 下的 `cleaning / cleaningReject / cleaningHandover / cleaningArchive`），
  同事务更新；保洁页与「运维值班交接」页的交接清单读的是同一份。

保洁领域规则测试（不依赖浏览器）：

```bash
cd frontend
npx esbuild scripts/test-cleaning.mjs        --bundle --platform=node --format=esm --outfile=/tmp/t1.mjs && node /tmp/t1.mjs
npx esbuild scripts/test-cleaning-service.mjs --bundle --platform=node --format=esm --outfile=/tmp/t2.mjs && node /tmp/t2.mjs
```

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `urban-utility-tunnel:entries` 这一项，或调用 `resetModule(模块)`。
