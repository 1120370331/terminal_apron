export const DEVELOPMENT_TASK_TAGS = ["缺陷修复", "新功能", "性能优化", "界面优化", "重构", "测试", "文档", "构建部署", "技术债", "安全", "前端", "后端", "API", "数据库", "依赖升级", "待验收"];
export interface TaskTagMutation { add?: string[]; remove?: string[]; tags?: string[]; revision?: number }
