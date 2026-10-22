# MEA Cowork 企业版贡献指南

感谢你参与 MEA Cowork 企业版的开发。提交代码前，请先阅读 [行为准则](CODE_OF_CONDUCT.md)、[许可证](LICENSE) 和 [开发指南](docs/contrib/development.md)。

## 提交代码

1. 创建用于本次改动的分支。
2. 只修改与任务直接相关的文件。
3. 为行为变化补充有价值的测试。
4. 提交前运行相关测试和 `pnpm lint`。
5. 使用清晰的 Conventional Commit 提交信息，并附带 DCO 签名。

示例：

```text
fix(knowledge): 修复知识库文件上传
Signed-off-by: Your Name <your.email@example.com>
```

## 代码审查

提交 Pull Request 时，请说明问题、改动范围、验证方式和已知限制。涉及用户可见文案、品牌、安装包身份、数据目录或外部协议的改动，需要同时说明兼容性影响。

## 测试

功能改动必须覆盖相关的单元测试或集成测试。常用检查命令：

```bash
pnpm lint
pnpm test
```

如果只修改单个模块，请优先运行该模块对应的定向测试，避免无关的大范围改动。

## 品牌与兼容性

用户可见的产品名称使用“MEA Cowork 企业版”。旧版数据目录、迁移标识、外部 API 协议和上游兼容字段属于稳定契约，修改前请先确认迁移和兼容性方案。
