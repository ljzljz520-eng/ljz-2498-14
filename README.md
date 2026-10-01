# Catalpa 编辑与预览项目

## 项目介绍
本项目基于 `Vue 3 + Vite` 实现了一个 Catalpa 文本编辑与实时预览工具。  
页面采用左右分栏布局，左侧用于输入 Catalpa 内容，右侧用于即时渲染预览，适合本地写作、语法演示和轻量文档编辑场景。

## 项目功能
- 支持 Catalpa 文本实时编辑与预览
- 支持常见语法：标题、列表、引用、分割线、粗体、斜体、链接、代码块
- 内置“恢复示例”“清空内容”快捷操作
- 显示行数和字符数统计
- 使用 `pnpm` 最新版，并配置国内镜像源（`npmmirror`）
- 支持 `Docker Compose` 一键启动开发环境

## 项目目录结构
```text
.
├── Dockerfile                 # Docker 镜像构建文件
├── docker-compose.yml         # Docker Compose 启动配置
├── .dockerignore              # Docker 构建忽略文件
├── .npmrc                     # pnpm/npm 国内镜像源配置
├── index.html                 # Vite 入口 HTML
├── package.json               # 项目依赖与脚本
├── pnpm-lock.yaml             # pnpm 锁文件
├── public/                    # 静态资源目录
├── src/
│   ├── App.vue                # 主页面（编辑区 + 预览区）
│   ├── main.js                # Vue 应用入口
│   ├── style.css              # 全局样式
│   └── utils/
│       └── catalpa.js         # Catalpa 渲染逻辑
└── vite.config.js             # Vite 配置
```

## 项目部署

### 1. 本地部署（推荐开发调试）
```bash
corepack prepare pnpm@latest --activate
pnpm install
pnpm dev
```

启动后访问：`http://localhost:3000`

### 2. Docker 部署（一键启动）
```bash
docker compose up --build
```

启动后访问：`http://localhost:3000`

### 3. 生产构建
```bash
pnpm build
```

构建产物输出到 `dist/` 目录，可部署到任意静态资源服务器（如 Nginx、CDN、对象存储静态托管）。

## 镜像源说明
项目根目录 `.npmrc` 已配置：

```ini
registry=https://registry.npmmirror.com/
```

---

## 审阅线程功能

当前版本增加文稿审阅线程演示：

- 在右侧预览选择可见文字创建批注，保存字符范围、节点范围、引文、上下文和文稿基线；
- 编辑后基于版本差异重定位，而不是只搜索同一句文本；
- 每个候选都输出来源、置信度、证据和人工确认入口；
- 选区删除、相同引文多处复制、段落重写等无法唯一确认时保留悬挂线程；
- 回复、解决、重开、重新请求审阅和锚点迁移全部使用事件流记录；
- 支持离线编辑三方合并、离线回复幂等、远端解决与本地重开冲突；
- v1 旧前端无法把已迁移批注重新锚到缓存的过期位置。

详细设计见 [`docs/review-threads-design.md`](docs/review-threads-design.md)，PostgreSQL 表结构见 [`server/review_threads.sql`](server/review_threads.sql)。

### 审阅测试

```bash
npm test
# 或
node --test test/review.test.js
```

覆盖：整段移动、引文多处相同、选区删除、离线回复合并、同时解决/重开、旧前端保护、解决后重写并重新请求审阅。
